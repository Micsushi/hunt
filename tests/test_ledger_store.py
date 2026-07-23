import json
import os
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.ledger.config import get_ledger_root, initialize_ledger_root
from backend.ledger.jsonl_store import JsonlLedger
from backend.ledger.models import (
    AgentCreate,
    LaneCreate,
    LedgerEventIn,
    ProbeFileCreate,
    SessionCreate,
)
from backend.ledger.redaction import env_check
from backend.ledger.service import LedgerService


def _rows(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def _assert_valid_hash_chain(path: Path) -> list[dict]:
    rows = _rows(path)
    expected_prev_hash = ""
    for expected_seq, row in enumerate(rows, start=1):
        assert row["seq"] == expected_seq
        assert row["prev_hash"] == expected_prev_hash

        hashed = dict(row)
        actual_hash = hashed.pop("hash")
        canonical = json.dumps(
            hashed,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        expected_hash = sha256(canonical.encode("utf-8")).hexdigest()
        assert actual_hash == expected_hash
        expected_prev_hash = actual_hash
    return rows


def test_active_registry_updates_are_atomic_under_parallel_agents(tmp_path):
    service = LedgerService(tmp_path / "ledger")

    def update(index: int) -> None:
        service._update_active(
            "active_sessions",
            f"session-{index}",
            tmp_path / f"manifest-{index}.json",
            tmp_path / f"events-{index}.jsonl",
        )

    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(update, range(60)))

    active = json.loads((service.root / "active.json").read_text(encoding="utf-8"))
    assert set(active["active_sessions"]) >= {f"session-{index}" for index in range(60)}
    assert not list(service.root.glob(".active.json.*.tmp"))


def test_default_log_root_is_outside_repo(monkeypatch):
    monkeypatch.delenv("HUNT_LEDGER_ROOT", raising=False)

    root = get_ledger_root()
    repo = Path(__file__).resolve().parents[1]

    expected = (
        Path.home() / "Documents" / "hunt-logs"
        if os.name == "nt"
        else Path.home() / ".hunt" / "logs"
    )
    assert root == expected.resolve()
    assert not root.is_relative_to(repo)


def test_env_log_root_override(monkeypatch, tmp_path):
    monkeypatch.setenv("HUNT_LEDGER_ROOT", str(tmp_path / "ledger"))

    assert get_ledger_root() == (tmp_path / "ledger").resolve()


def test_env_log_root_refuses_repo_path(monkeypatch):
    repo = Path(__file__).resolve().parents[1]
    monkeypatch.setenv("HUNT_LEDGER_ROOT", str(repo / "hunt-logs"))

    with pytest.raises(RuntimeError, match="must not be inside repo"):
        get_ledger_root()


def test_initialize_ledger_root_writes_structure_files(tmp_path):
    root = initialize_ledger_root(tmp_path / "ledger")

    for name in ("LEDGER_STRUCTURE.md", "schema.json", "index.json", "active.json"):
        assert (root / name).exists()
    for component in ("c3", "c4", "c2", "c1"):
        assert (root / component).is_dir()
    structure = (root / "LEDGER_STRUCTURE.md").read_text(encoding="utf-8")
    assert "Trust JSONL over database rows" in structure


def test_generated_ledger_structure_documents_agent_traversal():
    root = initialize_ledger_root(
        Path(".state") / f"test-ledger-structure-{uuid.uuid4().hex}" / "ledger"
    )
    structure = (root / "LEDGER_STRUCTURE.md").read_text(encoding="utf-8")

    for expected in (
        "Root files:",
        "`schema.json`: event fields",
        "`index.json`: rebuildable lightweight index metadata",
        "`active.json`: active agent, lane, and session manifest pointers",
        "c3/agents/<YYYY-MM-DD>/<agent_id>/manifest.json",
        "c3/lanes/<YYYY-MM-DD>/<lane_id>/manifest.json",
        "c3/sessions/<YYYY-MM-DD>/<session_id>/manifest.json",
        "c3/global/system.jsonl",
        "GET /api/ledger/agents/{agent_id}",
        "GET /api/ledger/sessions/{session_id}",
        "GET /api/ledger/commands/{command_id}/timeline",
        "hunt_ledger_get_command_timeline",
    ):
        assert expected in structure


def test_c3_agent_command_ledger_docs_include_traversal_contract():
    repo = Path(__file__).resolve().parents[1]
    guide = (repo / "docs" / "C3_AGENT_COMMAND_LEDGER.md").read_text(encoding="utf-8")

    for expected in (
        "Agents should traverse the root in this order:",
        "`active.json` for current `active_agents`, `active_lanes`, and",
        "JSONL wins",
        "c3/agents/<YYYY-MM-DD>/<agent_id>/manifest.json",
        "c3/lanes/<YYYY-MM-DD>/<lane_id>/manifest.json",
        "c3/sessions/<YYYY-MM-DD>/<session_id>/manifest.json",
        "c3/global/system.jsonl",
        "GET /api/ledger/agents/{agent_id}",
        "GET /api/ledger/sessions/{session_id}",
        "GET /api/ledger/commands/{command_id}/timeline",
        "hunt_ledger_get_agent_log",
        "hunt_ledger_get_session_log",
        "hunt_ledger_get_command_timeline",
    ):
        assert expected in guide


def test_append_event_increments_seq_and_hashes_previous_event(tmp_path):
    log_path = tmp_path / "ledger" / "c3" / "global" / "system.jsonl"
    store = JsonlLedger()

    first = store.append(log_path, {"event_type": "command.started", "payload": {"ok": True}})
    second = store.append(log_path, {"event_type": "command.completed", "payload": {"ok": True}})

    assert first["seq"] == 1
    assert first["prev_hash"] == ""
    assert second["seq"] == 2
    assert second["prev_hash"] == first["hash"]
    assert second["hash"] != first["hash"]
    assert len(_assert_valid_hash_chain(log_path)) == 2


def test_hash_chain_validation_detects_tampered_event_body(tmp_path):
    log_path = tmp_path / "events.jsonl"
    store = JsonlLedger()
    store.append(log_path, {"event_type": "command.started", "payload": {"step": 1}})
    store.append(log_path, {"event_type": "command.completed", "payload": {"step": 2}})
    _assert_valid_hash_chain(log_path)

    rows = _rows(log_path)
    rows[0]["payload"]["step"] = 99
    log_path.write_text(
        "".join(f"{json.dumps(row, sort_keys=True, separators=(',', ':'))}\n" for row in rows),
        encoding="utf-8",
    )

    with pytest.raises(AssertionError):
        _assert_valid_hash_chain(log_path)


def test_append_event_refuses_non_monotonic_manual_seq(tmp_path):
    store = JsonlLedger()
    log_path = tmp_path / "events.jsonl"
    store.append(log_path, {"event_type": "one"})

    with pytest.raises(ValueError):
        store.append(log_path, {"seq": 99, "event_type": "two"})


def test_redaction_removes_secret_email_and_phone_values(tmp_path):
    log_path = tmp_path / "events.jsonl"
    raw = {
        "event_type": "command.started",
        "payload": {
            "password": "super-secret",
            "token": "tok_123",
            "email": "person@example.com",
            "phone": "303-555-1212",
            "message": "Use verification code 123456",
        },
    }

    row = JsonlLedger().append(log_path, raw)
    line = log_path.read_text(encoding="utf-8")

    assert "super-secret" not in line
    assert "tok_123" not in line
    assert "person@example.com" not in line
    assert "303-555-1212" not in line
    assert "123456" not in line
    assert row["redaction"]["applied"] is True


def test_env_check_logs_presence_hash_and_length_not_value(monkeypatch):
    monkeypatch.setenv("HUNT_SERVICE_TOKEN", "raw-secret-value")

    payload = env_check("HUNT_SERVICE_TOKEN", expected_value="raw-secret-value")

    assert payload["present"] is True
    assert payload["matches_expected"] is True
    assert payload["length"] == len("raw-secret-value")
    assert "raw-secret-value" not in json.dumps(payload)


def test_service_creates_manifests_and_appends_to_agent_lane_session_logs(tmp_path):
    service = LedgerService(tmp_path / "ledger")
    agent = service.create_agent(AgentCreate(agent_id="agent-codex-a1b2"))
    lane = service.create_lane(LaneCreate(lane_id="lane-9401", agent_id=agent["id"]))
    session = service.create_session(
        SessionCreate(session_id="session-abc", agent_id=agent["id"], lane_id=lane["id"])
    )

    result = service.append_event(
        LedgerEventIn(
            event_type="command.started",
            agent_id=agent["id"],
            lane_id=lane["id"],
            session_id=session["id"],
            payload={"email": "agent@example.com"},
        )
    )

    assert len(result["writes"]) == 3
    for write in result["writes"]:
        path = Path(write["path"])
        assert path.exists()
        assert "agent@example.com" not in path.read_text(encoding="utf-8")
    active = service.get_active()
    assert agent["id"] in active["active_agents"]
    assert lane["id"] in active["active_lanes"]
    assert session["id"] in active["active_sessions"]


def test_service_append_event_with_new_ids_creates_agent_lane_session_logs(tmp_path):
    service = LedgerService(tmp_path / "ledger")

    result = service.append_event(
        LedgerEventIn(
            event_type="command.started",
            actor={"type": "agent", "id": "agent-implicit", "surface": "mcp"},
            agent_id="agent-implicit",
            lane_id="lane-implicit",
            session_id="session-implicit",
            payload={"ok": True},
        )
    )

    assert len(result["writes"]) == 3
    written_paths = {Path(write["path"]).name for write in result["writes"]}
    assert written_paths == {"agent.jsonl", "lane.jsonl", "session.jsonl"}
    active = service.get_active()
    assert "agent-implicit" in active["active_agents"]
    assert "lane-implicit" in active["active_lanes"]
    assert "session-implicit" in active["active_sessions"]
    session_log = service.get_session_log("session-implicit")
    assert session_log["found"] is True
    assert session_log["events"][0]["event_type"] == "command.started"


def test_service_probe_component_rejects_path_traversal(tmp_path):
    service = LedgerService(tmp_path / "ledger")
    request = ProbeFileCreate(
        component="../outside",
        agent_id="agent-probe",
        session_id="session-probe",
        filename="inspect.js",
        content="console.log('probe')",
    )

    with pytest.raises(ValueError, match="Unsupported ledger component"):
        service.create_probe_file(request)

    with pytest.raises(ValueError, match="Unsupported ledger component"):
        service.list_probe_files(component="../outside")

    assert not (tmp_path / "outside").exists()


def test_service_best_effort_index_receives_jsonl_source_location(tmp_path, monkeypatch):
    captured = {}

    class FakeConnection:
        def close(self):
            captured["closed"] = True

    class FakeIndexer:
        def __init__(self, connection):
            captured["connection"] = connection

        def index_event(self, event, **kwargs):
            captured["event"] = event
            captured["kwargs"] = kwargs
            return True

    monkeypatch.setenv("HUNT_DB_URL", "postgresql://ledger-index-test")
    monkeypatch.setitem(
        sys.modules,
        "psycopg2",
        SimpleNamespace(connect=lambda _url: FakeConnection()),
    )
    monkeypatch.setattr("backend.ledger.service.LedgerIndexer", FakeIndexer)

    service = LedgerService(tmp_path / "ledger")
    service.append_event(
        LedgerEventIn(
            event_type="command.started",
            actor={"type": "agent", "id": "agent-index-source", "surface": "mcp"},
            agent_id="agent-index-source",
            session_id="session-index-source",
            payload={"ok": True},
        )
    )

    assert captured["kwargs"]["jsonl_path"].name == "agent.jsonl"
    assert captured["kwargs"]["line_number"] == 1
    assert captured["kwargs"]["best_effort"] is True
    assert captured["closed"] is True


def test_service_append_event_does_not_fail_when_best_effort_index_is_unavailable(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HUNT_DB_URL", "postgresql://invalid:invalid@127.0.0.1:1/invalid")
    service = LedgerService(tmp_path / "ledger")
    agent = service.create_agent(AgentCreate(agent_id="agent-index-best-effort"))

    result = service.append_event(
        {
            "event_type": "command.started",
            "agent_id": agent["id"],
            "payload": {"ok": True},
        }
    )

    assert result["event_id"].startswith("evt-")
    assert result["writes"][0]["seq"] == 1
