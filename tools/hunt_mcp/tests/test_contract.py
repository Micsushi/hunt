from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

from client import HuntBackendConfig, HuntBackendError, HuntLedgerClient  # noqa: E402
from server import handle_request  # noqa: E402


def test_all_tools_are_listed() -> None:
    client = _client_with_transport({})
    response = handle_request({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, client)

    names = {tool["name"] for tool in response["result"]["tools"]}

    assert names == {
        "hunt_ledger_create_agent",
        "hunt_ledger_create_lane",
        "hunt_ledger_open_session",
        "hunt_ledger_claim_lease",
        "hunt_ledger_heartbeat_lease",
        "hunt_ledger_release_lease",
        "hunt_ledger_append_event",
        "hunt_ledger_get_active",
        "hunt_ledger_get_agent_log",
        "hunt_ledger_get_session_log",
        "hunt_c3_write_probe_file",
        "hunt_c3_run_command",
    }


@pytest.mark.parametrize(
    ("tool_name", "arguments", "method", "path"),
    [
        ("hunt_ledger_create_agent", {"agent_id": "agent-codex-a1b2"}, "POST", "/api/ledger/agents"),
        ("hunt_ledger_create_lane", {"lane_id": "lane-9401"}, "POST", "/api/ledger/lanes"),
        (
            "hunt_ledger_open_session",
            {"session_id": "session-abc", "lane_id": "lane-9401"},
            "POST",
            "/api/ledger/sessions",
        ),
        (
            "hunt_ledger_claim_lease",
            {"session_id": "session-abc", "agent_id": "agent-codex-a1b2"},
            "POST",
            "/api/ledger/leases/claim",
        ),
        (
            "hunt_ledger_heartbeat_lease",
            {"lease_id": "lease-123", "agent_id": "agent-codex-a1b2"},
            "POST",
            "/api/ledger/leases/lease-123/heartbeat",
        ),
        (
            "hunt_ledger_release_lease",
            {"lease_id": "lease-123", "reason": "done"},
            "POST",
            "/api/ledger/leases/lease-123/release",
        ),
        (
            "hunt_ledger_append_event",
            {"event_type": "command.started", "component": "c3"},
            "POST",
            "/api/ledger/events",
        ),
        ("hunt_ledger_get_active", {"component": "c3"}, "GET", "/api/ledger/active"),
        (
            "hunt_ledger_get_agent_log",
            {"agent_id": "agent-codex-a1b2"},
            "GET",
            "/api/ledger/agents/agent-codex-a1b2",
        ),
        (
            "hunt_ledger_get_session_log",
            {"session_id": "session-abc"},
            "GET",
            "/api/ledger/sessions/session-abc",
        ),
        (
            "hunt_c3_write_probe_file",
            {
                "component": "c3",
                "agent_id": "agent-codex-a1b2",
                "session_id": "session-abc",
                "filename": "probe.js",
                "content": "console.log('ok')",
            },
            "POST",
            "/api/ledger/probes",
        ),
    ],
)
def test_tool_calls_expected_backend_route(
    tool_name: str,
    arguments: dict[str, Any],
    method: str,
    path: str,
) -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport({"ok": True}, seen)

    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        },
        client,
    )

    body = json.loads(response["result"]["content"][0]["text"])
    assert body == {"ok": True}
    assert len(seen) == 1
    assert seen[0].method == method
    assert seen[0].url.path == path


def test_backend_url_and_token_come_from_config() -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport(
        {"agent_id": "agent-codex-a1b2"},
        seen,
        config=HuntBackendConfig(
            backend_url="http://backend.test:8123",
            service_token="secret-token",
            timeout_seconds=5,
        ),
    )

    client.create_agent({"component": "c3"})

    assert seen[0].url.scheme == "http"
    assert seen[0].url.host == "backend.test"
    assert seen[0].url.port == 8123
    assert seen[0].headers["authorization"] == "Bearer secret-token"


def test_probe_tool_defaults_to_untrusted_and_delegates_storage_to_backend() -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport({"probe_id": "probe-1", "trusted": False}, seen)

    response = client.write_probe_file(
        {
            "component": "c3",
            "agent_id": "agent-codex-a1b2",
            "session_id": "session-abc",
            "filename": "read_dom.js",
            "content": "return document.title",
        }
    )

    assert response == {"probe_id": "probe-1", "trusted": False}
    request_body = json.loads(seen[0].content)
    assert request_body["trusted"] is False
    assert request_body["filename"] == "read_dom.js"
    assert seen[0].url.path == "/api/ledger/probes"


def test_c3_run_command_records_immutable_request_and_missing_bridge_receipt() -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport(
        {
            "event_id": "evt-command",
            "writes": [{"path": "ledger/c3/sessions/session-abc/session.jsonl"}],
        },
        seen,
    )

    response = client.run_c3_command(
        {
            "command_id": "cmd-123",
            "command_name": "c3.inspect_fields",
            "agent_id": "agent-codex-a1b2",
            "lane_id": "lane-9401",
            "session_id": "session-abc",
            "lease_id": "lease-123",
            "trace_id": "trace-abc",
            "reason": "verify current form state",
            "command_payload": {"scope": "visible_controls"},
            "probe_budget_id": "budget-1",
            "metadata": {"batch_id": "batch-2026-06-11"},
        }
    )

    assert response["status"] == "recorded_not_executed"
    assert response["bridge_status"] == "missing_backend_browser_control_bridge"
    assert response["ledger_event"]["event_id"] == "evt-command"
    assert seen[0].url.path == "/api/ledger/events"
    request_body = json.loads(seen[0].content)
    assert request_body == {
        "component": "c3",
        "event_type": "command.requested",
        "actor": {"type": "agent", "id": "agent-codex-a1b2", "surface": "mcp"},
        "agent_id": "agent-codex-a1b2",
        "lane_id": "lane-9401",
        "session_id": "session-abc",
        "lease_id": "lease-123",
        "command_id": "cmd-123",
        "trace_id": "trace-abc",
        "payload": {
            "command_name": "c3.inspect_fields",
            "command_payload": {"scope": "visible_controls"},
            "reason": "verify current form state",
            "requested_via": "hunt_mcp.hunt_c3_run_command",
            "bridge_status": "missing_backend_browser_control_bridge",
            "execution_status": "not_executed",
            "metadata": {"batch_id": "batch-2026-06-11"},
            "probe_budget_id": "budget-1",
        },
    }


def test_c3_run_command_rejects_non_object_command_payload() -> None:
    client = _client_with_transport({})

    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {
                "name": "hunt_c3_run_command",
                "arguments": {
                    "command_id": "cmd-123",
                    "command_name": "c3.fill_page",
                    "agent_id": "agent-codex-a1b2",
                    "session_id": "session-abc",
                    "lease_id": "lease-123",
                    "reason": "fill lane",
                    "command_payload": "not an object",
                },
            },
        },
        client,
    )

    assert response["error"]["message"] == "command_payload must be an object"


def test_backend_error_preserves_lease_block_reason() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={"detail": {"code": "lease_blocked", "lease_id": "lease-owner"}},
            request=request,
        )

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )

    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {
                "name": "hunt_ledger_claim_lease",
                "arguments": {"agent_id": "agent-two", "session_id": "session-abc"},
            },
        },
        client,
    )

    assert response["error"]["data"] == {
        "status_code": 409,
        "reason": {"code": "lease_blocked", "lease_id": "lease-owner"},
    }


def test_client_raises_backend_error_with_reason() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(423, json={"detail": "lease expired"}, request=request)

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(HuntBackendError) as exc:
        client.heartbeat_lease({"lease_id": "lease-123"})

    assert exc.value.status_code == 423
    assert exc.value.reason == "lease expired"


def _client_with_transport(
    response_body: dict[str, Any],
    seen: list[httpx.Request] | None = None,
    config: HuntBackendConfig | None = None,
) -> HuntLedgerClient:
    requests = seen if seen is not None else []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=response_body, request=request)

    return HuntLedgerClient(
        config or HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )
