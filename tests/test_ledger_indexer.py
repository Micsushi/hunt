import json
import sqlite3

import pytest

from backend.ledger.indexer import LedgerIndexer, LedgerIndexError


def _event(event_id="evt-1", **overrides):
    event = {
        "event_id": event_id,
        "seq": 1,
        "ts": "2026-06-10T00:00:00.000Z",
        "component": "c3",
        "event_type": "command.started",
        "actor": {"type": "agent", "id": "agent-codex-a1b2", "surface": "mcp"},
        "agent_id": "agent-codex-a1b2",
        "lane_id": "lane-batch-1",
        "session_id": "session-abc",
        "lease_id": "lease-123",
        "command_id": "cmd-456",
        "trace_id": "trace-789",
        "payload": {"safe": True},
        "redaction": {"applied": True, "rules": []},
        "prev_hash": "",
        "hash": "hash-1",
    }
    event.update(overrides)
    return event


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE ledger_events (
            event_id TEXT PRIMARY KEY,
            seq INTEGER,
            ts TEXT NOT NULL,
            component TEXT NOT NULL,
            event_type TEXT NOT NULL,
            actor_json TEXT NOT NULL DEFAULT '{}',
            agent_id TEXT,
            lane_id TEXT,
            session_id TEXT,
            lease_id TEXT,
            command_id TEXT,
            trace_id TEXT,
            payload_json TEXT NOT NULL DEFAULT '{}',
            redaction_json TEXT NOT NULL DEFAULT '{}',
            prev_hash TEXT,
            hash TEXT,
            jsonl_path TEXT,
            jsonl_line_number INTEGER,
            jsonl_byte_offset INTEGER
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE ledger_agents (
            agent_id TEXT PRIMARY KEY,
            component TEXT NOT NULL DEFAULT 'c3',
            actor_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'active'
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE ledger_lanes (
            lane_id TEXT PRIMARY KEY,
            component TEXT NOT NULL DEFAULT 'c3',
            agent_id TEXT
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE ledger_sessions (
            session_id TEXT PRIMARY KEY,
            component TEXT NOT NULL DEFAULT 'c3',
            agent_id TEXT,
            lane_id TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT '2026-06-10T00:00:00.000Z'
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE ledger_leases (
            lease_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE ledger_probe_files (
            probe_id TEXT PRIMARY KEY,
            session_id TEXT,
            trusted INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    yield connection
    connection.close()


def test_duplicate_event_id_upserts_instead_of_inserting_duplicate(conn):
    indexer = LedgerIndexer(conn)

    assert indexer.index_event(_event("evt-duplicate"), jsonl_path="agent.jsonl", line_number=1)
    assert indexer.index_event(
        _event("evt-duplicate", seq=2, event_type="command.completed", hash="hash-2"),
        jsonl_path="agent.jsonl",
        line_number=2,
    )

    rows = conn.execute(
        "SELECT * FROM ledger_events WHERE event_id = ?", ("evt-duplicate",)
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["seq"] == 2
    assert rows[0]["event_type"] == "command.completed"
    assert rows[0]["jsonl_line_number"] == 2


def test_strict_index_event_raises_for_database_failure():
    indexer = LedgerIndexer(sqlite3.connect(":memory:"))

    with pytest.raises(LedgerIndexError):
        indexer.index_event(_event())


def test_best_effort_index_event_swallows_database_failure():
    indexer = LedgerIndexer(sqlite3.connect(":memory:"))

    assert indexer.index_event(_event(), best_effort=True) is False


def test_rebuild_from_jsonl_indexes_agent_session_and_lease_events(conn, tmp_path):
    jsonl_path = tmp_path / "session.jsonl"
    events = [
        _event("evt-agent", event_type="agent.created"),
        _event("evt-session", event_type="session.opened"),
        _event("evt-lease", event_type="lease.granted"),
    ]
    jsonl_path.write_text(
        "".join(f"{json.dumps(event, sort_keys=True)}\n" for event in events),
        encoding="utf-8",
    )

    count = LedgerIndexer(conn).rebuild_from_jsonl_root(tmp_path)

    assert count == 3
    rows = conn.execute(
        "SELECT event_id, event_type, jsonl_path, jsonl_line_number, jsonl_byte_offset FROM ledger_events ORDER BY jsonl_line_number"
    ).fetchall()
    assert [row["event_type"] for row in rows] == [
        "agent.created",
        "session.opened",
        "lease.granted",
    ]
    assert rows[0]["jsonl_path"] == str(jsonl_path)
    assert rows[0]["jsonl_line_number"] == 1
    assert rows[1]["jsonl_byte_offset"] > rows[0]["jsonl_byte_offset"]
    assert conn.execute("SELECT COUNT(*) FROM ledger_agents").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM ledger_lanes").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM ledger_sessions").fetchone()[0] == 1


def test_indexer_populates_full_lease_reference_schema(tmp_path):
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE ledger_events (
            event_id TEXT PRIMARY KEY,
            seq INTEGER,
            ts TEXT NOT NULL,
            component TEXT NOT NULL,
            event_type TEXT NOT NULL,
            actor_json TEXT NOT NULL DEFAULT '{}',
            agent_id TEXT,
            lane_id TEXT,
            session_id TEXT,
            lease_id TEXT,
            command_id TEXT,
            trace_id TEXT,
            payload_json TEXT NOT NULL DEFAULT '{}',
            redaction_json TEXT NOT NULL DEFAULT '{}',
            prev_hash TEXT,
            hash TEXT,
            jsonl_path TEXT,
            jsonl_line_number INTEGER,
            jsonl_byte_offset INTEGER
        )
        """
    )
    connection.execute(
        "CREATE TABLE ledger_agents (agent_id TEXT PRIMARY KEY, component TEXT NOT NULL, actor_json TEXT NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE ledger_lanes (lane_id TEXT PRIMARY KEY, component TEXT NOT NULL, agent_id TEXT)"
    )
    connection.execute(
        "CREATE TABLE ledger_sessions (session_id TEXT PRIMARY KEY, component TEXT NOT NULL, agent_id TEXT, lane_id TEXT)"
    )
    connection.execute(
        """
        CREATE TABLE ledger_leases (
            lease_id TEXT PRIMARY KEY,
            component TEXT NOT NULL DEFAULT 'c3',
            lease_type TEXT NOT NULL,
            status TEXT NOT NULL,
            agent_id TEXT,
            lane_id TEXT,
            session_id TEXT,
            expires_at TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        )
        """
    )

    LedgerIndexer(connection).index_event(
        _event(
            "evt-lease-full",
            event_type="lease.granted",
            payload={
                "lease_kind": "session_mutation",
                "lease_status": "active",
                "owner_agent_id": "agent-codex-a1b2",
            },
        ),
        jsonl_path=tmp_path / "session.jsonl",
        line_number=1,
    )

    row = connection.execute(
        "SELECT * FROM ledger_leases WHERE lease_id = ?", ("lease-123",)
    ).fetchone()
    assert row["lease_type"] == "session_mutation"
    assert row["status"] == "active"
    assert row["agent_id"] == "agent-codex-a1b2"


def test_blank_optional_relationship_ids_are_indexed_as_null(conn):
    indexer = LedgerIndexer(conn)

    indexer.index_event(
        _event(
            "evt-no-lease",
            lease_id="",
            command_id="",
            trace_id="",
        )
    )

    row = conn.execute(
        "SELECT lease_id, command_id, trace_id FROM ledger_events WHERE event_id = ?",
        ("evt-no-lease",),
    ).fetchone()
    assert row["lease_id"] is None
    assert row["command_id"] is None
    assert row["trace_id"] is None


def test_query_helpers_filter_common_dimensions(conn):
    indexer = LedgerIndexer(conn)
    indexer.index_event(_event("evt-agent-a", agent_id="agent-a", session_id="session-a"))
    indexer.index_event(_event("evt-agent-b", agent_id="agent-b", session_id="session-b"))
    conn.execute(
        "UPDATE ledger_sessions SET status = ? WHERE session_id = ?", ("active", "session-a")
    )
    conn.execute(
        "UPDATE ledger_sessions SET status = ? WHERE session_id = ?", ("closed", "session-b")
    )
    conn.execute(
        "INSERT INTO ledger_leases (lease_id, status, expires_at) VALUES (?, ?, ?)",
        ("lease-a", "granted", "2026-06-10T00:10:00.000Z"),
    )
    conn.execute(
        """
        INSERT INTO ledger_probe_files (probe_id, session_id, trusted, status, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        ("probe-a", "session-a", 0, "unreviewed", "2026-06-10T00:00:00.000Z"),
    )

    assert [row["event_id"] for row in indexer.events_by_agent("agent-a")] == ["evt-agent-a"]
    assert [row["event_id"] for row in indexer.events_by_session("session-b")] == ["evt-agent-b"]
    assert [row["session_id"] for row in indexer.active_sessions()] == ["session-a"]
    assert [row["lease_id"] for row in indexer.active_leases()] == ["lease-a"]
    assert [
        row["probe_id"] for row in indexer.probe_files(session_id="session-a", trusted=False)
    ] == ["probe-a"]
