from __future__ import annotations

import json
import os
import re
import threading
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from backend.ledger.config import get_ledger_root
from backend.ledger.indexer import LedgerIndexer
from backend.ledger.leases import (
    InMemoryLeaseStore,
    LeaseConflictError,
    LeaseNotFoundError,
    LeasePermissionError,
)
from backend.ledger.models import (
    Actor,
    ActorPayload,
    AgentCreate,
    LaneCreate,
    LaneTerminalRequest,
    LeaseActionRequest,
    LeaseClaimRequest,
    LeaseKind,
    LeaseStatus,
    LedgerEventIn,
    ProbeFileCreate,
    ProbeStatusUpdate,
    SessionCreate,
)
from backend.ledger.redaction import redact_payload
from backend.ledger.service import LedgerService

router = APIRouter(prefix="/api/ledger", tags=["ledger"])
_lease_store = InMemoryLeaseStore()
_postgres_lease_store = None
_postgres_lease_store_url = ""
_terminal_locks: dict[Path, threading.RLock] = {}
_terminal_locks_guard = threading.Lock()
_TERMINAL_MARKER_MAX_BYTES = 64 * 1024
_TERMINAL_VALUE_KEY_RE = re.compile(r"(?:^|_)(?:answer|value|content|address)(?:$|_)")


def _service_token() -> str:
    try:
        from hunter.config import HUNT_SERVICE_TOKEN

        return HUNT_SERVICE_TOKEN or ""
    except Exception:
        return ""


def require_ledger_access(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_hunt_service_token: Annotated[str | None, Header()] = None,
) -> None:
    expected = _service_token().strip()
    if expected:
        bearer = ""
        if authorization and authorization.lower().startswith("bearer "):
            bearer = authorization[7:].strip()
        if bearer == expected or (x_hunt_service_token or "").strip() == expected:
            return

    try:
        from backend.auth_session import SESSION_COOKIE_NAME, validate_session

        username = validate_session(request.cookies.get(SESSION_COOKIE_NAME, ""))
        if username:
            return
    except Exception:
        pass

    if not expected:
        return
    raise HTTPException(status_code=401, detail="Missing or invalid ledger credential")


def get_ledger_service() -> LedgerService:
    return LedgerService(get_ledger_root())


def get_lease_store():
    global _postgres_lease_store, _postgres_lease_store_url

    db_url = os.environ.get("HUNT_DB_URL", "").strip()
    if not db_url:
        return _lease_store
    if _postgres_lease_store is None or _postgres_lease_store_url != db_url:
        from backend.ledger.postgres_leases import PostgresLeaseStore

        _postgres_lease_store = PostgresLeaseStore.connect(db_url)
        _postgres_lease_store_url = db_url
    return _postgres_lease_store


def _actor(payload: ActorPayload, fallback_agent_id: str = "") -> Actor:
    actor_id = payload.id or fallback_agent_id or payload.type
    return Actor(type=payload.type, id=actor_id, surface=payload.surface or "ledger_api")


def _lease_payload(record) -> dict:
    return {
        "lease_id": record.lease_id,
        "lease_type": record.kind.value,
        "status": record.status.value,
        "actor": record.actor.as_event_actor(),
        "agent_id": record.actor.id if record.actor.type == "agent" else "",
        "lane_id": record.lane_id or "",
        "session_id": record.session_id or "",
        "ttl_seconds": record.ttl_seconds,
        "created_at": record.created_at.isoformat().replace("+00:00", "Z"),
        "heartbeat_at": record.heartbeat_at.isoformat().replace("+00:00", "Z"),
        "updated_at": record.updated_at.isoformat().replace("+00:00", "Z"),
    }


def _lease_error(exc: Exception) -> HTTPException:
    if isinstance(exc, LeaseConflictError):
        return HTTPException(status_code=409, detail=exc.error)
    if isinstance(exc, LeaseNotFoundError):
        return HTTPException(status_code=404, detail=f"Lease {exc.args[0]} was not found.")
    if isinstance(exc, LeasePermissionError):
        return HTTPException(status_code=403, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


def _event_cursor(store) -> int:
    events = getattr(store, "events", None)
    return len(events) if isinstance(events, list) else 0


def _new_store_events(store, cursor: int) -> list[dict]:
    events = getattr(store, "events", None)
    if not isinstance(events, list):
        return []
    return [event for event in events[cursor:] if isinstance(event, dict)]


def _append_lease_events(service: LedgerService, events: list[dict]) -> None:
    for event in events:
        ledger_event = dict(event)
        ledger_event.pop("seq", None)
        ledger_event.pop("prev_hash", None)
        ledger_event.pop("hash", None)
        service.append_event(ledger_event)


def _terminal_lock(path: Path) -> threading.RLock:
    resolved = path.resolve()
    with _terminal_locks_guard:
        lock = _terminal_locks.get(resolved)
        if lock is None:
            lock = threading.RLock()
            _terminal_locks[resolved] = lock
        return lock


def _load_terminal_marker(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        if path.stat().st_size > _TERMINAL_MARKER_MAX_BYTES:
            raise ValueError("lane_terminal_marker_invalid")
        with path.open("rb") as stream:
            raw = stream.read(_TERMINAL_MARKER_MAX_BYTES + 1)
        if len(raw) > _TERMINAL_MARKER_MAX_BYTES:
            raise ValueError("lane_terminal_marker_invalid")
        marker = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("lane_terminal_marker_invalid") from exc
    if not isinstance(marker, dict):
        raise ValueError("lane_terminal_marker_invalid")
    return marker


def _normalized_terminal_key(value: Any) -> str:
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(value))
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _redact_terminal_value_like(value: Any, *, key: str = "") -> Any:
    normalized = _normalized_terminal_key(key)
    if normalized and _TERMINAL_VALUE_KEY_RE.search(normalized):
        return "[REDACTED]"
    if isinstance(value, Mapping):
        return {
            str(child_key): _redact_terminal_value_like(child_value, key=str(child_key))
            for child_key, child_value in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_redact_terminal_value_like(item, key=key) for item in value]
    return value


def _canonical_terminal_payload(body: LaneTerminalRequest) -> dict[str, Any]:
    payload, _redaction = redact_payload({"reason": body.reason, "result": body.result})
    return {
        "reason": payload["reason"],
        "result": _redact_terminal_value_like(payload["result"]),
    }


def _save_terminal_marker(path: Path, marker: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(marker, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _validate_terminal_identity(
    marker: dict,
    *,
    lane_id: str,
    body: LaneTerminalRequest,
    actor: Actor,
) -> None:
    expected = {
        "lane_id": lane_id,
        "session_id": body.session_id,
        "lease_id": body.lease_id,
        "agent_id": body.agent_id,
        "event_type": body.event_type,
    }
    if actor.type != "agent" or actor.id != body.agent_id:
        raise HTTPException(status_code=403, detail={"reason_code": "bad_actor"})
    for key, value in expected.items():
        if marker and marker.get(key) != value:
            raise HTTPException(
                status_code=409,
                detail={"reason_code": "lane_terminal_conflict", "field": key},
            )


def _find_session_event(
    service: LedgerService,
    session_id: str,
    *,
    event_id: str = "",
    event_type: str = "",
    lease_id: str = "",
) -> dict | None:
    for event in service.get_session_log(session_id).get("events", []):
        if not isinstance(event, dict):
            continue
        if event_id and event.get("event_id") != event_id:
            continue
        if event_type and event.get("event_type") != event_type:
            continue
        if lease_id and event.get("lease_id") != lease_id:
            continue
        return event
    return None


def _recovered_event_result(event: dict) -> dict:
    return {
        "event_id": event.get("event_id", ""),
        "writes": [],
        "event": event,
        "recovered": True,
    }


def _validate_terminal_lease_identity(lease, *, lane_id: str, body: LaneTerminalRequest) -> None:
    if (
        lease.actor.type != "agent"
        or lease.actor.id != body.agent_id
        or lease.lane_id != lane_id
        or lease.session_id != body.session_id
    ):
        raise HTTPException(status_code=403, detail={"reason_code": "lease_owner_mismatch"})


@router.post("/agents")
def create_agent(
    body: AgentCreate,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    return service.create_agent(body)


@router.post("/lanes")
def create_lane(
    body: LaneCreate,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    return service.create_lane(body)


@router.post("/lanes/{lane_id}/terminal")
def terminal_lane(
    lane_id: str,
    body: LaneTerminalRequest,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    actor = _actor(body.actor, body.agent_id)
    marker_path = service.get_session_directory(body.session_id) / "lane-terminal.json"
    with _terminal_lock(marker_path):
        try:
            marker = _load_terminal_marker(marker_path)
        except ValueError as exc:
            raise HTTPException(
                status_code=409,
                detail={"reason_code": "lane_terminal_marker_invalid"},
            ) from exc
        _validate_terminal_identity(marker, lane_id=lane_id, body=body, actor=actor)
        terminal_payload = _canonical_terminal_payload(body)
        if (
            marker
            and {
                "reason": marker.get("reason"),
                "result": marker.get("result"),
            }
            != terminal_payload
        ):
            raise HTTPException(
                status_code=409,
                detail={"reason_code": "lane_terminal_conflict", "field": "terminal_payload"},
            )
        if marker.get("status") == "complete":
            return {"ok": True, "terminal": marker}

        lease_store = get_lease_store()
        try:
            if marker:
                lease = lease_store.get_lease(body.lease_id)
                _validate_terminal_lease_identity(lease, lane_id=lane_id, body=body)
                if lease.status == LeaseStatus.ACTIVE:
                    lease = lease_store.require_mutation_lease(
                        body.session_id,
                        actor,
                        body.lease_id,
                    )
                elif lease.status != LeaseStatus.RELEASED:
                    raise LeasePermissionError(
                        f"terminal recovery requires active or released lease: {lease.status.value}"
                    )
            else:
                lease = lease_store.require_mutation_lease(
                    body.session_id,
                    actor,
                    body.lease_id,
                )
        except Exception as exc:
            raise _lease_error(exc) from exc
        if lease is None or lease.lane_id != lane_id:
            raise HTTPException(status_code=400, detail={"reason_code": "missing_lease"})

        if not marker:
            marker = {
                "status": "pending",
                "marker_path": str(marker_path),
                "terminal_event_id": f"evt-terminal-{uuid.uuid4().hex}",
                "lane_id": lane_id,
                "session_id": body.session_id,
                "lease_id": body.lease_id,
                "agent_id": body.agent_id,
                "event_type": body.event_type,
                "actor": actor.as_event_actor(),
                "reason": terminal_payload["reason"],
                "result": terminal_payload["result"],
            }
            _save_terminal_marker(marker_path, marker)

        if "event" not in marker:
            existing_event = _find_session_event(
                service,
                body.session_id,
                event_id=marker["terminal_event_id"],
            )
            marker["event"] = (
                _recovered_event_result(existing_event)
                if existing_event
                else service.append_event(
                    {
                        "event_id": marker["terminal_event_id"],
                        "component": "c3",
                        "event_type": marker["event_type"],
                        "actor": marker["actor"],
                        "agent_id": marker["agent_id"],
                        "lane_id": lane_id,
                        "session_id": marker["session_id"],
                        "lease_id": marker["lease_id"],
                        "payload": {
                            "reason": marker["reason"],
                            "result": marker["result"],
                        },
                    }
                )
            )
            _save_terminal_marker(marker_path, marker)

        if "release" not in marker:
            if lease.status == LeaseStatus.RELEASED:
                release_event = _find_session_event(
                    service,
                    body.session_id,
                    event_type="lease.released",
                    lease_id=body.lease_id,
                )
                if release_event is None:
                    release_event = service.append_event(
                        {
                            "event_id": f"evt-terminal-release-{body.lease_id}",
                            "component": "c3",
                            "event_type": "lease.released",
                            "actor": actor.as_event_actor(),
                            "agent_id": body.agent_id,
                            "lane_id": lane_id,
                            "session_id": body.session_id,
                            "lease_id": body.lease_id,
                            "payload": {"recovered": True, "lease": _lease_payload(lease)},
                        }
                    )["event"]
                marker["release"] = {
                    "event": release_event,
                    "recovered": True,
                }
                marker["status"] = "complete"
                _save_terminal_marker(marker_path, marker)
                return {"ok": True, "terminal": marker}

            cursor = _event_cursor(lease_store)
            try:
                release_event = lease_store.release(body.lease_id, actor)
            except Exception as exc:
                _append_lease_events(service, _new_store_events(lease_store, cursor))
                raise _lease_error(exc) from exc
            new_events = _new_store_events(lease_store, cursor)
            _append_lease_events(service, new_events)
            if not new_events and isinstance(release_event, dict):
                ledger_event = dict(release_event)
                ledger_event.pop("seq", None)
                ledger_event.pop("prev_hash", None)
                ledger_event.pop("hash", None)
                service.append_event(ledger_event)
            marker["release"] = {"event": release_event}
            marker["status"] = "complete"
            _save_terminal_marker(marker_path, marker)
        return {"ok": True, "terminal": marker}


@router.post("/sessions")
def create_session(
    body: SessionCreate,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    return service.create_session(body)


@router.post("/events")
def append_event(
    body: LedgerEventIn,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    return service.append_event(body)


@router.get("/agents/{agent_id}")
def get_agent_log(
    agent_id: str,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    return service.get_agent_log(agent_id)


@router.get("/sessions/{session_id}")
def get_session_log(
    session_id: str,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    return service.get_session_log(session_id)


@router.get("/commands/{command_id}/timeline")
def get_command_timeline(
    command_id: str,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    return service.command_timeline(command_id)


@router.get("/failures/recent")
def get_recent_failures(
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
    component: str = "c3",
    limit: int = 20,
):
    return service.recent_failures(component=component, limit=limit)


@router.post("/probes")
def create_probe_file(
    body: ProbeFileCreate,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    try:
        return service.create_probe_file(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/probes")
def list_probe_files(
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
    component: str = "c3",
    session_id: str = "",
    status: str = "",
):
    try:
        return service.list_probe_files(component=component, session_id=session_id, status=status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/probes/{probe_id}/status")
def update_probe_status(
    probe_id: str,
    body: ProbeStatusUpdate,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    try:
        return service.update_probe_status(probe_id, body)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Probe {probe_id} was not found.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/leases/claim")
def claim_lease(
    body: LeaseClaimRequest,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    actor = _actor(body.actor, body.agent_id)
    lease_store = get_lease_store()
    cursor = _event_cursor(lease_store)
    try:
        if body.lease_type == LeaseKind.LANE.value:
            claim = lease_store.claim_lane_lease(body.lane_id, actor, body.ttl_seconds)
        else:
            claim = lease_store.claim_session_mutation_lease(
                body.lane_id,
                body.session_id,
                actor,
                body.ttl_seconds,
            )
    except Exception as exc:
        _append_lease_events(service, _new_store_events(lease_store, cursor))
        raise _lease_error(exc) from exc
    _append_lease_events(service, _new_store_events(lease_store, cursor))
    return {
        "lease": _lease_payload(claim.lease),
        "events": claim.events,
    }


@router.post("/leases/{lease_id}/heartbeat")
def heartbeat_lease(
    lease_id: str,
    body: LeaseActionRequest,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    lease_store = get_lease_store()
    cursor = _event_cursor(lease_store)
    try:
        event = lease_store.heartbeat(lease_id, _actor(body.actor, body.agent_id))
    except Exception as exc:
        _append_lease_events(service, _new_store_events(lease_store, cursor))
        raise _lease_error(exc) from exc
    _append_lease_events(service, _new_store_events(lease_store, cursor))
    return {"event": event}


@router.post("/leases/{lease_id}/release")
def release_lease(
    lease_id: str,
    body: LeaseActionRequest,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    lease_store = get_lease_store()
    cursor = _event_cursor(lease_store)
    try:
        event = lease_store.release(lease_id, _actor(body.actor, body.agent_id))
    except Exception as exc:
        _append_lease_events(service, _new_store_events(lease_store, cursor))
        raise _lease_error(exc) from exc
    _append_lease_events(service, _new_store_events(lease_store, cursor))
    return {"event": event}


@router.post("/leases/{lease_id}/transfer")
def transfer_lease(
    lease_id: str,
    body: LeaseActionRequest,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    if body.target_actor is None:
        raise HTTPException(status_code=400, detail="target_actor is required.")
    lease_store = get_lease_store()
    cursor = _event_cursor(lease_store)
    try:
        lease = lease_store.transfer(
            lease_id,
            _actor(body.actor, body.agent_id),
            _actor(body.target_actor),
        )
    except Exception as exc:
        _append_lease_events(service, _new_store_events(lease_store, cursor))
        raise _lease_error(exc) from exc
    _append_lease_events(service, _new_store_events(lease_store, cursor))
    return {"lease": _lease_payload(lease)}


@router.post("/leases/{lease_id}/interrupt-human")
def interrupt_lease_by_human(
    lease_id: str,
    body: LeaseActionRequest,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    lease_store = get_lease_store()
    cursor = _event_cursor(lease_store)
    try:
        events = lease_store.interrupt_by_human(
            _actor(body.actor),
            lease_id=lease_id,
            reason=body.reason or "human override",
        )
    except Exception as exc:
        _append_lease_events(service, _new_store_events(lease_store, cursor))
        raise _lease_error(exc) from exc
    _append_lease_events(service, _new_store_events(lease_store, cursor))
    return {"events": events}


@router.get("/active")
def get_active(
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    active = service.get_active()
    lease_store = get_lease_store()
    leases = getattr(lease_store, "leases", {})
    active["active_leases"] = {
        lease_id: _lease_payload(lease)
        for lease_id, lease in leases.items()
        if lease.status.value == "active"
    }
    return active


@router.post("/rebuild-index")
def rebuild_index(
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    db_url = os.environ.get("HUNT_DB_URL", "").strip()
    if not db_url:
        raise HTTPException(status_code=503, detail="HUNT_DB_URL is not configured.")
    try:
        import psycopg2
    except ImportError as exc:  # pragma: no cover - depends on runtime image
        raise HTTPException(status_code=503, detail="psycopg2 is not installed.") from exc
    try:
        conn = psycopg2.connect(db_url)
        try:
            count = LedgerIndexer(conn).rebuild_from_jsonl_root(service.root, best_effort=False)
        finally:
            conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Ledger index rebuild failed: {exc}") from exc
    return {"indexed_events": count, "root": str(service.root)}


def service_for_root(root: str | Path) -> LedgerService:
    return LedgerService(root)
