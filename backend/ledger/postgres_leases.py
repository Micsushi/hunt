from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

from backend.ledger.leases import (
    Clock,
    IdFactory,
    LeaseClaim,
    LeaseConflictError,
    LeaseNotFoundError,
    LeasePermissionError,
    default_id_factory,
    utc_now,
)
from backend.ledger.models import Actor, LeaseKind, LeaseRecord, LeaseStatus


class PostgresLeaseStore:
    """Durable lease control state stored in the rebuildable Postgres index DB.

    JSONL remains the immutable ledger. This store only owns current lease state
    and mirrors the in-memory lease API used by the HTTP routes.
    """

    def __init__(
        self,
        connection: Any,
        clock: Clock = utc_now,
        id_factory: IdFactory = default_id_factory,
    ) -> None:
        self.connection = connection
        self._clock = clock
        self._id_factory = id_factory
        self._placeholder = "?" if _is_sqlite_connection(connection) else "%s"
        self._is_sqlite = self._placeholder == "?"
        self.events: list[dict] = []

    @classmethod
    def connect(cls, db_url: str) -> PostgresLeaseStore:
        import psycopg2

        return cls(psycopg2.connect(db_url))

    @property
    def leases(self) -> dict[str, LeaseRecord]:
        return {lease.lease_id: lease for lease in self.active_leases()}

    def active_leases(self) -> list[LeaseRecord]:
        rows = self._fetch_all(
            """
            SELECT lease_id, lease_type, status, agent_id, lane_id, session_id,
                   claimed_at, heartbeat_at, expires_at, released_at, metadata_json
            FROM ledger_leases
            WHERE status = %s
            ORDER BY expires_at
            """,
            [LeaseStatus.ACTIVE.value],
        )
        return [self._record_from_row(row) for row in rows]

    def claim_lane_lease(self, lane_id: str, actor: Actor, ttl_seconds: int = 60) -> LeaseClaim:
        return self._claim(LeaseKind.LANE, actor, ttl_seconds, lane_id=lane_id)

    def claim_session_mutation_lease(
        self,
        lane_id: str,
        session_id: str,
        actor: Actor,
        ttl_seconds: int = 60,
    ) -> LeaseClaim:
        return self._claim(
            LeaseKind.SESSION_MUTATION,
            actor,
            ttl_seconds,
            lane_id=lane_id,
            session_id=session_id,
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
        self._update_lease(lease)
        return self._record_event_for_lease("lease.heartbeat", lease, actor)

    def release(self, lease_id: str, actor: Actor) -> dict:
        lease = self._require_lease(lease_id)
        self._require_owner_or_human(lease, actor)
        now = self._now()
        lease.status = LeaseStatus.RELEASED
        lease.released_at = now
        lease.updated_at = now
        self._update_lease(lease)
        return self._record_event_for_lease("lease.released", lease, actor)

    def expire(self, lease_id: str, actor: Actor | None = None) -> dict:
        lease = self._require_lease(lease_id)
        if lease.status != LeaseStatus.ACTIVE:
            return self._record_event_for_lease("lease.expire_checked", lease, actor or lease.actor)
        now = self._now()
        lease.status = LeaseStatus.EXPIRED
        lease.expired_at = now
        lease.updated_at = now
        self._update_lease(lease)
        return self._record_event_for_lease("lease.expired", lease, actor or lease.actor)

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
        self._ensure_references(lease, target_actor)
        self._update_lease(lease)
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
            self._update_lease(lease)
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
        self,
        session_id: str,
        actor: Actor,
        lease_id: str | None = None,
    ) -> LeaseRecord | None:
        if actor.is_human:
            active = self._active_lease_for(LeaseKind.SESSION_MUTATION, session_id=session_id)
            if active is not None:
                self.interrupt_by_human(actor, lease_id=active.lease_id, reason="human override mutation")
            return None

        lease = (
            self._require_lease(lease_id)
            if lease_id
            else self._active_lease_for(LeaseKind.SESSION_MUTATION, session_id=session_id)
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

    def _claim(
        self,
        kind: LeaseKind,
        actor: Actor,
        ttl_seconds: int,
        lane_id: str | None = None,
        session_id: str | None = None,
    ) -> LeaseClaim:
        events = [self._record_event("lease.requested", actor, lane_id=lane_id, session_id=session_id)]
        self._begin_claim_transaction()
        try:
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
            self._ensure_references(lease, actor)
            self._insert_lease(lease)
            events.append(self._record_event_for_lease("lease.granted", lease, actor))
            _commit_if_available(self.connection)
            return LeaseClaim(lease=lease, events=events)
        except Exception:
            _rollback_if_available(self.connection)
            raise

    def _begin_claim_transaction(self) -> None:
        if self._is_sqlite:
            self._execute("BEGIN IMMEDIATE")
            return
        self._execute("LOCK TABLE ledger_leases IN SHARE ROW EXCLUSIVE MODE")

    def _active_lease_for(
        self,
        kind: LeaseKind,
        lane_id: str | None = None,
        session_id: str | None = None,
    ) -> LeaseRecord | None:
        clauses = ["lease_type = %s", "status = %s"]
        params: list[Any] = [kind.value, LeaseStatus.ACTIVE.value]
        if lane_id is not None:
            clauses.append("lane_id = %s")
            params.append(lane_id)
        if session_id is not None:
            clauses.append("session_id = %s")
            params.append(session_id)
        row = self._fetch_one(
            f"""
            SELECT lease_id, lease_type, status, agent_id, lane_id, session_id,
                   claimed_at, heartbeat_at, expires_at, released_at, metadata_json
            FROM ledger_leases
            WHERE {" AND ".join(clauses)}
            ORDER BY claimed_at
            LIMIT 1
            """,
            params,
        )
        return self._record_from_row(row) if row is not None else None

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
        rows = self._fetch_all(
            """
            SELECT lease_id, lease_type, status, agent_id, lane_id, session_id,
                   claimed_at, heartbeat_at, expires_at, released_at, metadata_json
            FROM ledger_leases
            WHERE status = %s AND session_id = %s
            ORDER BY claimed_at
            """,
            [LeaseStatus.ACTIVE.value, session_id],
        )
        return [self._record_from_row(row) for row in rows]

    def _require_lease(self, lease_id: str) -> LeaseRecord:
        row = self._fetch_one(
            """
            SELECT lease_id, lease_type, status, agent_id, lane_id, session_id,
                   claimed_at, heartbeat_at, expires_at, released_at, metadata_json
            FROM ledger_leases
            WHERE lease_id = %s
            """,
            [lease_id],
        )
        if row is None:
            raise LeaseNotFoundError(lease_id)
        return self._record_from_row(row)

    def _insert_lease(self, lease: LeaseRecord) -> None:
        self._execute(
            """
            INSERT INTO ledger_leases (
                lease_id, component, lease_type, status, agent_id, lane_id,
                session_id, claimed_at, heartbeat_at, expires_at, released_at,
                metadata_json
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                lease.lease_id,
                "c3",
                lease.kind.value,
                lease.status.value,
                lease.actor.id if lease.actor.type == "agent" else None,
                lease.lane_id,
                lease.session_id,
                _format_dt(lease.created_at),
                _format_dt(lease.heartbeat_at),
                _format_dt(lease.heartbeat_at + timedelta(seconds=lease.ttl_seconds)),
                _format_dt(lease.released_at),
                self._metadata_json(lease),
            ],
        )

    def _update_lease(self, lease: LeaseRecord) -> None:
        self._execute(
            """
            UPDATE ledger_leases
            SET status = %s,
                agent_id = %s,
                heartbeat_at = %s,
                expires_at = %s,
                released_at = %s,
                metadata_json = %s
            WHERE lease_id = %s
            """,
            [
                lease.status.value,
                lease.actor.id if lease.actor.type == "agent" else None,
                _format_dt(lease.heartbeat_at),
                _format_dt(lease.heartbeat_at + timedelta(seconds=lease.ttl_seconds)),
                _format_dt(lease.released_at),
                self._metadata_json(lease),
                lease.lease_id,
            ],
        )
        _commit_if_available(self.connection)

    def _ensure_references(self, lease: LeaseRecord, actor: Actor) -> None:
        actor_json = _dump_json(actor.as_event_actor())
        if actor.type == "agent":
            self._execute_optional(
                """
                INSERT INTO ledger_agents (agent_id, component, actor_json)
                VALUES (%s, %s, %s)
                ON CONFLICT(agent_id) DO NOTHING
                """,
                [actor.id, "c3", actor_json],
            )
        if lease.lane_id:
            self._execute_optional(
                """
                INSERT INTO ledger_lanes (lane_id, component, agent_id)
                VALUES (%s, %s, %s)
                ON CONFLICT(lane_id) DO NOTHING
                """,
                [lease.lane_id, "c3", actor.id if actor.type == "agent" else None],
            )
        if lease.session_id:
            self._execute_optional(
                """
                INSERT INTO ledger_sessions (session_id, component, agent_id, lane_id)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT(session_id) DO NOTHING
                """,
                [
                    lease.session_id,
                    "c3",
                    actor.id if actor.type == "agent" else None,
                    lease.lane_id,
                ],
            )

    def _record_from_row(self, row: Any) -> LeaseRecord:
        metadata = _load_json(row[10])
        actor_data = metadata.get("actor") or {}
        actor = Actor(
            type=actor_data.get("type") or ("agent" if row[3] else "system"),
            id=actor_data.get("id") or row[3] or "system",
            surface=actor_data.get("surface") or "ledger_api",
        )
        ttl_seconds = int(metadata.get("ttl_seconds") or 60)
        heartbeat_at = _parse_dt(row[7]) or _parse_dt(row[6]) or self._now()
        created_at = _parse_dt(row[6]) or heartbeat_at
        lease = LeaseRecord(
            lease_id=row[0],
            kind=LeaseKind(row[1]),
            status=LeaseStatus(row[2]),
            actor=actor,
            lane_id=row[4],
            session_id=row[5],
            ttl_seconds=ttl_seconds,
            created_at=created_at,
            heartbeat_at=heartbeat_at,
            updated_at=_parse_dt(metadata.get("updated_at")) or heartbeat_at,
            released_at=_parse_dt(row[9]),
            expired_at=_parse_dt(metadata.get("expired_at")),
            transferred_at=_parse_dt(metadata.get("transferred_at")),
            interrupted_at=_parse_dt(metadata.get("interrupted_at")),
            transferred_to_agent_id=metadata.get("transferred_to_agent_id"),
            interrupt_reason=metadata.get("interrupt_reason"),
            metadata=metadata.get("metadata") or {},
        )
        interrupt_actor = metadata.get("interrupt_actor")
        if isinstance(interrupt_actor, dict):
            lease.interrupt_actor = Actor(
                type=interrupt_actor.get("type") or "human",
                id=interrupt_actor.get("id") or "human",
                surface=interrupt_actor.get("surface") or "ledger_api",
            )
        return lease

    def _metadata_json(self, lease: LeaseRecord) -> str:
        data = {
            "actor": lease.actor.as_event_actor(),
            "ttl_seconds": lease.ttl_seconds,
            "updated_at": _format_dt(lease.updated_at),
            "expired_at": _format_dt(lease.expired_at),
            "transferred_at": _format_dt(lease.transferred_at),
            "transferred_to_agent_id": lease.transferred_to_agent_id,
            "interrupted_at": _format_dt(lease.interrupted_at),
            "interrupt_actor": lease.interrupt_actor.as_event_actor()
            if lease.interrupt_actor is not None
            else None,
            "interrupt_reason": lease.interrupt_reason,
            "metadata": lease.metadata,
        }
        return _dump_json(data)

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

    def _execute(self, sql: str, params: Iterable[Any] = ()) -> Any:
        prepared = _with_placeholder(sql, self._placeholder)
        if hasattr(self.connection, "execute"):
            return self.connection.execute(prepared, list(params))
        cursor = self.connection.cursor()
        cursor.execute(prepared, list(params))
        return cursor

    def _execute_optional(self, sql: str, params: Iterable[Any] = ()) -> Any:
        try:
            return self._execute(sql, params)
        except Exception as exc:
            _rollback_if_available(self.connection)
            if _looks_like_missing_optional_table(exc) or _looks_like_missing_optional_column(exc):
                return None
            raise

    def _fetch_one(self, sql: str, params: Iterable[Any] = ()) -> Any:
        cursor = self._execute(sql, params)
        return cursor.fetchone()

    def _fetch_all(self, sql: str, params: Iterable[Any] = ()) -> list[Any]:
        cursor = self._execute(sql, params)
        return list(cursor.fetchall())

    def _now(self) -> datetime:
        now = self._clock()
        if now.tzinfo is None:
            return now.replace(tzinfo=UTC)
        return now.astimezone(UTC)


def _dump_json(value: Any) -> str:
    return json.dumps(value if value is not None else {}, sort_keys=True, separators=(",", ":"))


def _load_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    return json.loads(value)


def _format_dt(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _parse_dt(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
    if isinstance(value, str):
        normalized = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)
    return None


def _is_sqlite_connection(connection: Any) -> bool:
    return connection.__class__.__module__.startswith("sqlite3")


def _with_placeholder(sql: str, placeholder: str) -> str:
    return sql.replace("%s", placeholder) if placeholder != "%s" else sql


def _commit_if_available(connection: Any) -> None:
    commit = getattr(connection, "commit", None)
    if callable(commit):
        commit()


def _rollback_if_available(connection: Any) -> None:
    rollback = getattr(connection, "rollback", None)
    if callable(rollback):
        rollback()


def _looks_like_missing_optional_table(exc: Exception) -> bool:
    message = str(exc).lower()
    return "no such table" in message or "does not exist" in message


def _looks_like_missing_optional_column(exc: Exception) -> bool:
    return "no column named" in str(exc).lower()
