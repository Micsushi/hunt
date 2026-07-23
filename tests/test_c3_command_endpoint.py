import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
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
            "target_id": "target-job-123",
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


def _command_events(service):
    return [event for event in _session_events(service) if event.get("command_id") == "cmd-001"]


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

    events = _command_events(service)
    assert [event["event_type"] for event in events] == [
        "command.requested",
        "command.started",
        "command.completed",
    ]
    for event in events:
        assert event["agent_id"] == "agent-cmd"
        assert event["lane_id"] == "lane-cmd"
        assert event["session_id"] == "session-cmd"
        assert event["lease_id"] == lease_id
        assert event["command_id"] == "cmd-001"
        assert event["trace_id"] == "trace-001"
        assert event["payload"]["command_name"] == "c3.inspect_fields"
        assert event["payload"]["target"]["url"] == "https://jobs.example/apply"
    assert events[0]["payload"]["status"] == "accepted"
    assert events[1]["payload"]["status"] == "started"
    assert events[2]["payload"]["status"] == "completed"

    log_path = Path(service.get_session_log("session-cmd")["log_path"])
    serialized = log_path.read_text(encoding="utf-8")
    assert "secret-token" not in serialized
    assert "secret form value" not in serialized


def test_c3_command_run_rejects_missing_exact_target_id_before_bridge(tmp_path, monkeypatch):
    client, _service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store)
    bridge_called = False

    def fake_bridge(_target, _payload):
        nonlocal bridge_called
        bridge_called = True
        return {"ok": True, "commandReceipt": {"ok": True}}

    monkeypatch.setattr(c3_commands, "run_c3_extension_command", fake_bridge)
    payload = _payload(lease_id)
    payload["target"].pop("target_id", None)

    response = client.post("/api/c3/commands/run", json=payload)

    assert response.status_code == 400
    assert response.json()["reason_code"] == "missing_target"
    assert bridge_called is False


def test_c3_command_run_owns_reserved_payload_fields_and_strips_nested_bypasses(
    tmp_path, monkeypatch
):
    client, _service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store)
    seen = {}

    def fake_bridge(_target, payload):
        seen.update(payload)
        return {"ok": True, "commandReceipt": {"ok": True}}

    monkeypatch.setattr(c3_commands, "run_c3_extension_command", fake_bridge)
    payload = _payload(lease_id)
    payload["command_payload"] = {
        "operationId": "spoofed-operation",
        "allowSubmit": True,
        "triggeredBy": "spoofed-trigger",
        "fillRunId": "spoofed-run",
        "allowForeground": True,
        "nested": {
            "bringToFront": True,
            "items": [{"fill_run_id": "nested-run", "safe": "kept"}],
        },
    }

    response = client.post("/api/c3/commands/run", json=payload)

    assert response.status_code == 200
    command_payload = seen["command_payload"]
    assert command_payload["operationId"] == "cmd-001"
    assert command_payload["allowSubmit"] is False
    assert command_payload["triggeredBy"] == "mcp_backend_cdp_bridge"
    assert "fillRunId" not in command_payload
    assert "allowForeground" not in command_payload
    assert command_payload["nested"] == {"items": [{"safe": "kept"}]}


@pytest.mark.parametrize(
    "reserved_key",
    [
        "allowSubmit",
        "allow_foreground",
        "bring-to-front",
        "operationId",
        "fill_run_id",
        "runId",
        "capabilities",
        "commandId",
        "trace_id",
        "agentId",
        "lane_id",
        "sessionId",
        "lease_id",
        "browserTargetId",
        "triggeredBy",
        "bridgeTimeoutMs",
    ],
)
def test_backend_strips_every_nested_reserved_control_identity(reserved_key):
    payload = {
        "safe": "kept",
        "nested": {"items": [{reserved_key: "spoofed", "safe": "kept"}]},
    }

    assert c3_commands.sanitize_c3_command_payload(payload) == {
        "safe": "kept",
        "nested": {"items": [{"safe": "kept"}]},
    }


def test_safe_operation_target_persists_registered_cdp_target_pin():
    safe = c3_commands._safe_target(
        {
            "browser_kind": "chrome",
            "debug_port": 9411,
            "extension_id": "ext-1",
            "tab_id": 7,
            "url": "https://example.test/job/1",
            "metadata": {"target_id": "target-job-7"},
        }
    )

    assert safe["target_id"] == "target-job-7"


def test_registered_operation_target_compares_cdp_pin_from_registration_metadata():
    target = {
        "session_id": "session-cmd",
        "agent_id": "agent-cmd",
        "lane_id": "lane-cmd",
        "browser_kind": "chrome",
        "debug_port": 9411,
        "extension_id": "ext-1",
        "options_url": "chrome-extension://ext-1/options.html",
        "tab_id": 7,
        "url": "https://example.test/job/1",
        "metadata": {"target_id": "target-job-7"},
    }
    store = SimpleNamespace(get=lambda _session_id: SimpleNamespace(as_response=lambda: target))
    body = SimpleNamespace(
        session_id="session-cmd",
        agent_id="agent-cmd",
        lane_id="lane-cmd",
        target={"target_id": "target-job-7"},
    )

    selected = c3_commands._registered_operation_target(store, body)

    assert selected["target_id"] == "target-job-7"

    body.target["target_id"] = "target-replaced"
    with pytest.raises(c3_commands.HTTPException) as error:
        c3_commands._registered_operation_target(store, body)
    assert error.value.detail["reason_code"] == "browser_target_selector_mismatch"


def test_compatibility_target_promotes_registered_metadata_pin_for_bridge():
    record = SimpleNamespace(
        as_response=lambda: {
            "debug_port": 9411,
            "extension_id": "ext-1",
            "tab_id": 7,
            "url": "https://example.test/job/1",
            "metadata": {"target_id": "target-job-7"},
        }
    )
    body = SimpleNamespace(session_id="session-cmd", target={})

    target = c3_commands._merged_target(body, SimpleNamespace(get=lambda _key: record))

    assert target["target_id"] == "target-job-7"


def test_c3_command_run_bridge_error_returns_502_and_logs_failure(tmp_path, monkeypatch):
    client, service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store)

    def fake_bridge(_target, _payload):
        raise c3_commands.C3BrowserBridgeError("extension_options_page_not_found")

    monkeypatch.setattr(c3_commands, "run_c3_extension_command", fake_bridge)

    response = client.post("/api/c3/commands/run", json=_payload(lease_id))

    assert response.status_code == 502
    assert response.json()["status"] == "rejected"
    assert response.json()["reason_code"] == "extension_options_page_not_found"
    events = _command_events(service)
    assert [event["event_type"] for event in events] == [
        "command.requested",
        "command.started",
        "command.failed",
    ]
    assert events[-1]["payload"]["status"] == "failed"
    assert events[-1]["payload"]["reason_code"] == "extension_options_page_not_found"


def test_c3_command_run_unexpected_error_returns_500_and_logs_failure(tmp_path, monkeypatch):
    client, service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store)

    def fake_bridge(_target, _payload):
        raise RuntimeError("surprise crash")

    monkeypatch.setattr(c3_commands, "run_c3_extension_command", fake_bridge)

    response = client.post("/api/c3/commands/run", json=_payload(lease_id))

    assert response.status_code == 500
    assert response.json()["status"] == "rejected"
    assert response.json()["reason_code"] == "unexpected_error"
    events = _command_events(service)
    assert [event["event_type"] for event in events] == [
        "command.requested",
        "command.started",
        "command.failed",
    ]
    assert events[-1]["payload"]["status"] == "failed"
    assert events[-1]["payload"]["reason_code"] == "unexpected_error"


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
    assert event["event_type"] == "command.rejected"
    assert event["payload"]["status"] == "rejected"
    assert event["payload"]["reason_code"] == "unknown_command"


def test_c3_command_run_page_walk_executes_bridge(tmp_path, monkeypatch):
    client, service, lease_store = _client(tmp_path)
    lease_id = _claim_lease(lease_store)
    payload = _payload(lease_id)
    payload["command_name"] = "c3.page_walk"
    seen = {}

    def fake_bridge(target, bridge_payload):
        seen["target"] = target
        seen["payload"] = bridge_payload
        return {
            "ok": True,
            "commandReceipt": {
                "commandId": bridge_payload["command_id"],
                "traceId": bridge_payload["trace_id"],
                "command": bridge_payload["command_name"],
                "ok": True,
                "reason": "final_submit_visible",
            },
        }

    monkeypatch.setattr(c3_commands, "run_c3_extension_command", fake_bridge)

    response = client.post("/api/c3/commands/run", json=payload)

    assert response.status_code == 200
    assert response.json()["reason_code"] == "browser_execution_completed"
    assert seen["target"]["extension_id"] == "ext-abc"
    assert seen["payload"]["command_name"] == "c3.page_walk"
    events = _command_events(service)
    assert [event["event_type"] for event in events] == [
        "command.requested",
        "command.started",
        "command.completed",
    ]
    assert events[-1]["payload"]["command_name"] == "c3.page_walk"


def test_c3_command_catalog_marks_page_walk_directly_executable(tmp_path):
    client, _service, _lease_store = _client(tmp_path)

    response = client.get("/api/c3/commands/catalog")

    assert response.status_code == 200
    commands = {entry["command_name"]: entry for entry in response.json()["commands"]}
    assert commands["c3.inspect_fields"]["executable"] is True
    assert commands["c3.page_walk"]["executable"] is True
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
    assert event["event_type"] == "command.rejected"
    assert event["payload"]["status"] == "rejected"
    assert event["payload"]["reason_code"] == "missing_target"


def test_c3_command_run_rejects_missing_lease_and_logs_request(tmp_path):
    client, service, _lease_store = _client(tmp_path)

    response = client.post("/api/c3/commands/run", json=_payload(""))

    assert response.status_code == 400
    assert response.json()["reason_code"] == "missing_lease"
    event = _session_events(service)[-1]
    assert event["event_type"] == "command.rejected"
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
    assert event["event_type"] == "command.rejected"
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


class _ReadOperation:
    def __init__(self):
        self.operation_id = "op-read"
        self.agent_id = "agent-owner"
        self.lease_id = "lease-released"
        self.state = "completed"

    def model_dump(self, **_kwargs):
        return {
            "operation_id": self.operation_id,
            "agent_id": self.agent_id,
            "lease_id": self.lease_id,
            "state": self.state,
        }


class _ReadEvent:
    def __init__(self, seq):
        self.seq = seq

    def model_dump(self, **_kwargs):
        return {"seq": self.seq, "event_type": "operation.progress"}


class _ReadOperationManager:
    def __init__(self):
        self.operation = _ReadOperation()
        self.event_page_calls = []

    def get(self, operation_id):
        assert operation_id == self.operation.operation_id
        return self.operation

    def event_page(self, operation_id, *, after_seq=0, limit=100):
        self.event_page_calls.append((operation_id, after_seq, limit))
        return SimpleNamespace(
            events=(_ReadEvent(after_seq + 1), _ReadEvent(after_seq + 2)),
            next_after_seq=after_seq + 2,
            has_more=True,
            truncated=False,
        )


def _operation_read_client():
    app = FastAPI()
    manager = _ReadOperationManager()
    app.include_router(c3_commands.operations_router)
    app.dependency_overrides[c3_commands.get_c3_operation_manager] = lambda: manager
    app.dependency_overrides[c3_commands.require_ledger_access] = lambda: None
    return TestClient(app), manager


def test_operation_projection_read_requires_exact_stored_owner_even_after_release():
    client, _manager = _operation_read_client()

    wrong_agent = client.get(
        "/api/c3/operations/op-read",
        params={"agent_id": "agent-other", "lease_id": "lease-released"},
    )
    wrong_lease = client.get(
        "/api/c3/operations/op-read",
        params={"agent_id": "agent-owner", "lease_id": "lease-other"},
    )
    released_owner = client.get(
        "/api/c3/operations/op-read",
        params={"agent_id": "agent-owner", "lease_id": "lease-released"},
    )

    assert wrong_agent.status_code == 403
    assert wrong_agent.json()["detail"]["reason_code"] == "operation_identity_mismatch"
    assert wrong_lease.status_code == 403
    assert released_owner.status_code == 200
    assert released_owner.json()["operation"]["state"] == "completed"


def test_operation_event_read_requires_owner_and_returns_bounded_page_contract():
    client, manager = _operation_read_client()

    denied = client.get(
        "/api/c3/operations/op-read/events",
        params={
            "agent_id": "agent-other",
            "lease_id": "lease-released",
            "after_seq": 7,
            "limit": 2,
        },
    )
    allowed = client.get(
        "/api/c3/operations/op-read/events",
        params={
            "agent_id": "agent-owner",
            "lease_id": "lease-released",
            "after_seq": 7,
            "limit": 2,
        },
    )

    assert denied.status_code == 403
    assert allowed.status_code == 200
    assert allowed.json() == {
        "operation_id": "op-read",
        "after_seq": 7,
        "limit": 2,
        "events": [
            {"seq": 8, "event_type": "operation.progress"},
            {"seq": 9, "event_type": "operation.progress"},
        ],
        "next_after_seq": 9,
        "has_more": True,
        "truncated": False,
    }
    assert manager.event_page_calls == [("op-read", 7, 2)]
