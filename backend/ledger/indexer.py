"""Standalone Postgres indexer for immutable ledger JSONL events."""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any


class LedgerIndexError(RuntimeError):
    """Raised when a ledger event cannot be indexed in strict mode."""


class LedgerIndexer:
    """Best-effort index writer for rebuildable ledger search tables.

    The immutable JSONL writer is package 01's source of truth. This class only
    accepts already-redacted event dictionaries and writes query-friendly rows.
    """

    def __init__(self, connection: Any):
        self.connection = connection
        self._placeholder = "?" if _is_sqlite_connection(connection) else "%s"

    def index_event(
        self,
        event: dict[str, Any],
        *,
        jsonl_path: str | Path | None = None,
        line_number: int | None = None,
        byte_offset: int | None = None,
        best_effort: bool = False,
    ) -> bool:
        """Upsert one redacted ledger event by event_id.

        Returns True when the row was indexed. In best-effort mode, database
        errors return False so JSONL append paths can continue.
        """

        try:
            row = self._event_row(event, jsonl_path, line_number, byte_offset)
            self._ensure_event_references(event)
            self._execute(_with_placeholder(UPSERT_EVENT_SQL, self._placeholder), row)
            _commit_if_available(self.connection)
            return True
        except Exception as exc:  # pragma: no cover - branch exercised via tests
            _rollback_if_available(self.connection)
            if best_effort:
                return False
            raise LedgerIndexError(f"Failed to index ledger event {event.get('event_id')}") from exc

    def rebuild_from_jsonl_root(self, root: str | Path, *, best_effort: bool = False) -> int:
        """Scan a ledger root for .jsonl files and index every valid event line."""

        count = 0
        for path in sorted(Path(root).rglob("*.jsonl")):
            count += self.rebuild_from_jsonl_file(path, best_effort=best_effort)
        return count

    def rebuild_from_jsonl_file(self, path: str | Path, *, best_effort: bool = False) -> int:
        """Index valid JSON object lines from one JSONL file."""

        count = 0
        jsonl_path = Path(path)
        offset = 0
        with jsonl_path.open("rb") as handle:
            for line_number, raw_line in enumerate(handle, start=1):
                line_offset = offset
                offset += len(raw_line)
                stripped = raw_line.strip()
                if not stripped:
                    continue
                try:
                    event = json.loads(stripped.decode("utf-8"))
                except json.JSONDecodeError:
                    if best_effort:
                        continue
                    raise
                if not isinstance(event, dict):
                    if best_effort:
                        continue
                    raise LedgerIndexError(f"Ledger JSONL line {line_number} is not an object")
                if self.index_event(
                    event,
                    jsonl_path=jsonl_path,
                    line_number=line_number,
                    byte_offset=line_offset,
                    best_effort=best_effort,
                ):
                    count += 1
        return count

    def events_by_agent(self, agent_id: str) -> list[Any]:
        return self._fetch_all("SELECT * FROM ledger_events WHERE agent_id = %s ORDER BY ts", [agent_id])

    def events_by_session(self, session_id: str) -> list[Any]:
        return self._fetch_all(
            "SELECT * FROM ledger_events WHERE session_id = %s ORDER BY ts",
            [session_id],
        )

    def events_by_lane(self, lane_id: str) -> list[Any]:
        return self._fetch_all("SELECT * FROM ledger_events WHERE lane_id = %s ORDER BY ts", [lane_id])

    def events_by_command(self, command_id: str) -> list[Any]:
        return self._fetch_all(
            "SELECT * FROM ledger_events WHERE command_id = %s ORDER BY ts",
            [command_id],
        )

    def active_leases(self) -> list[Any]:
        return self._fetch_all(
            """
            SELECT * FROM ledger_leases
            WHERE status IN ('active', 'granted')
            ORDER BY expires_at
            """
        )

    def active_sessions(self) -> list[Any]:
        return self._fetch_all(
            """
            SELECT * FROM ledger_sessions
            WHERE status IN ('active', 'open')
            ORDER BY created_at
            """
        )

    def probe_files(
        self,
        *,
        session_id: str | None = None,
        trusted: bool | None = None,
        status: str | None = None,
    ) -> list[Any]:
        clauses: list[str] = []
        params: list[Any] = []
        if session_id is not None:
            clauses.append("session_id = %s")
            params.append(session_id)
        if trusted is not None:
            clauses.append("trusted = %s")
            params.append(trusted)
        if status is not None:
            clauses.append("status = %s")
            params.append(status)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        return self._fetch_all(f"SELECT * FROM ledger_probe_files{where} ORDER BY created_at", params)

    def _event_row(
        self,
        event: dict[str, Any],
        jsonl_path: str | Path | None,
        line_number: int | None,
        byte_offset: int | None,
    ) -> list[Any]:
        event_id = event.get("event_id")
        if not event_id:
            raise LedgerIndexError("Ledger event is missing event_id")

        return [
            event_id,
            event.get("seq"),
            event.get("ts"),
            event.get("component"),
            event.get("event_type"),
            _dump_json(event.get("actor", {})),
            _blank_to_none(event.get("agent_id")),
            _blank_to_none(event.get("lane_id")),
            _blank_to_none(event.get("session_id")),
            _blank_to_none(event.get("lease_id")),
            _blank_to_none(event.get("command_id")),
            _blank_to_none(event.get("trace_id")),
            _dump_json(event.get("payload", {})),
            _dump_json(event.get("redaction", {})),
            event.get("prev_hash"),
            event.get("hash"),
            str(jsonl_path) if jsonl_path is not None else None,
            line_number,
            byte_offset,
        ]

    def _ensure_event_references(self, event: dict[str, Any]) -> None:
        component = event.get("component") or "c3"
        actor_json = _dump_json(event.get("actor", {}))
        agent_id = _blank_to_none(event.get("agent_id"))
        lane_id = _blank_to_none(event.get("lane_id"))
        session_id = _blank_to_none(event.get("session_id"))
        lease_id = _blank_to_none(event.get("lease_id"))

        if agent_id:
            self._execute_optional(
                """
                INSERT INTO ledger_agents (agent_id, component, actor_json)
                VALUES (%s, %s, %s)
                ON CONFLICT(agent_id) DO NOTHING
                """,
                [agent_id, component, actor_json],
            )
        if lane_id:
            self._execute_optional(
                """
                INSERT INTO ledger_lanes (lane_id, component, agent_id)
                VALUES (%s, %s, %s)
                ON CONFLICT(lane_id) DO NOTHING
                """,
                [lane_id, component, agent_id],
            )
        if session_id:
            self._execute_optional(
                """
                INSERT INTO ledger_sessions (session_id, component, agent_id, lane_id)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT(session_id) DO NOTHING
                """,
                [session_id, component, agent_id, lane_id],
            )
        if lease_id:
            self._ensure_lease_reference(event, lease_id, component, agent_id, lane_id, session_id)

    def _ensure_lease_reference(
        self,
        event: dict[str, Any],
        lease_id: str,
        component: str,
        agent_id: str | None,
        lane_id: str | None,
        session_id: str | None,
    ) -> None:
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        lease_type = payload.get("lease_kind") or payload.get("lease_type") or "indexed_from_event"
        status = payload.get("lease_status") or "indexed_from_event"
        expires_at = event.get("ts") or ""
        columns = self._table_columns("ledger_leases")
        if {"lease_type", "metadata_json"}.issubset(columns):
            self._execute_optional(
                """
                INSERT INTO ledger_leases (
                    lease_id,
                    component,
                    lease_type,
                    status,
                    agent_id,
                    lane_id,
                    session_id,
                    expires_at,
                    metadata_json
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT(lease_id) DO NOTHING
                """,
                [
                    lease_id,
                    component,
                    lease_type,
                    status,
                    agent_id,
                    lane_id,
                    session_id,
                    expires_at,
                    _dump_json({"indexed_from_event_id": event.get("event_id")}),
                ],
            )
        else:
            self._execute_optional(
                """
                INSERT INTO ledger_leases (lease_id, status, expires_at)
                VALUES (%s, %s, %s)
                ON CONFLICT(lease_id) DO NOTHING
                """,
                [lease_id, status, expires_at],
            )

    def _table_columns(self, table_name: str) -> set[str]:
        if _is_sqlite_connection(self.connection):
            cursor = self._execute(f"PRAGMA table_info({table_name})")
            return {row[1] for row in cursor.fetchall()}
        try:
            cursor = self._execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = %s
                """,
                [table_name],
            )
            return {row[0] for row in cursor.fetchall()}
        except Exception:
            _rollback_if_available(self.connection)
            return set()

    def _execute(self, sql: str, params: Iterable[Any] = ()) -> Any:
        if hasattr(self.connection, "execute"):
            return self.connection.execute(sql, list(params))
        cursor = self.connection.cursor()
        cursor.execute(sql, list(params))
        return cursor

    def _execute_optional(self, sql: str, params: Iterable[Any] = ()) -> Any:
        try:
            return self._execute(_with_placeholder(sql, self._placeholder), params)
        except Exception as exc:
            _rollback_if_available(self.connection)
            if _looks_like_missing_optional_table(exc):
                return None
            raise

    def _fetch_all(self, sql: str, params: Iterable[Any] = ()) -> list[Any]:
        cursor = self._execute(_with_placeholder(sql, self._placeholder), params)
        return list(cursor.fetchall())


UPSERT_EVENT_SQL = """
INSERT INTO ledger_events (
    event_id,
    seq,
    ts,
    component,
    event_type,
    actor_json,
    agent_id,
    lane_id,
    session_id,
    lease_id,
    command_id,
    trace_id,
    payload_json,
    redaction_json,
    prev_hash,
    hash,
    jsonl_path,
    jsonl_line_number,
    jsonl_byte_offset
)
VALUES (
    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
    %s, %s, %s, %s, %s, %s, %s, %s, %s
)
ON CONFLICT(event_id) DO UPDATE SET
    seq = excluded.seq,
    ts = excluded.ts,
    component = excluded.component,
    event_type = excluded.event_type,
    actor_json = excluded.actor_json,
    agent_id = excluded.agent_id,
    lane_id = excluded.lane_id,
    session_id = excluded.session_id,
    lease_id = excluded.lease_id,
    command_id = excluded.command_id,
    trace_id = excluded.trace_id,
    payload_json = excluded.payload_json,
    redaction_json = excluded.redaction_json,
    prev_hash = excluded.prev_hash,
    hash = excluded.hash,
    jsonl_path = excluded.jsonl_path,
    jsonl_line_number = excluded.jsonl_line_number,
    jsonl_byte_offset = excluded.jsonl_byte_offset
"""


def _dump_json(value: Any) -> str:
    return json.dumps(value if value is not None else {}, sort_keys=True, separators=(",", ":"))


def _blank_to_none(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str) and value.strip() == "":
        return None
    return value


def _looks_like_missing_optional_table(exc: Exception) -> bool:
    message = str(exc).lower()
    return "no such table" in message or "does not exist" in message


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
