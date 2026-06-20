import json
import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import backend.c3_commands as c3_commands
from backend.ledger.leases import InMemoryLeaseStore
from backend.ledger.models import Actor
from backend.ledger.service import LedgerService


def _client(tmp_path):
    app = FastAPI()
    service = LedgerService(tmp_path / "ledger")
    lease_store = InMemoryLeaseStore(id_factory=lambda prefix: f"{prefix}-test")
    app.include_router(c3_commands.router)
    app.dependency_overrides[c3_commands.get_ledger_service] = lambda: service
    app.dependency_overrides[c3_commands.get_lease_store] = lambda: lease_store
    app.dependency_overrides[c3_commands.require_ledger_access] = lambda: None
    return TestClient(app), service, lease_store


def _actor(agent_id="agent-cmd"):
    return Actor(type="agent", id=agent_id, surface="mcp")


def _payload(lease_id="lease-test", agent_id="agent-cmd"):
    return {
        "command_name": "c3.inspect_fields",
        "command_id": "cmd-001",
        "trace_id": "trace-001",
        "agent_id": agent_id,
        "lane_id": "lane-cmd",
        "session_id": "session-cmd",
        "lease_id": lease_id,
        "target": {
            "browser_kind": "chrome",
            "debug_port": 9222,
            "extension_id": "ext-abc",
            "tab_id": 123,
            "url": "https://jobs.example/apply?token=secret-token",
            "raw_form_value": "secret form value",
        },
        "reason": "Inspect visible fields before deciding fill strategy.",
    }


def _claim_lease(lease_store, agent_id="agent-cmd"):
    claim = lease_store.claim_session_mutation_lease(
        "lane-cmd",
        "session-cmd",
        _actor(agent_id),
        ttl_seconds=60,
    )
    return claim.lease.lease_id


def _session_events(service):
    return service.get_session_log("session-cmd")["events"]


def test_c3_command_run_valid_request_executes_bridge_and_returns_receipt(tmp_path, monkeypatch):
    client, service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store)
    seen = {}

    def fake_bridge(target, payload):
        seen["target"] = target
        seen["payload"] = payload
        return {
            "ok": True,
            "fieldCount": 2,
            "commandReceipt": {
                "commandId": payload["command_id"],
                "traceId": payload["trace_id"],
                "command": payload["command_name"],
                "ok": True,
            },
        }

    monkeypatch.setattr(c3_commands, "run_c3_extension_command", fake_bridge)

    response = client.post("/api/c3/commands/run", json=_payload(lease_id))

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "accepted"
    assert body["reason_code"] == "browser_execution_completed"
    assert body["execution"] == {"attempted": True, "bridge": "playwright_cdp"}
    assert body["commandReceipt"]["commandId"] == "cmd-001"
    assert body["receipt"] == {
        "command_id": "cmd-001",
        "trace_id": "trace-001",
        "command_name": "c3.inspect_fields",
        "status": "accepted",
        "ok": True,
        "reason_code": "browser_execution_completed",
        "message": "",
        "filled_field_count": 0,
        "pending_llm_field_count": 0,
        "manual_review_required": False,
    }
    assert seen["target"]["extension_id"] == "ext-abc"
    assert seen["payload"]["command_name"] == "c3.inspect_fields"
    assert seen["payload"]["command_payload"]["tabId"] == 123
    assert body["ledger_event_id"].startswith("evt-")

    events = _session_events(service)
    assert events[-1]["event_type"] == "command.requested"
    assert events[-1]["agent_id"] == "agent-cmd"
    assert events[-1]["lane_id"] == "lane-cmd"
    assert events[-1]["session_id"] == "session-cmd"
    assert events[-1]["lease_id"] == lease_id
    assert events[-1]["command_id"] == "cmd-001"
    assert events[-1]["trace_id"] == "trace-001"
    assert events[-1]["payload"]["command_name"] == "c3.inspect_fields"
    assert events[-1]["payload"]["status"] == "accepted"
    assert events[-1]["payload"]["target"]["url"] == "https://jobs.example/apply"

    log_path = Path(service.get_session_log("session-cmd")["log_path"])
    serialized = log_path.read_text(encoding="utf-8")
    assert "secret-token" not in serialized
    assert "secret form value" not in serialized


def test_c3_command_run_bridge_error_returns_502(tmp_path, monkeypatch):
    client, _service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store)

    def fake_bridge(_target, _payload):
        raise c3_commands.C3BrowserBridgeError("extension_options_page_not_found")

    monkeypatch.setattr(c3_commands, "run_c3_extension_command", fake_bridge)

    response = client.post("/api/c3/commands/run", json=_payload(lease_id))

    assert response.status_code == 502
    assert response.json()["status"] == "rejected"
    assert response.json()["reason_code"] == "extension_options_page_not_found"


def test_c3_command_run_rejects_unknown_command_and_logs_request(tmp_path):
    client, service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store)
    payload = _payload(lease_id)
    payload["command_name"] = "c3.nope"

    response = client.post("/api/c3/commands/run", json=payload)

    assert response.status_code == 400
    assert response.json()["status"] == "rejected"
    assert response.json()["reason_code"] == "unknown_command"
    event = _session_events(service)[-1]
    assert event["event_type"] == "command.requested"
    assert event["payload"]["status"] == "rejected"
    assert event["payload"]["reason_code"] == "unknown_command"


def test_c3_command_run_rejects_registered_but_unexposed_command(tmp_path):
    client, service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store)
    payload = _payload(lease_id)
    payload["command_name"] = "c3.page_walk"

    response = client.post("/api/c3/commands/run", json=payload)

    assert response.status_code == 400
    assert response.json()["reason_code"] == "unsupported_command_route"
    event = _session_events(service)[-1]
    assert event["payload"]["reason_code"] == "unsupported_command_route"


def test_c3_command_catalog_marks_page_walk_not_directly_executable(tmp_path):
    client, _service, _lease_store = _client(tmp_path)

    response = client.get("/api/c3/commands/catalog")

    assert response.status_code == 200
    commands = {entry["command_name"]: entry for entry in response.json()["commands"]}
    assert commands["c3.inspect_fields"]["executable"] is True
    assert commands["c3.page_walk"]["executable"] is False
    assert commands["c3.fill_page"]["mutates_page"] is True


def test_c3_command_run_rejects_missing_target_and_logs_request(tmp_path):
    client, service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store)
    payload = _payload(lease_id)
    payload["target"] = {"browser_kind": "chrome"}

    response = client.post("/api/c3/commands/run", json=payload)

    assert response.status_code == 400
    assert response.json()["reason_code"] == "missing_target"
    event = _session_events(service)[-1]
    assert event["payload"]["status"] == "rejected"
    assert event["payload"]["reason_code"] == "missing_target"


def test_c3_command_run_rejects_missing_lease_and_logs_request(tmp_path):
    client, service, _lease_store = _client(tmp_path)

    response = client.post("/api/c3/commands/run", json=_payload(""))

    assert response.status_code == 400
    assert response.json()["reason_code"] == "missing_lease"
    event = _session_events(service)[-1]
    assert event["lease_id"] == ""
    assert event["payload"]["reason_code"] == "missing_lease"


def test_c3_command_run_rejects_bad_actor_for_other_agent_lease(tmp_path):
    client, service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store, agent_id="agent-owner")
    payload = _payload(lease_id, agent_id="agent-other")

    response = client.post("/api/c3/commands/run", json=payload)

    assert response.status_code == 400
    assert response.json()["reason_code"] == "bad_actor"
    event = service.get_session_log("session-cmd")["events"][-1]
    assert event["agent_id"] == "agent-other"
    assert event["payload"]["reason_code"] == "bad_actor"


def test_c3_command_run_missing_required_ids_returns_422_without_ledger_event(tmp_path):
    client, service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store)
    payload = _payload(lease_id)
    del payload["command_id"]

    response = client.post("/api/c3/commands/run", json=payload)

    assert response.status_code == 422
    assert service.get_session_log("session-cmd")["found"] is False


def test_backend_known_command_names_match_c3_registry_file():
    registry = Path("executioner/src/background/commands/registry.js").read_text(encoding="utf-8")
    registry_names = set(re.findall(r'"(c3\.[a-z0-9_]+)"', registry))

    assert set(c3_commands.C3_COMMAND_REGISTRY) == registry_names
    for command_name in registry_names:
        assert json.dumps(command_name) in registry
