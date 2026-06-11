import json
import sqlite3
from pathlib import Path

from backend.ledger.indexer import LedgerIndexer
from backend.ledger.models import AgentCreate, LaneCreate, LedgerEventIn, SessionCreate
from backend.ledger.service import LedgerService


def _sqlite_index_connection():
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
    return connection


def _jsonl_event_ids(path: Path) -> list[str]:
    return [json.loads(line)["event_id"] for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _jsonl_source_rows_by_event_id(root: Path) -> dict[str, dict]:
    sources: dict[str, dict] = {}
    for path in sorted(root.rglob("*.jsonl")):
        offset = 0
        with path.open("rb") as handle:
            for line_number, raw_line in enumerate(handle, start=1):
                line_offset = offset
                offset += len(raw_line)
                stripped = raw_line.strip()
                if not stripped:
                    continue
                event = json.loads(stripped.decode("utf-8"))
                sources[event["event_id"]] = {
                    "event": event,
                    "jsonl_path": str(path),
                    "jsonl_line_number": line_number,
                    "jsonl_byte_offset": line_offset,
                }
    return sources


def test_file_ledger_events_can_rebuild_postgres_index_by_event_id(tmp_path):
    service = LedgerService(tmp_path / "ledger-root")
    service.create_agent(
        AgentCreate(
            agent_id="agent-integration-a",
            actor={"type": "agent", "id": "agent-integration-a", "surface": "mcp"},
        )
    )
    service.create_lane(LaneCreate(lane_id="lane-integration", agent_id="agent-integration-a"))
    service.create_session(
        SessionCreate(
            session_id="session-integration",
            agent_id="agent-integration-a",
            lane_id="lane-integration",
        )
    )

    append_result = service.append_event(
        LedgerEventIn(
            event_id="evt-integration-command",
            event_type="command.started",
            actor={"type": "agent", "id": "agent-integration-a", "surface": "mcp"},
            agent_id="agent-integration-a",
            lane_id="lane-integration",
            session_id="session-integration",
            lease_id="lease-integration",
            command_id="cmd-integration",
            trace_id="trace-integration",
            payload={"command": "c3.fill_page"},
        )
    )

    written_paths = [Path(write["path"]) for write in append_result["writes"]]
    assert len(written_paths) == 3
    assert {event_id for path in written_paths for event_id in _jsonl_event_ids(path)} == {
        "evt-integration-command"
    }

    connection = _sqlite_index_connection()
    try:
        indexed_lines = LedgerIndexer(connection).rebuild_from_jsonl_root(service.root)
        rows = connection.execute("SELECT * FROM ledger_events").fetchall()
    finally:
        connection.close()

    assert indexed_lines == 3
    assert len(rows) == 1
    row = rows[0]
    assert row["event_id"] == "evt-integration-command"
    assert row["agent_id"] == "agent-integration-a"
    assert row["lane_id"] == "lane-integration"
    assert row["session_id"] == "session-integration"
    assert row["command_id"] == "cmd-integration"
    assert row["jsonl_path"] in {str(path) for path in written_paths}
    assert row["jsonl_line_number"] == 1


def test_rebuilt_index_rows_match_jsonl_source_rows_for_multiple_events(tmp_path):
    service = LedgerService(tmp_path / "ledger-root")
    agent = service.create_agent(
        AgentCreate(
            agent_id="agent-consistency",
            actor={"type": "agent", "id": "agent-consistency", "surface": "mcp"},
        )
    )
    lane = service.create_lane(LaneCreate(lane_id="lane-consistency", agent_id=agent["id"]))
    session = service.create_session(
        SessionCreate(
            session_id="session-consistency",
            agent_id=agent["id"],
            lane_id=lane["id"],
        )
    )

    service.append_event(
        LedgerEventIn(
            event_id="evt-consistency-started",
            event_type="command.started",
            actor={"type": "agent", "id": agent["id"], "surface": "mcp"},
            agent_id=agent["id"],
            lane_id=lane["id"],
            session_id=session["id"],
            command_id="cmd-consistency",
            trace_id="trace-consistency",
            payload={"step": "started"},
        )
    )
    service.append_event(
        LedgerEventIn(
            event_id="evt-consistency-completed",
            event_type="command.completed",
            actor={"type": "agent", "id": agent["id"], "surface": "mcp"},
            agent_id=agent["id"],
            lane_id=lane["id"],
            session_id=session["id"],
            command_id="cmd-consistency",
            trace_id="trace-consistency",
            payload={"step": "completed", "ok": True},
        )
    )

    source_rows = _jsonl_source_rows_by_event_id(service.root)
    connection = _sqlite_index_connection()
    try:
        indexed_lines = LedgerIndexer(connection).rebuild_from_jsonl_root(service.root)
        index_rows = {
            row["event_id"]: row
            for row in connection.execute("SELECT * FROM ledger_events ORDER BY event_id").fetchall()
        }
    finally:
        connection.close()

    assert indexed_lines == 6
    assert set(index_rows) == set(source_rows) == {
        "evt-consistency-started",
        "evt-consistency-completed",
    }
    for event_id, source in source_rows.items():
        event = source["event"]
        row = index_rows[event_id]
        assert row["seq"] == event["seq"]
        assert row["ts"] == event["ts"]
        assert row["component"] == event["component"]
        assert row["event_type"] == event["event_type"]
        assert json.loads(row["actor_json"]) == event["actor"]
        assert row["agent_id"] == event["agent_id"]
        assert row["lane_id"] == event["lane_id"]
        assert row["session_id"] == event["session_id"]
        assert row["command_id"] == event["command_id"]
        assert row["trace_id"] == event["trace_id"]
        assert json.loads(row["payload_json"]) == event["payload"]
        assert json.loads(row["redaction_json"]) == event["redaction"]
        assert row["prev_hash"] == event["prev_hash"]
        assert row["hash"] == event["hash"]
        assert row["jsonl_path"] == source["jsonl_path"]
        assert row["jsonl_line_number"] == source["jsonl_line_number"]
        assert row["jsonl_byte_offset"] == source["jsonl_byte_offset"]
