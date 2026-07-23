from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.ledger.api import get_ledger_service, require_ledger_access, router
from backend.ledger.leases import InMemoryLeaseStore
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
        json={
            "agent_id": "agent-codex-api",
            "actor": {"type": "agent", "id": "agent-codex-api", "surface": "mcp"},
        },
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
    client.post(
        "/api/ledger/sessions", json={"session_id": "session-reader", "agent_id": "agent-reader"}
    )
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
    client.post(
        "/api/ledger/lanes", json={"lane_id": "lane-timeline", "agent_id": "agent-timeline"}
    )
    client.post(
        "/api/ledger/sessions",
        json={
            "session_id": "session-timeline",
            "agent_id": "agent-timeline",
            "lane_id": "lane-timeline",
        },
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


def test_lane_terminal_endpoint_is_durable_and_idempotent_across_fresh_clients(
    tmp_path, monkeypatch
):
    import backend.ledger.api as ledger_api

    lease_store = InMemoryLeaseStore(id_factory=lambda prefix: f"{prefix}-terminal")
    monkeypatch.setattr(ledger_api, "_lease_store", lease_store)
    monkeypatch.delenv("HUNT_DB_URL", raising=False)
    client, service = _client(tmp_path)
    client.post("/api/ledger/agents", json={"agent_id": "agent-terminal"})
    client.post(
        "/api/ledger/lanes",
        json={"lane_id": "lane-terminal", "agent_id": "agent-terminal"},
    )
    client.post(
        "/api/ledger/sessions",
        json={
            "session_id": "session-terminal",
            "agent_id": "agent-terminal",
            "lane_id": "lane-terminal",
        },
    )
    claim = client.post(
        "/api/ledger/leases/claim",
        json={
            "agent_id": "agent-terminal",
            "lane_id": "lane-terminal",
            "session_id": "session-terminal",
            "actor": {"type": "agent", "id": "agent-terminal", "surface": "mcp"},
        },
    )
    lease_id = claim.json()["lease"]["lease_id"]
    body = {
        "agent_id": "agent-terminal",
        "session_id": "session-terminal",
        "lease_id": lease_id,
        "event_type": "lane.finished",
        "reason": "done",
        "result": {"filled": 12},
        "actor": {"type": "agent", "id": "agent-terminal", "surface": "mcp"},
    }

    first = client.post("/api/ledger/lanes/lane-terminal/terminal", json=body)
    fresh_client = TestClient(client.app)
    second = fresh_client.post("/api/ledger/lanes/lane-terminal/terminal", json=body)

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json() == first.json()
    assert first.json()["terminal"]["status"] == "complete"
    marker_path = Path(first.json()["terminal"]["marker_path"])
    assert marker_path.exists()
    assert marker_path.is_relative_to(service.root)
    events = client.get("/api/ledger/sessions/session-terminal").json()["events"]
    assert [event["event_type"] for event in events].count("lane.finished") == 1
    assert [event["event_type"] for event in events].count("lease.released") == 1


def test_lane_terminal_retry_after_event_before_marker_crash_does_not_duplicate(
    tmp_path, monkeypatch
):
    import backend.ledger.api as ledger_api

    client, _service, body = _terminal_lane_fixture(tmp_path, monkeypatch, "event-crash")
    original_save = ledger_api._save_terminal_marker
    saves = 0

    def crash_after_event(path, marker):
        nonlocal saves
        saves += 1
        if saves == 2:
            raise OSError("injected_event_before_marker_crash")
        original_save(path, marker)

    monkeypatch.setattr(ledger_api, "_save_terminal_marker", crash_after_event)
    crashing_client = TestClient(client.app, raise_server_exceptions=False)
    first = crashing_client.post("/api/ledger/lanes/lane-event-crash/terminal", json=body)
    monkeypatch.setattr(ledger_api, "_save_terminal_marker", original_save)
    fresh_client = TestClient(client.app)
    second = fresh_client.post("/api/ledger/lanes/lane-event-crash/terminal", json=body)

    assert first.status_code == 500
    assert second.status_code == 200
    assert second.json()["terminal"]["status"] == "complete"
    events = fresh_client.get("/api/ledger/sessions/session-event-crash").json()["events"]
    assert [event["event_type"] for event in events].count("lane.finished") == 1


def test_lane_terminal_retry_after_release_before_final_marker_returns_complete(
    tmp_path, monkeypatch
):
    import backend.ledger.api as ledger_api

    client, _service, body = _terminal_lane_fixture(tmp_path, monkeypatch, "release-crash")
    original_save = ledger_api._save_terminal_marker
    saves = 0

    def crash_after_release(path, marker):
        nonlocal saves
        saves += 1
        if saves == 3:
            raise OSError("injected_release_before_marker_crash")
        original_save(path, marker)

    monkeypatch.setattr(ledger_api, "_save_terminal_marker", crash_after_release)
    crashing_client = TestClient(client.app, raise_server_exceptions=False)
    first = crashing_client.post("/api/ledger/lanes/lane-release-crash/terminal", json=body)
    monkeypatch.setattr(ledger_api, "_save_terminal_marker", original_save)
    fresh_client = TestClient(client.app)
    second = fresh_client.post("/api/ledger/lanes/lane-release-crash/terminal", json=body)

    assert first.status_code == 500
    assert second.status_code == 200
    assert second.json()["terminal"]["status"] == "complete"
    events = fresh_client.get("/api/ledger/sessions/session-release-crash").json()["events"]
    assert [event["event_type"] for event in events].count("lane.finished") == 1
    assert [event["event_type"] for event in events].count("lease.released") == 1


def test_lane_terminal_marker_redacts_reason_and_result_before_persistence(tmp_path, monkeypatch):
    client, service, body = _terminal_lane_fixture(tmp_path, monkeypatch, "redacted")
    body["reason"] = "candidate@example.com called 303-555-1212"
    body["result"] = {
        "token": "secret-terminal-token",
        "answer": "private questionnaire answer",
    }

    response = client.post("/api/ledger/lanes/lane-redacted/terminal", json=body)

    assert response.status_code == 200
    marker_path = service.get_session_directory("session-redacted") / "lane-terminal.json"
    serialized = marker_path.read_text(encoding="utf-8")
    assert "candidate@example.com" not in serialized
    assert "303-555-1212" not in serialized
    assert "secret-terminal-token" not in serialized
    assert response.json()["terminal"]["result"]["token"] == "[REDACTED]"


def test_lane_terminal_retry_after_marker_crash_rejects_changed_canonical_payload(
    tmp_path, monkeypatch
):
    import backend.ledger.api as ledger_api

    client, _service, body = _terminal_lane_fixture(tmp_path, monkeypatch, "changed-retry")
    body["reason"] = "original reason"
    body["result"] = {"filled": 1}
    original_save = ledger_api._save_terminal_marker
    saves = 0

    def crash_after_initial_marker(path, marker):
        nonlocal saves
        saves += 1
        original_save(path, marker)
        if saves == 1:
            raise OSError("injected_after_initial_marker")

    monkeypatch.setattr(ledger_api, "_save_terminal_marker", crash_after_initial_marker)
    crashing_client = TestClient(client.app, raise_server_exceptions=False)
    first = crashing_client.post("/api/ledger/lanes/lane-changed-retry/terminal", json=body)
    monkeypatch.setattr(ledger_api, "_save_terminal_marker", original_save)
    changed = {
        **body,
        "reason": "changed retry reason",
        "result": {"filled": 999, "unexpected": True},
    }
    second = client.post("/api/ledger/lanes/lane-changed-retry/terminal", json=changed)

    assert first.status_code == 500
    assert second.status_code == 409
    assert second.json()["detail"] == {
        "reason_code": "lane_terminal_conflict",
        "field": "terminal_payload",
    }
    events = client.get("/api/ledger/sessions/session-changed-retry").json()["events"]
    assert [event["event_type"] for event in events].count("lane.finished") == 0


def test_lane_terminal_marker_strictly_redacts_candidate_value_like_fields(tmp_path, monkeypatch):
    client, service, body = _terminal_lane_fixture(tmp_path, monkeypatch, "strict-redaction")
    body["result"] = {
        "answer": "arbitrary secret questionnaire response",
        "value": "arbitrary private input",
        "content": "arbitrary cover letter body",
        "address": "123 Secret Street Apartment 9",
        "nested": {"candidate_answer": "another private response"},
        "filled": 4,
    }

    response = client.post("/api/ledger/lanes/lane-strict-redaction/terminal", json=body)

    assert response.status_code == 200
    marker_path = service.get_session_directory("session-strict-redaction") / "lane-terminal.json"
    serialized = marker_path.read_text(encoding="utf-8")
    for secret in (
        "arbitrary secret questionnaire response",
        "arbitrary private input",
        "arbitrary cover letter body",
        "123 Secret Street Apartment 9",
        "another private response",
    ):
        assert secret not in serialized
    result = response.json()["terminal"]["result"]
    assert result["answer"] == "[REDACTED]"
    assert result["nested"]["candidate_answer"] == "[REDACTED]"
    assert result["filled"] == 4


@pytest.mark.parametrize("contents", ["{not-json", "x" * 70_000], ids=["malformed", "oversized"])
def test_lane_terminal_corrupt_marker_returns_bounded_typed_error(tmp_path, monkeypatch, contents):
    client, service, body = _terminal_lane_fixture(tmp_path, monkeypatch, "corrupt-marker")
    marker_path = service.get_session_directory("session-corrupt-marker") / "lane-terminal.json"
    marker_path.write_text(contents, encoding="utf-8")

    response = client.post("/api/ledger/lanes/lane-corrupt-marker/terminal", json=body)

    assert response.status_code == 409
    assert response.json()["detail"] == {"reason_code": "lane_terminal_marker_invalid"}


def _terminal_lane_fixture(tmp_path, monkeypatch, suffix):
    import backend.ledger.api as ledger_api

    lease_store = InMemoryLeaseStore(id_factory=lambda prefix: f"{prefix}-{suffix}")
    monkeypatch.setattr(ledger_api, "_lease_store", lease_store)
    monkeypatch.delenv("HUNT_DB_URL", raising=False)
    client, service = _client(tmp_path)
    agent_id = f"agent-{suffix}"
    lane_id = f"lane-{suffix}"
    session_id = f"session-{suffix}"
    client.post("/api/ledger/agents", json={"agent_id": agent_id})
    client.post("/api/ledger/lanes", json={"lane_id": lane_id, "agent_id": agent_id})
    client.post(
        "/api/ledger/sessions",
        json={"session_id": session_id, "agent_id": agent_id, "lane_id": lane_id},
    )
    claim = client.post(
        "/api/ledger/leases/claim",
        json={
            "agent_id": agent_id,
            "lane_id": lane_id,
            "session_id": session_id,
            "actor": {"type": "agent", "id": agent_id, "surface": "mcp"},
        },
    )
    body = {
        "agent_id": agent_id,
        "session_id": session_id,
        "lease_id": claim.json()["lease"]["lease_id"],
        "event_type": "lane.finished",
        "reason": "done",
        "actor": {"type": "agent", "id": agent_id, "surface": "mcp"},
    }
    return client, service, body
