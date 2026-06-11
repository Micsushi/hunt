from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

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
    LeaseActionRequest,
    LeaseClaimRequest,
    LeaseKind,
    LedgerEventIn,
    ProbeFileCreate,
    SessionCreate,
)
from backend.ledger.service import LedgerService

router = APIRouter(prefix="/api/ledger", tags=["ledger"])
_lease_store = InMemoryLeaseStore()
_postgres_lease_store = None
_postgres_lease_store_url = ""


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


@router.post("/probes")
def create_probe_file(
    body: ProbeFileCreate,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
):
    return service.create_probe_file(body)


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
