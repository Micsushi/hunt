from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.ledger.api import get_ledger_service, require_ledger_access
from backend.ledger.models import ActorPayload
from backend.ledger.service import LedgerService


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class BrowserTargetRegister(BaseModel):
    session_id: str = Field(min_length=1)
    agent_id: str = Field(min_length=1)
    lane_id: str = Field(min_length=1)
    browser_kind: str = Field(min_length=1)
    debug_port: int = Field(ge=1, le=65535)
    extension_id: str = Field(min_length=1)
    options_url: str = Field(min_length=1)
    created_at: str = ""
    heartbeat_at: str = ""
    tab_id: int | None = None
    url: str = ""
    actor: ActorPayload = Field(
        default_factory=lambda: ActorPayload(type="agent", surface="c3_extension")
    )
    metadata: dict[str, Any] = Field(default_factory=dict)


@dataclass(frozen=True)
class BrowserTargetRecord:
    session_id: str
    agent_id: str
    lane_id: str
    browser_kind: str
    debug_port: int
    extension_id: str
    options_url: str
    created_at: str
    heartbeat_at: str
    updated_at: str
    tab_id: int | None = None
    url: str = ""
    status: str = "active"
    metadata: dict[str, Any] | None = None
    unregistered_at: str = ""

    def as_response(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["metadata"] = self.metadata or {}
        return payload


class InMemoryBrowserTargetStore:
    def __init__(self) -> None:
        self.targets: dict[str, BrowserTargetRecord] = {}

    def register(self, request: BrowserTargetRegister) -> BrowserTargetRecord:
        now = _now()
        existing = self.targets.get(request.session_id)
        record = BrowserTargetRecord(
            session_id=request.session_id,
            agent_id=request.agent_id,
            lane_id=request.lane_id,
            browser_kind=request.browser_kind,
            debug_port=request.debug_port,
            extension_id=request.extension_id,
            options_url=request.options_url,
            tab_id=request.tab_id,
            url=request.url,
            status="active",
            created_at=(existing.created_at if existing else (request.created_at or now)),
            heartbeat_at=request.heartbeat_at or now,
            updated_at=now,
            metadata=dict(request.metadata),
        )
        self.targets[request.session_id] = record
        return record

    def get(self, session_id: str) -> BrowserTargetRecord | None:
        record = self.targets.get(session_id)
        if record is None or record.status != "active":
            return None
        return record

    def list_active(self) -> list[BrowserTargetRecord]:
        return [target for target in self.targets.values() if target.status == "active"]

    def unregister(self, session_id: str) -> BrowserTargetRecord | None:
        record = self.get(session_id)
        if record is None:
            return None
        updated = replace(record, status="unregistered", updated_at=_now(), unregistered_at=_now())
        self.targets[session_id] = updated
        return updated


class PostgresBrowserTargetStore:
    def __init__(self, connection: Any) -> None:
        self.connection = connection
        self._placeholder = "?" if _is_sqlite_connection(connection) else "%s"

    @classmethod
    def connect(cls, db_url: str) -> PostgresBrowserTargetStore:
        import psycopg2

        return cls(psycopg2.connect(db_url))

    def register(self, request: BrowserTargetRegister) -> BrowserTargetRecord:
        now = _now()
        existing = self.get_any(request.session_id)
        created_at = existing.created_at if existing else (request.created_at or now)
        heartbeat_at = request.heartbeat_at or now
        metadata_json = _dump_json(request.metadata)
        self._execute(
            """
            INSERT INTO ledger_browser_targets (
                session_id, component, agent_id, lane_id, browser_kind, debug_port,
                extension_id, options_url, tab_id, url, status, created_at,
                heartbeat_at, updated_at, unregistered_at, metadata_json
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT(session_id) DO UPDATE SET
                agent_id = excluded.agent_id,
                lane_id = excluded.lane_id,
                browser_kind = excluded.browser_kind,
                debug_port = excluded.debug_port,
                extension_id = excluded.extension_id,
                options_url = excluded.options_url,
                tab_id = excluded.tab_id,
                url = excluded.url,
                status = excluded.status,
                heartbeat_at = excluded.heartbeat_at,
                updated_at = excluded.updated_at,
                unregistered_at = excluded.unregistered_at,
                metadata_json = excluded.metadata_json
            """,
            [
                request.session_id,
                "c3",
                request.agent_id,
                request.lane_id,
                request.browser_kind,
                request.debug_port,
                request.extension_id,
                request.options_url,
                request.tab_id,
                request.url,
                "active",
                created_at,
                heartbeat_at,
                now,
                None,
                metadata_json,
            ],
        )
        _commit_if_available(self.connection)
        record = self.get(request.session_id)
        if record is None:
            raise RuntimeError("registered browser target was not readable")
        return record

    def get(self, session_id: str) -> BrowserTargetRecord | None:
        return self._get(session_id, active_only=True)

    def get_any(self, session_id: str) -> BrowserTargetRecord | None:
        return self._get(session_id, active_only=False)

    def list_active(self) -> list[BrowserTargetRecord]:
        rows = self._fetch_all(
            """
            SELECT session_id, agent_id, lane_id, browser_kind, debug_port,
                   extension_id, options_url, tab_id, url, status, created_at,
                   heartbeat_at, updated_at, unregistered_at, metadata_json
            FROM ledger_browser_targets
            WHERE status = %s
            ORDER BY heartbeat_at DESC
            """,
            ["active"],
        )
        return [self._record_from_row(row) for row in rows]

    def unregister(self, session_id: str) -> BrowserTargetRecord | None:
        existing = self.get(session_id)
        if existing is None:
            return None
        now = _now()
        self._execute(
            """
            UPDATE ledger_browser_targets
            SET status = %s, updated_at = %s, unregistered_at = %s
            WHERE session_id = %s AND status = %s
            """,
            ["unregistered", now, now, session_id, "active"],
        )
        _commit_if_available(self.connection)
        return self.get_any(session_id)

    def _get(self, session_id: str, *, active_only: bool) -> BrowserTargetRecord | None:
        where = "session_id = %s"
        params: list[Any] = [session_id]
        if active_only:
            where += " AND status = %s"
            params.append("active")
        row = self._fetch_one(
            f"""
            SELECT session_id, agent_id, lane_id, browser_kind, debug_port,
                   extension_id, options_url, tab_id, url, status, created_at,
                   heartbeat_at, updated_at, unregistered_at, metadata_json
            FROM ledger_browser_targets
            WHERE {where}
            """,
            params,
        )
        return self._record_from_row(row) if row is not None else None

    def _record_from_row(self, row: Any) -> BrowserTargetRecord:
        return BrowserTargetRecord(
            session_id=row[0],
            agent_id=row[1],
            lane_id=row[2],
            browser_kind=row[3],
            debug_port=int(row[4]),
            extension_id=row[5],
            options_url=row[6],
            tab_id=row[7],
            url=row[8] or "",
            status=row[9],
            created_at=row[10],
            heartbeat_at=row[11],
            updated_at=row[12],
            unregistered_at=row[13] or "",
            metadata=_load_json(row[14]),
        )

    def _execute(self, sql: str, params: list[Any]) -> Any:
        prepared = _with_placeholder(sql, self._placeholder)
        if hasattr(self.connection, "execute"):
            return self.connection.execute(prepared, params)
        cursor = self.connection.cursor()
        cursor.execute(prepared, params)
        return cursor

    def _fetch_one(self, sql: str, params: list[Any]) -> Any:
        cursor = self._execute(sql, params)
        return cursor.fetchone()

    def _fetch_all(self, sql: str, params: list[Any]) -> list[Any]:
        cursor = self._execute(sql, params)
        return list(cursor.fetchall())


router = APIRouter(prefix="/api/c3/browser-targets", tags=["c3-browser-targets"])
_memory_store = InMemoryBrowserTargetStore()
_postgres_store: PostgresBrowserTargetStore | None = None
_postgres_store_url = ""


def get_browser_target_store():
    global _postgres_store, _postgres_store_url

    db_url = os.environ.get("HUNT_DB_URL", "").strip()
    if not db_url:
        return _memory_store
    if _postgres_store is None or _postgres_store_url != db_url:
        _postgres_store = PostgresBrowserTargetStore.connect(db_url)
        _postgres_store_url = db_url
    return _postgres_store


def _event_actor(request_actor: ActorPayload, fallback_agent_id: str) -> dict[str, str]:
    actor_type = request_actor.type or "agent"
    actor_id = request_actor.id or fallback_agent_id or actor_type
    surface = request_actor.surface or "c3_extension"
    return {"type": actor_type, "id": actor_id, "surface": surface}


def _append_audit_event(
    service: LedgerService,
    *,
    event_type: str,
    target: BrowserTargetRecord,
    actor: dict[str, str],
    reason: str = "",
) -> str:
    payload = target.as_response()
    if reason:
        payload["reason"] = reason
    event = service.append_event(
        {
            "component": "c3",
            "event_type": event_type,
            "actor": actor,
            "agent_id": target.agent_id,
            "lane_id": target.lane_id,
            "session_id": target.session_id,
            "payload": payload,
        }
    )
    return str(event["event_id"])


@router.post("/register")
def register_browser_target(
    body: BrowserTargetRegister,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
    store: Annotated[Any, Depends(get_browser_target_store)],
):
    target = store.register(body)
    event_id = _append_audit_event(
        service,
        event_type="browser_target.registered",
        target=target,
        actor=_event_actor(body.actor, body.agent_id),
    )
    return {"status": "registered", "target": target.as_response(), "event_id": event_id}


@router.get("")
def list_browser_targets(
    _access: Annotated[None, Depends(require_ledger_access)],
    store: Annotated[Any, Depends(get_browser_target_store)],
):
    return {"targets": [target.as_response() for target in store.list_active()]}


@router.get("/{session_id}")
def get_browser_target(
    session_id: str,
    _access: Annotated[None, Depends(require_ledger_access)],
    store: Annotated[Any, Depends(get_browser_target_store)],
):
    target = store.get(session_id)
    if target is None:
        raise HTTPException(
            status_code=404, detail=f"Browser target for session {session_id} was not found."
        )
    return {"target": target.as_response()}


@router.delete("/{session_id}")
def unregister_browser_target(
    session_id: str,
    _access: Annotated[None, Depends(require_ledger_access)],
    service: Annotated[LedgerService, Depends(get_ledger_service)],
    store: Annotated[Any, Depends(get_browser_target_store)],
    agent_id: str = Query(default=""),
    reason: str = Query(default=""),
):
    target = store.unregister(session_id)
    if target is None:
        raise HTTPException(
            status_code=404, detail=f"Browser target for session {session_id} was not found."
        )
    actor = {"type": "agent", "id": agent_id or target.agent_id, "surface": "c3_extension"}
    event_id = _append_audit_event(
        service,
        event_type="browser_target.unregistered",
        target=target,
        actor=actor,
        reason=reason,
    )
    return {"status": "unregistered", "target": target.as_response(), "event_id": event_id}


def _dump_json(value: Any) -> str:
    return json.dumps(value if value is not None else {}, sort_keys=True, separators=(",", ":"))


def _load_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    return json.loads(value)


def _is_sqlite_connection(connection: Any) -> bool:
    return connection.__class__.__module__.startswith("sqlite3")


def _with_placeholder(sql: str, placeholder: str) -> str:
    return sql.replace("%s", placeholder) if placeholder != "%s" else sql


def _commit_if_available(connection: Any) -> None:
    commit = getattr(connection, "commit", None)
    if callable(commit):
        commit()
