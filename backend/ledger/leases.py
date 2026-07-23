from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from backend.ledger.models import (
    Actor,
    LaneRecord,
    LaneStatus,
    LeaseKind,
    LeaseRecord,
    LeaseStatus,
    SessionRecord,
    SessionStatus,
)

Clock = Callable[[], datetime]
IdFactory = Callable[[str], str]


class LeaseConflictError(RuntimeError):
    def __init__(self, lease: LeaseRecord) -> None:
        super().__init__(f"active lease blocks mutation: {lease.lease_id}")
        self.lease = lease
        self.error = {
            "code": "lease_conflict",
            "message": "Active mutation lease blocks this actor.",
            "lease_id": lease.lease_id,
            "agent_id": lease.actor.id,
            "lane_id": lease.lane_id,
            "session_id": lease.session_id,
            "status": lease.status.value,
        }


class LeaseNotFoundError(KeyError):
    pass


class LeasePermissionError(PermissionError):
    pass


@dataclass(frozen=True)
class LeaseClaim:
    lease: LeaseRecord
    events: list[dict]


def utc_now() -> datetime:
    return datetime.now(UTC)


def default_id_factory(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


class InMemoryLeaseStore:
    """Standalone lease/session semantics until package 01 wires persistence/API."""

    def __init__(self, clock: Clock = utc_now, id_factory: IdFactory = default_id_factory) -> None:
        self._clock = clock
        self._id_factory = id_factory
        self.lanes: dict[str, LaneRecord] = {}
        self.sessions: dict[str, SessionRecord] = {}
        self.leases: dict[str, LeaseRecord] = {}
        self.events: list[dict] = []

    def create_lane(self, lane_id: str, actor: Actor) -> LaneRecord:
        now = self._now()
        lane = self.lanes.get(lane_id)
        if lane is None:
            lane = LaneRecord(lane_id=lane_id, created_at=now, updated_at=now)
            self.lanes[lane_id] = lane
            self._record_event("lane.created", actor, lane_id=lane_id)
        else:
            lane.status = LaneStatus.ACTIVE
            lane.updated_at = now
        return lane

    def mark_lane(self, lane_id: str, status: LaneStatus, actor: Actor) -> LaneRecord:
        lane = self._require_lane(lane_id)
        lane.status = status
        lane.updated_at = self._now()
        self._record_event(f"lane.{status.value}", actor, lane_id=lane_id)
        return lane

    def create_session(
        self,
        lane_id: str,
        session_id: str,
        actor: Actor,
        parent_session_id: str | None = None,
    ) -> SessionRecord:
        now = self._now()
        self.create_lane(lane_id, actor)
        if parent_session_id is not None:
            parent = self._require_session(parent_session_id)
            if parent.lane_id != lane_id:
                raise ValueError("replacement session must stay on the same lane_id")
            parent.status = SessionStatus.REPLACED
            parent.updated_at = now
            self._invalidate_session_leases(parent_session_id, actor, "session.replaced")

        session = SessionRecord(
            session_id=session_id,
            lane_id=lane_id,
            parent_session_id=parent_session_id,
            created_at=now,
            updated_at=now,
        )
        self.sessions[session_id] = session
        lane = self._require_lane(lane_id)
        if session_id not in lane.session_ids:
            lane.session_ids.append(session_id)
        lane.status = LaneStatus.ACTIVE
        lane.updated_at = now
        self._record_event(
            "session.created",
            actor,
            lane_id=lane_id,
            session_id=session_id,
            payload={"parent_session_id": parent_session_id},
        )
        return session

    def mark_session(self, session_id: str, status: SessionStatus, actor: Actor) -> SessionRecord:
        session = self._require_session(session_id)
        session.status = status
        session.updated_at = self._now()
        self._record_event(
            f"session.{status.value}", actor, lane_id=session.lane_id, session_id=session_id
        )
        if status in {SessionStatus.FAILED, SessionStatus.REPLACED, SessionStatus.CLOSED}:
            self._invalidate_session_leases(session_id, actor, f"session.{status.value}")
        return session

    def claim_lane_lease(self, lane_id: str, actor: Actor, ttl_seconds: int = 60) -> LeaseClaim:
        self.create_lane(lane_id, actor)
        return self._claim(LeaseKind.LANE, actor, ttl_seconds, lane_id=lane_id)

    def claim_session_mutation_lease(
        self,
        lane_id: str,
        session_id: str,
        actor: Actor,
        ttl_seconds: int = 60,
    ) -> LeaseClaim:
        if session_id not in self.sessions:
            self.create_session(lane_id, session_id, actor)
        else:
            session = self._require_session(session_id)
            if session.lane_id != lane_id:
                raise ValueError("session_id belongs to a different lane_id")
        return self._claim(
            LeaseKind.SESSION_MUTATION, actor, ttl_seconds, lane_id=lane_id, session_id=session_id
        )

    def heartbeat(self, lease_id: str, actor: Actor) -> dict:
        lease = self._require_lease(lease_id)
        now = self._now()
        if lease.status != LeaseStatus.ACTIVE:
            raise LeasePermissionError(f"lease is not active: {lease.status.value}")
        if lease.is_stale_at(now):
            self.expire(lease_id, actor)
            raise LeasePermissionError("lease has expired")
        self._require_owner_or_human(lease, actor)
        lease.heartbeat_at = now
        lease.updated_at = now
        return self._record_event_for_lease("lease.heartbeat", lease, actor)

    def release(self, lease_id: str, actor: Actor) -> dict:
        lease = self._require_lease(lease_id)
        self._require_owner_or_human(lease, actor)
        now = self._now()
        lease.status = LeaseStatus.RELEASED
        lease.released_at = now
        lease.updated_at = now
        return self._record_event_for_lease("lease.released", lease, actor)

    def get_lease(self, lease_id: str) -> LeaseRecord:
        """Return a lease regardless of status for crash recovery checks."""
        return self._require_lease(lease_id)

    def expire(self, lease_id: str, actor: Actor | None = None) -> dict:
        lease = self._require_lease(lease_id)
        if lease.status != LeaseStatus.ACTIVE:
            return self._record_event_for_lease("lease.expire_checked", lease, actor or lease.actor)
        now = self._now()
        lease.status = LeaseStatus.EXPIRED
        lease.expired_at = now
        lease.updated_at = now
        return self._record_event_for_lease("lease.expired", lease, actor or lease.actor)

    def expire_stale(self, actor: Actor | None = None) -> list[dict]:
        now = self._now()
        events = []
        for lease in list(self.leases.values()):
            if lease.status == LeaseStatus.ACTIVE and lease.is_stale_at(now):
                events.append(self.expire(lease.lease_id, actor))
        return events

    def transfer(self, lease_id: str, actor: Actor, target_actor: Actor) -> LeaseRecord:
        lease = self._require_lease(lease_id)
        self._require_owner_or_human(lease, actor)
        now = self._now()
        previous_actor = lease.actor
        lease.actor = target_actor
        lease.transferred_at = now
        lease.transferred_to_agent_id = target_actor.id
        lease.heartbeat_at = now
        lease.updated_at = now
        self._record_event_for_lease(
            "lease.transferred",
            lease,
            actor,
            payload={"from_agent_id": previous_actor.id, "to_agent_id": target_actor.id},
        )
        return lease

    def interrupt_by_human(
        self,
        human_actor: Actor,
        lease_id: str | None = None,
        session_id: str | None = None,
        reason: str | None = None,
    ) -> list[dict]:
        if not human_actor.is_human:
            raise LeasePermissionError("human override requires actor.type='human'")
        leases = self._matching_active_leases_for_interrupt(lease_id, session_id)
        events = []
        now = self._now()
        for lease in leases:
            lease.status = LeaseStatus.INTERRUPTED_BY_HUMAN
            lease.interrupted_at = now
            lease.interrupt_actor = human_actor
            lease.interrupt_reason = reason
            lease.updated_at = now
            events.append(
                self._record_event_for_lease(
                    "lease.interrupted_by_human",
                    lease,
                    human_actor,
                    payload={"reason": reason, "interrupted_agent_id": lease.actor.id},
                )
            )
        return events

    def require_mutation_lease(
        self, session_id: str, actor: Actor, lease_id: str | None = None
    ) -> LeaseRecord | None:
        if actor.is_human:
            active = self._active_lease_for(LeaseKind.SESSION_MUTATION, session_id=session_id)
            if active is not None:
                self.interrupt_by_human(
                    actor, lease_id=active.lease_id, reason="human override mutation"
                )
            return None

        lease = (
            self._require_lease(lease_id)
            if lease_id
            else self._active_lease_for(
                LeaseKind.SESSION_MUTATION,
                session_id=session_id,
            )
        )
        if lease is None or lease.status != LeaseStatus.ACTIVE:
            raise LeasePermissionError("mutation requires active session lease")
        if lease.session_id != session_id:
            raise LeasePermissionError("lease does not cover session")
        if lease.actor.id != actor.id:
            raise LeaseConflictError(lease)
        if lease.is_stale_at(self._now()):
            self.expire(lease.lease_id, actor)
            raise LeasePermissionError("mutation lease expired")
        return lease

    def append_readonly_event(
        self,
        event_type: str,
        actor: Actor,
        lane_id: str | None = None,
        session_id: str | None = None,
        payload: dict | None = None,
    ) -> dict:
        return self._record_event(
            event_type, actor, lane_id=lane_id, session_id=session_id, payload=payload
        )

    def _claim(
        self,
        kind: LeaseKind,
        actor: Actor,
        ttl_seconds: int,
        lane_id: str | None = None,
        session_id: str | None = None,
    ) -> LeaseClaim:
        events = [
            self._record_event("lease.requested", actor, lane_id=lane_id, session_id=session_id)
        ]
        active = self._active_lease_for(kind, lane_id=lane_id, session_id=session_id)
        if active is not None:
            if active.is_stale_at(self._now()):
                events.append(self.expire(active.lease_id, actor))
            else:
                events.append(
                    self._record_event_for_lease(
                        "lease.blocked",
                        active,
                        actor,
                        payload={"blocking_agent_id": active.actor.id},
                    )
                )
                raise LeaseConflictError(active)

        now = self._now()
        lease = LeaseRecord(
            lease_id=self._id_factory("lease"),
            kind=kind,
            actor=actor,
            lane_id=lane_id,
            session_id=session_id,
            ttl_seconds=ttl_seconds,
            created_at=now,
            heartbeat_at=now,
            updated_at=now,
        )
        self.leases[lease.lease_id] = lease
        events.append(self._record_event_for_lease("lease.granted", lease, actor))
        return LeaseClaim(lease=lease, events=events)

    def _active_lease_for(
        self,
        kind: LeaseKind,
        lane_id: str | None = None,
        session_id: str | None = None,
    ) -> LeaseRecord | None:
        for lease in self.leases.values():
            if lease.kind != kind or lease.status != LeaseStatus.ACTIVE:
                continue
            if lane_id is not None and lease.lane_id != lane_id:
                continue
            if session_id is not None and lease.session_id != session_id:
                continue
            return lease
        return None

    def _invalidate_session_leases(self, session_id: str, actor: Actor, reason: str) -> None:
        for lease in list(self.leases.values()):
            if (
                lease.kind == LeaseKind.SESSION_MUTATION
                and lease.session_id == session_id
                and lease.status == LeaseStatus.ACTIVE
            ):
                now = self._now()
                lease.status = LeaseStatus.RELEASED
                lease.released_at = now
                lease.updated_at = now
                self._record_event_for_lease(
                    "lease.released", lease, actor, payload={"reason": reason}
                )

    def _matching_active_leases_for_interrupt(
        self,
        lease_id: str | None,
        session_id: str | None,
    ) -> list[LeaseRecord]:
        if lease_id is not None:
            lease = self._require_lease(lease_id)
            return [lease] if lease.status == LeaseStatus.ACTIVE else []
        if session_id is None:
            raise ValueError("interrupt_by_human requires lease_id or session_id")
        return [
            lease
            for lease in self.leases.values()
            if lease.status == LeaseStatus.ACTIVE and lease.session_id == session_id
        ]

    def _record_event_for_lease(
        self,
        event_type: str,
        lease: LeaseRecord,
        actor: Actor,
        payload: dict | None = None,
    ) -> dict:
        base_payload = {
            "lease_kind": lease.kind.value,
            "lease_status": lease.status.value,
            "owner_agent_id": lease.actor.id,
        }
        if payload:
            base_payload.update(payload)
        return self._record_event(
            event_type,
            actor,
            lane_id=lease.lane_id,
            session_id=lease.session_id,
            lease_id=lease.lease_id,
            payload=base_payload,
        )

    def _record_event(
        self,
        event_type: str,
        actor: Actor,
        lane_id: str | None = None,
        session_id: str | None = None,
        lease_id: str | None = None,
        payload: dict | None = None,
    ) -> dict:
        event = {
            "event_id": self._id_factory("evt"),
            "seq": len(self.events) + 1,
            "ts": self._now().isoformat().replace("+00:00", "Z"),
            "component": "c3",
            "event_type": event_type,
            "actor": actor.as_event_actor(),
            "agent_id": actor.id if actor.type == "agent" else "",
            "lane_id": lane_id or "",
            "session_id": session_id or "",
            "lease_id": lease_id or "",
            "command_id": "",
            "trace_id": "",
            "payload": payload or {},
            "redaction": {"applied": True, "rules": []},
            "prev_hash": "",
            "hash": "",
        }
        self.events.append(event)
        return event

    def _require_owner_or_human(self, lease: LeaseRecord, actor: Actor) -> None:
        if actor.is_human or lease.actor.id == actor.id:
            return
        raise LeaseConflictError(lease)

    def _require_lane(self, lane_id: str) -> LaneRecord:
        if lane_id not in self.lanes:
            raise KeyError(f"unknown lane: {lane_id}")
        return self.lanes[lane_id]

    def _require_session(self, session_id: str) -> SessionRecord:
        if session_id not in self.sessions:
            raise KeyError(f"unknown session: {session_id}")
        return self.sessions[session_id]

    def _require_lease(self, lease_id: str) -> LeaseRecord:
        if lease_id not in self.leases:
            raise LeaseNotFoundError(lease_id)
        return self.leases[lease_id]

    def _now(self) -> datetime:
        now = self._clock()
        if now.tzinfo is None:
            return now.replace(tzinfo=UTC)
        return now.astimezone(UTC)
