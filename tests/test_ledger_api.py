from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.ledger.api import get_ledger_service, require_ledger_access, router
from backend.ledger.service import LedgerService


def _client(tmp_path):
    app = FastAPI()
    service = LedgerService(tmp_path / "ledger")
    app.include_router(router)
    app.dependency_overrides[get_ledger_service] = lambda: service
    app.dependency_overrides[require_ledger_access] = lambda: None
    return TestClient(app), service


def test_api_creates_agent_lane_and_session_with_temp_root(tmp_path):
    client, service = _client(tmp_path)

    agent = client.post(
        "/api/ledger/agents",
        json={"agent_id": "agent-codex-api", "actor": {"type": "agent", "id": "agent-codex-api", "surface": "mcp"}},
    )
    assert agent.status_code == 200

    lane = client.post(
        "/api/ledger/lanes",
        json={"lane_id": "lane-api", "agent_id": "agent-codex-api"},
    )
    assert lane.status_code == 200

    session = client.post(
        "/api/ledger/sessions",
        json={"session_id": "session-api", "agent_id": "agent-codex-api", "lane_id": "lane-api"},
    )
    assert session.status_code == 200

    active = client.get("/api/ledger/active")
    assert active.status_code == 200
    body = active.json()
    assert "agent-codex-api" in body["active_agents"]
    assert "lane-api" in body["active_lanes"]
    assert "session-api" in body["active_sessions"]
    assert str(service.root).startswith(str(tmp_path))


def test_api_appends_event_jsonl_when_indexer_unavailable(tmp_path):
    client, _service = _client(tmp_path)
    client.post("/api/ledger/agents", json={"agent_id": "agent-api"})
    client.post("/api/ledger/lanes", json={"lane_id": "lane-api", "agent_id": "agent-api"})
    client.post(
        "/api/ledger/sessions",
        json={"session_id": "session-api", "agent_id": "agent-api", "lane_id": "lane-api"},
    )

    response = client.post(
        "/api/ledger/events",
        json={
            "event_type": "command.started",
            "actor": {"type": "agent", "id": "agent-api", "surface": "mcp"},
            "agent_id": "agent-api",
            "lane_id": "lane-api",
            "session_id": "session-api",
            "payload": {
                "token": "secret-token",
                "email": "candidate@example.com",
                "phone": "303-555-1212",
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["event"]["seq"] == 1
    assert body["event"]["redaction"]["applied"] is True
    assert len(body["writes"]) == 3
    for write in body["writes"]:
        path = Path(write["path"])
        assert path.exists()
        text = path.read_text(encoding="utf-8")
        assert "secret-token" not in text
        assert "candidate@example.com" not in text
        assert "303-555-1212" not in text


def test_api_replaces_null_event_id_before_writing_jsonl(tmp_path):
    client, _service = _client(tmp_path)
    client.post("/api/ledger/agents", json={"agent_id": "agent-null-event"})

    response = client.post(
        "/api/ledger/events",
        json={
            "event_id": None,
            "event_type": "command.started",
            "agent_id": "agent-null-event",
            "payload": {"ok": True},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["event_id"].startswith("evt-")
    assert body["event"]["event_id"] == body["event_id"]
    log_path = Path(body["writes"][0]["path"])
    assert '"event_id":null' not in log_path.read_text(encoding="utf-8")


def test_api_global_event_without_manifest_writes_system_log(tmp_path):
    client, service = _client(tmp_path)

    response = client.post(
        "/api/ledger/events",
        json={"event_type": "system.ready", "payload": {"ok": True}},
    )

    assert response.status_code == 200
    writes = response.json()["writes"]
    assert len(writes) == 1
    assert Path(writes[0]["path"]) == service.root / "c3" / "global" / "system.jsonl"


def test_api_reads_agent_and_session_logs(tmp_path):
    client, _service = _client(tmp_path)
    client.post("/api/ledger/agents", json={"agent_id": "agent-reader"})
    client.post("/api/ledger/sessions", json={"session_id": "session-reader", "agent_id": "agent-reader"})
    client.post(
        "/api/ledger/events",
        json={
            "event_type": "command.started",
            "actor": {"type": "agent", "id": "agent-reader", "surface": "mcp"},
            "agent_id": "agent-reader",
            "session_id": "session-reader",
        },
    )

    agent_log = client.get("/api/ledger/agents/agent-reader")
    session_log = client.get("/api/ledger/sessions/session-reader")

    assert agent_log.status_code == 200
    assert session_log.status_code == 200
    assert agent_log.json()["events"][0]["event_type"] == "command.started"
    assert session_log.json()["events"][0]["event_type"] == "command.started"


def test_api_reads_command_timeline_and_recent_failures(tmp_path):
    client, _service = _client(tmp_path)
    client.post("/api/ledger/agents", json={"agent_id": "agent-timeline"})
    client.post("/api/ledger/lanes", json={"lane_id": "lane-timeline", "agent_id": "agent-timeline"})
    client.post(
        "/api/ledger/sessions",
        json={"session_id": "session-timeline", "agent_id": "agent-timeline", "lane_id": "lane-timeline"},
    )
    for event_type in ("command.requested", "command.started", "command.completed"):
        client.post(
            "/api/ledger/events",
            json={
                "event_type": event_type,
                "actor": {"type": "agent", "id": "agent-timeline", "surface": "mcp"},
                "agent_id": "agent-timeline",
                "lane_id": "lane-timeline",
                "session_id": "session-timeline",
                "command_id": "cmd-timeline",
                "payload": {"status": "accepted"},
            },
        )
    client.post(
        "/api/ledger/events",
        json={
            "event_type": "command.requested",
            "actor": {"type": "agent", "id": "agent-timeline", "surface": "mcp"},
            "agent_id": "agent-timeline",
            "lane_id": "lane-timeline",
            "session_id": "session-timeline",
            "command_id": "cmd-failed",
            "payload": {"status": "rejected", "reason_code": "missing_target"},
        },
    )

    timeline = client.get("/api/ledger/commands/cmd-timeline/timeline")
    failures = client.get("/api/ledger/failures/recent?limit=5")

    assert timeline.status_code == 200
    assert timeline.json()["event_count"] == 3
    assert [event["event_type"] for event in timeline.json()["events"]] == [
        "command.requested",
        "command.started",
        "command.completed",
    ]
    assert failures.status_code == 200
    assert failures.json()["failures"][0]["command_id"] == "cmd-failed"
    assert failures.json()["failures"][0]["reason_code"] == "missing_target"


def test_api_probe_file_is_untrusted_and_does_not_log_content(tmp_path):
    client, service = _client(tmp_path)
    client.post("/api/ledger/agents", json={"agent_id": "agent-probe"})
    client.post(
        "/api/ledger/sessions",
        json={"session_id": "session-probe", "agent_id": "agent-probe"},
    )

    response = client.post(
        "/api/ledger/probes",
        json={
            "agent_id": "agent-probe",
            "session_id": "session-probe",
            "filename": "prove-widget.js",
            "content": "console.log('probe secret body')",
            "trusted": True,
            "command_id": "cmd-probe",
            "failure_event_id": "evt-failed",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["trusted"] is False
    assert body["status"] == "written"
    assert body["command_id"] == "cmd-probe"
    assert body["failure_event_id"] == "evt-failed"
    probe_path = Path(body["path"])
    manifest_path = Path(body["manifest_path"])
    assert probe_path.exists()
    assert manifest_path.exists()
    assert probe_path.is_relative_to(service.root)
    assert manifest_path.is_relative_to(service.root)
    assert "probe secret body" in probe_path.read_text(encoding="utf-8")
    assert "probe secret body" not in manifest_path.read_text(encoding="utf-8")
    session_log = client.get("/api/ledger/sessions/session-probe").json()
    serialized_log = "\n".join(str(event) for event in session_log["events"])
    assert "probe.file_written" in serialized_log
    assert "probe secret body" not in serialized_log


def test_api_probe_status_update_is_logged_and_queryable(tmp_path):
    client, _service = _client(tmp_path)
    client.post("/api/ledger/agents", json={"agent_id": "agent-probe-status"})
    client.post(
        "/api/ledger/sessions",
        json={"session_id": "session-probe-status", "agent_id": "agent-probe-status"},
    )
    created = client.post(
        "/api/ledger/probes",
        json={
            "agent_id": "agent-probe-status",
            "session_id": "session-probe-status",
            "filename": "inspect-widget.js",
            "content": "console.log('status secret body')",
            "command_id": "cmd-original",
        },
    )
    assert created.status_code == 200
    probe_id = created.json()["probe_id"]

    updated = client.patch(
        f"/api/ledger/probes/{probe_id}/status",
        json={
            "agent_id": "agent-probe-status",
            "session_id": "session-probe-status",
            "status": "useful",
            "command_id": "cmd-promote",
            "failure_event_id": "evt-validation-failed",
            "metadata": {"reason": "matched validation failure"},
        },
    )

    assert updated.status_code == 200
    body = updated.json()
    assert body["status"] == "useful"
    assert body["command_id"] == "cmd-promote"
    assert body["failure_event_id"] == "evt-validation-failed"
    assert body["metadata"]["reason"] == "matched validation failure"

    listed = client.get("/api/ledger/probes?session_id=session-probe-status&status=useful")
    assert listed.status_code == 200
    probes = listed.json()["probes"]
    assert [probe["probe_id"] for probe in probes] == [probe_id]
    assert "content" not in probes[0]

    session_log = client.get("/api/ledger/sessions/session-probe-status").json()
    event_types = [event["event_type"] for event in session_log["events"]]
    assert event_types == ["probe.file_written", "probe.status_updated"]
    status_event = session_log["events"][-1]
    assert status_event["payload"]["previous_status"] == "written"
    assert status_event["payload"]["status"] == "useful"
    serialized_log = "\n".join(str(event) for event in session_log["events"])
    assert "status secret body" not in serialized_log


def test_api_probe_component_rejects_path_escape_values(tmp_path):
    client, _service = _client(tmp_path)

    create = client.post(
        "/api/ledger/probes",
        json={
            "component": "../outside",
            "agent_id": "agent-probe",
            "session_id": "session-probe",
            "filename": "probe.js",
            "content": "console.log('x')",
        },
    )
    listed = client.get("/api/ledger/probes?component=..%2Foutside")
    updated = client.patch(
        "/api/ledger/probes/probe-nope/status",
        json={"component": "../outside", "status": "stale"},
    )

    for response in (create, listed, updated):
        assert response.status_code == 400
        assert "Unsupported ledger component" in response.json()["detail"]


def test_api_lease_claim_blocks_second_agent_and_allows_human_interrupt(tmp_path):
    client, _service = _client(tmp_path)
    client.post("/api/ledger/agents", json={"agent_id": "agent-a"})
    client.post("/api/ledger/lanes", json={"lane_id": "lane-lease", "agent_id": "agent-a"})
    client.post(
        "/api/ledger/sessions",
        json={
            "session_id": "session-lease",
            "agent_id": "agent-a",
            "lane_id": "lane-lease",
        },
    )

    first = client.post(
        "/api/ledger/leases/claim",
        json={
            "lease_type": "session_mutation",
            "agent_id": "agent-a",
            "lane_id": "lane-lease",
            "session_id": "session-lease",
            "actor": {"type": "agent", "id": "agent-a", "surface": "mcp"},
        },
    )
    assert first.status_code == 200
    lease_id = first.json()["lease"]["lease_id"]

    blocked = client.post(
        "/api/ledger/leases/claim",
        json={
            "lease_type": "session_mutation",
            "agent_id": "agent-b",
            "lane_id": "lane-lease",
            "session_id": "session-lease",
            "actor": {"type": "agent", "id": "agent-b", "surface": "mcp"},
        },
    )
    assert blocked.status_code == 409

    interrupted = client.post(
        f"/api/ledger/leases/{lease_id}/interrupt-human",
        json={
            "actor": {"type": "human", "id": "human-local", "surface": "c0_ui"},
            "reason": "clicked override",
        },
    )
    assert interrupted.status_code == 200
    assert interrupted.json()["events"][0]["event_type"] == "lease.interrupted_by_human"
    session_events = client.get("/api/ledger/sessions/session-lease").json()["events"]
    event_types = [event["event_type"] for event in session_events]
    assert "lease.requested" in event_types
    assert "lease.granted" in event_types
    assert "lease.blocked" in event_types
    assert "lease.interrupted_by_human" in event_types
