from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

from client import (  # noqa: E402
    HuntBackendConfig,
    HuntBackendError,
    HuntLedgerClient,
    _bounded_wait_seconds,
)
from server import TOOLS, handle_request  # noqa: E402


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
        "hunt_ledger_get_command_timeline",
        "hunt_ledger_find_recent_failures",
        "hunt_c3_write_probe_file",
        "hunt_c3_register_browser_target",
        "hunt_c3_get_browser_target",
        "hunt_c3_list_browser_targets",
        "hunt_c3_unregister_browser_target",
        "hunt_c3_run_command",
        "hunt_c3_command_catalog",
        "hunt_c3_bootstrap_lane",
        "hunt_c3_start_operation",
        "hunt_c3_get_operation",
        "hunt_c3_get_failure_context",
        "hunt_c3_wait_for_event",
        "hunt_c3_cancel_operation",
        "hunt_c3_retry_operation",
        "hunt_c3_finish_lane",
        "hunt_c3_fail_lane",
        "hunt_c3_transfer_lane",
        "hunt_c3_heartbeat_lease",
        "hunt_c3_detect_page",
        "hunt_c3_inspect_fields",
        "hunt_c3_inspect_validation",
        "hunt_c3_snapshot_page",
        "hunt_c3_get_progress",
        "hunt_c3_fill_page",
        "hunt_c3_fill_remaining_with_llm",
        "hunt_c3_page_walk",
        "hunt_c3_click_next_after_fill",
        "hunt_c3_clear_page",
        "hunt_c3_cancel_session",
        "hunt_c3_run_diagnostic",
        "hunt_c3_create_probe_budget",
        "hunt_c3_execute_probe",
        "hunt_c3_commit_probe",
        "hunt_c3_list_operation_artifacts",
        "hunt_c3_download_operation_artifact",
    }


def test_control_plane_and_cancel_tool_schemas_are_strict() -> None:
    names = (
        "hunt_c3_run_diagnostic",
        "hunt_c3_create_probe_budget",
        "hunt_c3_execute_probe",
        "hunt_c3_commit_probe",
        "hunt_c3_list_operation_artifacts",
        "hunt_c3_download_operation_artifact",
        "hunt_c3_get_failure_context",
        "hunt_c3_cancel_operation",
    )

    assert all(TOOLS[name]["inputSchema"]["additionalProperties"] is False for name in names)
    diagnostic_actions = TOOLS["hunt_c3_run_diagnostic"]["inputSchema"]["properties"]["action"][
        "enum"
    ]
    probe_actions = TOOLS["hunt_c3_execute_probe"]["inputSchema"]["properties"]["action"]["enum"]
    assert "open_owned_popup" not in diagnostic_actions
    assert "open_owned_popup" in probe_actions
    assert {"submit", "focus", "arbitrary"}.isdisjoint(probe_actions)


def test_control_plane_clients_forward_only_exact_owned_contract_fields() -> None:
    identity = {
        "operation_id": "op-1",
        "agent_id": "agent-1",
        "lane_id": "lane-1",
        "session_id": "session-1",
        "lease_id": "lease-1",
    }
    cases = [
        (
            "hunt_c3_run_diagnostic",
            {**identity, "action": "page_info", "options": {}, "ignored": "no"},
            "/api/c3/control/diagnostics/run",
        ),
        (
            "hunt_c3_create_probe_budget",
            {**identity, "budget_id": "budget-1", "attempts": 4, "ignored": "no"},
            "/api/c3/control/probes",
        ),
        (
            "hunt_c3_execute_probe",
            {
                **identity,
                "budget_id": "budget-1",
                "action": "open_owned_popup",
                "reason": "inspect owned popup",
                "expected_predicate": "popup is owned",
                "options": {"selector": "#source"},
                "ignored": "no",
            },
            "/api/c3/control/probes/budget-1/execute",
        ),
        (
            "hunt_c3_commit_probe",
            {
                **identity,
                "reservation_id": "probe-res-1",
                "predicate": "popup is owned",
                "observed": {"popupId": "menu-1"},
                "ignored": "no",
            },
            "/api/c3/control/probes/reservations/probe-res-1/commit",
        ),
    ]

    for tool_name, payload, path in cases:
        seen: list[httpx.Request] = []
        client = _client_with_transport({"ok": True}, seen)
        response = handle_request(
            {
                "jsonrpc": "2.0",
                "id": 81,
                "method": "tools/call",
                "params": {"name": tool_name, "arguments": payload},
            },
            client,
        )
        assert "error" not in response
        assert seen[0].url.path == path
        assert "ignored" not in json.loads(seen[0].content)
        assert all(json.loads(seen[0].content)[key] == value for key, value in identity.items())


@pytest.mark.parametrize("action", ["submit", "focus", "arbitrary", "c3.final_submit"])
def test_control_plane_clients_reject_unsafe_or_arbitrary_actions(action: str) -> None:
    identity = {
        "operation_id": "op-1",
        "agent_id": "agent-1",
        "lane_id": "lane-1",
        "session_id": "session-1",
        "lease_id": "lease-1",
    }
    client = _client_with_transport({})

    with pytest.raises(ValueError, match="action_not_allowed"):
        client.run_c3_diagnostic({**identity, "action": action})
    with pytest.raises(ValueError, match="action_not_allowed"):
        client.execute_c3_probe(
            {
                **identity,
                "budget_id": "budget-1",
                "action": action,
                "reason": "unsafe",
                "expected_predicate": "never",
            }
        )


def test_operation_artifact_clients_preserve_ownership_and_encode_download() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/artifacts"):
            return httpx.Response(200, json={"artifacts": []}, request=request)
        return httpx.Response(
            200,
            content=b"\x89PNG\r\n",
            headers={"content-type": "image/png"},
            request=request,
        )

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )
    owner = {"operation_id": "op-1", "agent_id": "agent-1", "lease_id": "lease-1"}

    client.list_c3_operation_artifacts({**owner, "ignored": "no"})
    downloaded = client.download_c3_operation_artifact(
        {
            **owner,
            "artifact_id": "artifact-1",
            "filename": "screen.png",
            "ignored": "no",
        }
    )

    assert dict(seen[0].url.params) == {"agent_id": "agent-1", "lease_id": "lease-1"}
    assert seen[1].url.path.endswith("/artifacts/artifact-1/files/screen.png")
    assert dict(seen[1].url.params) == {"agent_id": "agent-1", "lease_id": "lease-1"}
    assert downloaded == {
        "filename": "screen.png",
        "content_type": "image/png",
        "size": 6,
        "content_base64": "iVBORw0K",
    }


def test_operation_read_clients_require_and_forward_stored_owner_identity() -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport(
        {
            "operation_id": "op-1",
            "events": [],
            "next_after_seq": 4,
            "has_more": False,
            "truncated": False,
        },
        seen,
    )
    owner = {"operation_id": "op-1", "agent_id": "agent-1", "lease_id": "lease-1"}

    client.get_c3_operation(owner)
    page = client.get_c3_operation_events({**owner, "after_seq": 4, "limit": 25})

    assert dict(seen[0].url.params) == {
        "agent_id": "agent-1",
        "lease_id": "lease-1",
    }
    assert dict(seen[1].url.params) == {
        "agent_id": "agent-1",
        "lease_id": "lease-1",
        "after_seq": "4",
        "limit": "25",
    }
    assert page["next_after_seq"] == 4

    with pytest.raises(ValueError, match="agent_id"):
        client.get_c3_operation({"operation_id": "op-1", "lease_id": "lease-1"})


def test_failure_context_tool_is_strict_and_calls_the_owned_read_endpoint() -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport(
        {"operation_id": "op-1", "context": {"root_cause_code": "ui_element_failed"}},
        seen,
    )
    owner = {"operation_id": "op-1", "agent_id": "agent-1", "lease_id": "lease-1"}

    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 82,
            "method": "tools/call",
            "params": {"name": "hunt_c3_get_failure_context", "arguments": owner},
        },
        client,
    )

    assert "error" not in response
    assert seen[0].method == "GET"
    assert seen[0].url.path == "/api/c3/control/operations/op-1/failure-context"
    assert dict(seen[0].url.params) == {"agent_id": "agent-1", "lease_id": "lease-1"}
    schema = TOOLS["hunt_c3_get_failure_context"]["inputSchema"]
    assert schema["required"] == ["operation_id", "agent_id", "lease_id"]
    assert schema["additionalProperties"] is False

    rejected = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 83,
            "method": "tools/call",
            "params": {
                "name": "hunt_c3_get_failure_context",
                "arguments": {**owner, "raw_ledger": True},
            },
        },
        client,
    )
    assert "unexpected failure-context fields" in rejected["error"]["message"]
    assert len(seen) == 1


@pytest.mark.parametrize(
    ("tool_name", "arguments", "method", "path"),
    [
        (
            "hunt_ledger_create_agent",
            {"agent_id": "agent-codex-a1b2"},
            "POST",
            "/api/ledger/agents",
        ),
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
            "hunt_ledger_get_command_timeline",
            {"command_id": "cmd-abc"},
            "GET",
            "/api/ledger/commands/cmd-abc/timeline",
        ),
        ("hunt_ledger_find_recent_failures", {"limit": 5}, "GET", "/api/ledger/failures/recent"),
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
        (
            "hunt_c3_register_browser_target",
            {
                "agent_id": "agent-codex-a1b2",
                "lane_id": "lane-9401",
                "session_id": "session-abc",
                "extension_id": "ext-abc",
                "cdp_port": 9222,
                "target_id": "target-job-1",
            },
            "POST",
            "/api/c3/browser-targets/register",
        ),
        (
            "hunt_c3_get_browser_target",
            {"session_id": "session-abc"},
            "GET",
            "/api/c3/browser-targets/session-abc",
        ),
        ("hunt_c3_list_browser_targets", {}, "GET", "/api/c3/browser-targets"),
        (
            "hunt_c3_unregister_browser_target",
            {"session_id": "session-abc", "agent_id": "agent-codex-a1b2"},
            "DELETE",
            "/api/c3/browser-targets/session-abc",
        ),
        ("hunt_c3_command_catalog", {}, "GET", "/api/c3/commands/catalog"),
        (
            "hunt_c3_get_operation",
            {
                "operation_id": "op-123",
                "agent_id": "agent-codex-a1b2",
                "lease_id": "lease-123",
            },
            "GET",
            "/api/c3/operations/op-123",
        ),
        (
            "hunt_c3_cancel_operation",
            {"operation_id": "op-123", "agent_id": "agent-codex-a1b2", "reason": "stalled"},
            "POST",
            "/api/c3/operations/op-123/cancel",
        ),
        (
            "hunt_c3_retry_operation",
            {
                "operation_id": "op-123",
                "agent_id": "agent-codex-a1b2",
                "lease_id": "lease-123",
                "reason": "retry",
            },
            "POST",
            "/api/c3/operations/op-123/retry",
        ),
        (
            "hunt_c3_heartbeat_lease",
            {"lease_id": "lease-123", "agent_id": "agent-codex-a1b2"},
            "POST",
            "/api/ledger/leases/lease-123/heartbeat",
        ),
        (
            "hunt_c3_transfer_lane",
            {
                "lease_id": "lease-123",
                "agent_id": "agent-codex-a1b2",
                "target_agent_id": "agent-codex-b2c3",
                "reason": "handoff",
            },
            "POST",
            "/api/ledger/leases/lease-123/transfer",
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


def test_c3_run_command_calls_backend_execution_endpoint_and_returns_receipt() -> None:
    seen: list[httpx.Request] = []
    backend_receipt = {
        "command_id": "cmd-123",
        "command_name": "c3.inspect_fields",
        "status": "executed",
        "receipt_id": "receipt-123",
        "ledger_event": {
            "event_id": "evt-command",
            "writes": [{"path": "ledger/c3/sessions/session-abc/session.jsonl"}],
        },
    }
    client = _client_with_transport(
        backend_receipt,
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
            "target_id": "target-job-1",
            "reason": "verify current form state",
            "command_payload": {"scope": "visible_controls"},
            "probe_budget_id": "budget-1",
            "metadata": {"batch_id": "batch-2026-06-11"},
        }
    )

    assert response == backend_receipt
    assert seen[0].url.path == "/api/c3/commands/run"
    request_body = json.loads(seen[0].content)
    assert request_body == {
        "command_id": "cmd-123",
        "command_name": "c3.inspect_fields",
        "agent_id": "agent-codex-a1b2",
        "lane_id": "lane-9401",
        "session_id": "session-abc",
        "lease_id": "lease-123",
        "trace_id": "trace-abc",
        "target_id": "target-job-1",
        "reason": "verify current form state",
        "command_payload": {"scope": "visible_controls"},
        "target": {
            "browser_kind": "p_chrome",
            "debug_port": None,
            "extension_id": None,
            "options_url": "",
            "tab_id": None,
            "target_id": "target-job-1",
            "url": "",
        },
        "probe_budget_id": "budget-1",
        "metadata": {"batch_id": "batch-2026-06-11"},
    }


@pytest.mark.parametrize(
    ("tool_name", "command_name"),
    [
        ("hunt_c3_detect_page", "c3.detect_page"),
        ("hunt_c3_inspect_fields", "c3.inspect_fields"),
        ("hunt_c3_inspect_validation", "c3.inspect_validation"),
        ("hunt_c3_snapshot_page", "c3.snapshot_page"),
        ("hunt_c3_get_progress", "c3.get_progress"),
    ],
)
def test_read_only_typed_c3_tools_call_backend_command_endpoint(
    tool_name: str, command_name: str
) -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport({"ok": True}, seen)

    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 14,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": {
                    "command_id": "cmd-typed",
                    "agent_id": "agent-codex-a1b2",
                    "lane_id": "lane-9401",
                    "session_id": "session-abc",
                    "lease_id": "lease-123",
                    "trace_id": "trace-typed",
                    "target_id": "target-job-1",
                    "target": {
                        "browser_kind": "p_chrome",
                        "debug_port": 9222,
                        "extension_id": "ext-abc",
                        "target_id": "target-job-1",
                        "url": "https://jobs.example/apply",
                    },
                    "command_payload": {"scope": "visible_controls"},
                },
            },
        },
        client,
    )

    assert json.loads(response["result"]["content"][0]["text"]) == {"ok": True}
    request_body = json.loads(seen[0].content)
    assert seen[0].url.path == "/api/c3/commands/run"
    assert request_body["command_name"] == command_name
    assert request_body["reason"]


@pytest.mark.parametrize(
    ("tool_name", "command_name"),
    [
        ("hunt_c3_fill_page", "c3.fill_page"),
        ("hunt_c3_fill_remaining_with_llm", "c3.fill_remaining_with_llm"),
        ("hunt_c3_page_walk", "c3.page_walk"),
        ("hunt_c3_click_next_after_fill", "c3.click_next_after_fill"),
        ("hunt_c3_clear_page", "c3.clear_page"),
        ("hunt_c3_cancel_session", "c3.cancel_session"),
    ],
)
def test_mutating_typed_c3_tools_start_nonblocking_operations(
    tool_name: str, command_name: str
) -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport({"operation_id": "op-typed", "state": "queued"}, seen)

    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 15,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": {
                    "command_id": "cmd-typed",
                    "agent_id": "agent-codex-a1b2",
                    "lane_id": "lane-9401",
                    "session_id": "session-abc",
                    "lease_id": "lease-123",
                    "trace_id": "trace-typed",
                    "browser_target_id": "target-abc",
                    "reason": "test current page",
                    "command_payload": {"scope": "visible_controls"},
                },
            },
        },
        client,
    )

    assert json.loads(response["result"]["content"][0]["text"]) == {
        "operation_id": "op-typed",
        "state": "queued",
    }
    request_body = json.loads(seen[0].content)
    assert seen[0].url.path == "/api/c3/operations"
    assert request_body["command_name"] == command_name
    assert request_body["allow_submit"] is False
    assert "allow_foreground" not in request_body
    assert "bring_to_front" not in request_body


def test_start_operation_requires_ids_and_defaults_submit_off() -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport({"operation_id": "op-123", "state": "queued"}, seen)

    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 16,
            "method": "tools/call",
            "params": {
                "name": "hunt_c3_start_operation",
                "arguments": {
                    "command_id": "cmd-123",
                    "command_name": "c3.fill_page",
                    "agent_id": "agent-codex-a1b2",
                    "lane_id": "lane-9401",
                    "session_id": "session-abc",
                    "lease_id": "lease-123",
                    "trace_id": "trace-123",
                    "browser_target_id": "target-abc",
                    "reason": "fill page",
                    "command_payload": {},
                },
            },
        },
        client,
    )

    assert json.loads(response["result"]["content"][0]["text"])["operation_id"] == "op-123"
    assert seen[0].url.path == "/api/c3/operations"
    assert json.loads(seen[0].content) == {
        "command_id": "cmd-123",
        "command_name": "c3.fill_page",
        "trace_id": "trace-123",
        "agent_id": "agent-codex-a1b2",
        "lane_id": "lane-9401",
        "session_id": "session-abc",
        "lease_id": "lease-123",
        "browser_target_id": "target-abc",
        "reason": "fill page",
        "command_payload": {},
        "allow_submit": False,
    }


@pytest.mark.parametrize("unsafe_key", ["allow_submit", "allow_foreground", "bring_to_front"])
def test_start_operation_rejects_unsafe_capabilities(unsafe_key: str) -> None:
    client = _client_with_transport({})
    arguments = {
        "command_id": "cmd-123",
        "command_name": "c3.fill_page",
        "agent_id": "agent-codex-a1b2",
        "lane_id": "lane-9401",
        "session_id": "session-abc",
        "lease_id": "lease-123",
        "trace_id": "trace-123",
        "browser_target_id": "target-abc",
        "reason": "fill page",
        unsafe_key: True,
    }

    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 17,
            "method": "tools/call",
            "params": {"name": "hunt_c3_start_operation", "arguments": arguments},
        },
        client,
    )

    assert unsafe_key in response["error"]["message"]


def test_operation_tool_schema_requires_trace_and_browser_target_ids() -> None:
    client = _client_with_transport({})
    response = handle_request({"jsonrpc": "2.0", "id": 18, "method": "tools/list"}, client)
    tools = {tool["name"]: tool for tool in response["result"]["tools"]}

    required = set(tools["hunt_c3_start_operation"]["inputSchema"]["required"])
    assert {"trace_id", "browser_target_id"} <= required
    for name in (
        "hunt_c3_fill_page",
        "hunt_c3_fill_remaining_with_llm",
        "hunt_c3_page_walk",
        "hunt_c3_click_next_after_fill",
        "hunt_c3_clear_page",
        "hunt_c3_cancel_session",
    ):
        assert {"trace_id", "browser_target_id"} <= set(tools[name]["inputSchema"]["required"])


def test_operation_schemas_enforce_deadline_port_and_cancel_lease_contracts() -> None:
    client = _client_with_transport({})
    response = handle_request({"jsonrpc": "2.0", "id": 19, "method": "tools/list"}, client)
    tools = {tool["name"]: tool for tool in response["result"]["tools"]}

    start_deadline = tools["hunt_c3_start_operation"]["inputSchema"]["properties"][
        "deadline_seconds"
    ]
    retry_deadline = tools["hunt_c3_retry_operation"]["inputSchema"]["properties"][
        "deadline_seconds"
    ]
    assert start_deadline == {
        "type": "integer",
        "minimum": 1,
        "maximum": 86_400,
        "default": 600,
    }
    assert retry_deadline == {"type": "integer", "minimum": 1, "maximum": 86_400}

    bootstrap_schema = tools["hunt_c3_bootstrap_lane"]["inputSchema"]
    assert "target_id" in bootstrap_schema["required"]
    assert {tuple(option["required"]) for option in bootstrap_schema["anyOf"]} == {
        ("debug_port",),
        ("cdp_port",),
    }

    run_schema = tools["hunt_c3_run_command"]["inputSchema"]
    assert "target_id" in run_schema["required"]

    cancel_schema = tools["hunt_c3_cancel_operation"]["inputSchema"]
    assert "lease_id" in cancel_schema["required"]
    assert cancel_schema["properties"]["lease_id"] == {"type": "string"}
    assert cancel_schema["properties"]["redispatch"] == {"type": "boolean"}

    wait_schema = tools["hunt_c3_wait_for_event"]["inputSchema"]
    assert {"operation_id", "agent_id", "lease_id"} <= set(wait_schema["required"])
    assert wait_schema["properties"]["limit"] == {
        "type": "integer",
        "minimum": 1,
        "maximum": 500,
        "default": 100,
    }

    get_schema = tools["hunt_c3_get_operation"]["inputSchema"]
    assert get_schema["required"] == ["operation_id", "agent_id", "lease_id"]

    retry_schema = tools["hunt_c3_retry_operation"]["inputSchema"]
    assert {"operation_id", "agent_id", "lease_id", "reason"} <= set(retry_schema["required"])


@pytest.mark.parametrize(
    "capability",
    [
        "allow_submit",
        "final_submit",
        "foreground",
        "focus",
        "bring-to-front",
        "arbitrary_escalation",
    ],
)
def test_start_operation_rejects_every_ordinary_capability_escalation(
    capability: str,
) -> None:
    client = _client_with_transport({})
    payload = {
        "command_id": "cmd-123",
        "command_name": "c3.fill_page",
        "trace_id": "trace-123",
        "agent_id": "agent-codex-a1b2",
        "lane_id": "lane-9401",
        "session_id": "session-abc",
        "lease_id": "lease-123",
        "browser_target_id": "target-abc",
        "reason": "fill page",
        "capabilities": [capability],
    }

    with pytest.raises(ValueError, match="capabilities"):
        client.start_c3_operation(payload)


def test_start_operation_rejects_final_submit_command() -> None:
    client = _client_with_transport({})

    with pytest.raises(ValueError, match="final_submit"):
        client.start_c3_operation(
            {
                "command_id": "cmd-123",
                "command_name": "c3.final_submit",
                "trace_id": "trace-123",
                "agent_id": "agent-codex-a1b2",
                "lane_id": "lane-9401",
                "session_id": "session-abc",
                "lease_id": "lease-123",
                "browser_target_id": "target-abc",
                "reason": "unsafe",
            }
        )


@pytest.mark.parametrize(
    "reserved_key",
    [
        "allowSubmit",
        "allow_foreground",
        "bringToFront",
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
def test_start_operation_rejects_reserved_nested_command_payload_keys(
    reserved_key: str,
) -> None:
    client = _client_with_transport({})

    with pytest.raises(ValueError, match="reserved control key"):
        client.start_c3_operation(
            {
                "command_id": "cmd-123",
                "command_name": "c3.fill_page",
                "trace_id": "trace-123",
                "agent_id": "agent-codex-a1b2",
                "lane_id": "lane-9401",
                "session_id": "session-abc",
                "lease_id": "lease-123",
                "browser_target_id": "target-abc",
                "reason": "fill page",
                "command_payload": {"nested": {reserved_key: "caller-owned"}},
            }
        )


def test_start_operation_omits_empty_capabilities() -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport({"operation_id": "op-123"}, seen)

    client.start_c3_operation(
        {
            "command_id": "cmd-123",
            "command_name": "c3.fill_page",
            "trace_id": "trace-123",
            "agent_id": "agent-codex-a1b2",
            "lane_id": "lane-9401",
            "session_id": "session-abc",
            "lease_id": "lease-123",
            "browser_target_id": "target-abc",
            "reason": "fill page",
            "capabilities": [],
        }
    )

    assert "capabilities" not in json.loads(seen[0].content)


def test_wait_for_event_returns_new_events_and_forwards_after_sequence() -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport(
        {"operation_id": "op-123", "events": [{"seq": 4, "event_type": "field.started"}]},
        seen,
    )

    result = client.wait_for_operation_event(
        {
            "operation_id": "op-123",
            "after_seq": 3,
            "agent_id": "agent-codex-a1b2",
            "lease_id": "lease-123",
            "timeout_seconds": 1,
        }
    )

    assert result["events"][0]["seq"] == 4
    assert seen[1].url.path == "/api/c3/operations/op-123/events"
    assert seen[1].url.params["after_seq"] == "3"
    assert seen[1].url.params["agent_id"] == "agent-codex-a1b2"
    assert seen[1].url.params["lease_id"] == "lease-123"
    assert seen[1].url.params["limit"] == "100"


def test_wait_for_event_advances_through_truncated_empty_pages() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/heartbeat"):
            return httpx.Response(200, json={"ok": True}, request=request)
        if request.url.path.endswith("/events"):
            after_seq = int(request.url.params["after_seq"])
            if after_seq == 3:
                return httpx.Response(
                    200,
                    json={
                        "events": [],
                        "next_after_seq": 5,
                        "has_more": True,
                        "truncated": True,
                    },
                    request=request,
                )
            return httpx.Response(
                200,
                json={
                    "events": [{"seq": 6, "event_type": "field.started"}],
                    "next_after_seq": 6,
                    "has_more": False,
                    "truncated": False,
                },
                request=request,
            )
        raise AssertionError(f"unexpected request: {request.url.path}")

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )

    result = client.wait_for_operation_event(
        {
            "operation_id": "op-123",
            "after_seq": 3,
            "agent_id": "agent-codex-a1b2",
            "lease_id": "lease-123",
            "timeout_seconds": 1,
        }
    )

    assert result["events"] == [{"seq": 6, "event_type": "field.started"}]
    assert [
        request.url.params.get("after_seq")
        for request in seen
        if request.url.path.endswith("/events")
    ] == [
        "3",
        "5",
    ]


def test_wait_for_event_rejects_nonadvancing_truncated_page() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/heartbeat"):
            return httpx.Response(200, json={"ok": True}, request=request)
        return httpx.Response(
            200,
            json={
                "events": [],
                "next_after_seq": 3,
                "has_more": True,
                "truncated": True,
            },
            request=request,
        )

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(RuntimeError, match="operation_event_cursor_not_advancing"):
        client.wait_for_operation_event(
            {
                "operation_id": "op-123",
                "after_seq": 3,
                "agent_id": "agent-codex-a1b2",
                "lease_id": "lease-123",
                "timeout_seconds": 1,
            }
        )


def test_wait_for_event_rejects_unbounded_timeout() -> None:
    client = _client_with_transport({})

    with pytest.raises(ValueError, match="timeout_seconds"):
        client.wait_for_operation_event(
            {
                "operation_id": "op-123",
                "after_seq": 0,
                "agent_id": "agent-codex-a1b2",
                "lease_id": "lease-123",
                "timeout_seconds": 600,
            }
        )


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_wait_for_event_rejects_nonfinite_timeout(value: float) -> None:
    with pytest.raises(ValueError, match="timeout_seconds"):
        _bounded_wait_seconds(value)


def test_wait_for_event_returns_when_operation_is_terminal() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/heartbeat"):
            return httpx.Response(200, json={"ok": True}, request=request)
        if request.url.path.endswith("/events"):
            return httpx.Response(200, json={"events": []}, request=request)
        return httpx.Response(
            200,
            json={"operation": {"operation_id": "op-123", "state": "completed"}},
            request=request,
        )

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )

    result = client.wait_for_operation_event(
        {
            "operation_id": "op-123",
            "after_seq": 7,
            "agent_id": "agent-codex-a1b2",
            "lease_id": "lease-123",
            "timeout_seconds": 1,
        }
    )

    assert result["terminal"] is True
    assert result["timed_out"] is False
    assert result["operation"]["state"] == "completed"
    assert [request.url.path for request in seen] == [
        "/api/ledger/leases/lease-123/heartbeat",
        "/api/c3/operations/op-123/events",
        "/api/c3/operations/op-123",
    ]
    assert dict(seen[-1].url.params) == {
        "agent_id": "agent-codex-a1b2",
        "lease_id": "lease-123",
    }


def test_wait_for_event_heartbeats_lease_and_clamps_each_http_timeout() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/heartbeat"):
            return httpx.Response(200, json={"ok": True}, request=request)
        if request.url.path.endswith("/events"):
            return httpx.Response(
                200,
                json={"operation_id": "op-123", "events": [{"seq": 2}]},
                request=request,
            )
        raise AssertionError(f"unexpected request: {request.url.path}")

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test", timeout_seconds=30),
        transport=httpx.MockTransport(handler),
    )

    result = client.wait_for_operation_event(
        {
            "operation_id": "op-123",
            "after_seq": 1,
            "agent_id": "agent-codex-a1b2",
            "lease_id": "lease-123",
            "timeout_seconds": 0.2,
        }
    )

    assert result["events"] == [{"seq": 2}]
    assert [request.url.path for request in seen] == [
        "/api/ledger/leases/lease-123/heartbeat",
        "/api/c3/operations/op-123/events",
    ]
    for request in seen:
        assert 0 < request.extensions["timeout"]["read"] <= 0.2


def test_wait_for_event_polls_frequently_without_heartbeating_every_poll() -> None:
    seen: list[httpx.Request] = []
    event_polls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal event_polls
        seen.append(request)
        if request.url.path.endswith("/heartbeat"):
            return httpx.Response(200, json={"ok": True}, request=request)
        if request.url.path.endswith("/events"):
            event_polls += 1
            events = [{"seq": 9}] if event_polls == 3 else []
            return httpx.Response(200, json={"events": events}, request=request)
        if request.url.path == "/api/c3/operations/op-123":
            return httpx.Response(200, json={"operation": {"state": "running"}}, request=request)
        raise AssertionError(f"unexpected request: {request.url.path}")

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )

    result = client.wait_for_operation_event(
        {
            "operation_id": "op-123",
            "after_seq": 8,
            "agent_id": "agent-codex-a1b2",
            "lease_id": "lease-123",
            "timeout_seconds": 1,
            "poll_interval_seconds": 0.05,
        }
    )

    assert result["events"] == [{"seq": 9}]
    paths = [request.url.path for request in seen]
    assert paths.count("/api/c3/operations/op-123/events") == 3
    assert paths.count("/api/ledger/leases/lease-123/heartbeat") == 1


def test_successive_waits_share_lease_heartbeat_cadence() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/heartbeat"):
            return httpx.Response(200, json={"ok": True}, request=request)
        if request.url.path.endswith("/events"):
            after_seq = int(request.url.params["after_seq"])
            return httpx.Response(
                200,
                json={"events": [{"seq": after_seq + 1}]},
                request=request,
            )
        raise AssertionError(f"unexpected request: {request.url.path}")

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )
    identity = {
        "operation_id": "op-123",
        "agent_id": "agent-codex-a1b2",
        "lease_id": "lease-123",
        "timeout_seconds": 1,
    }

    client.wait_for_operation_event({**identity, "after_seq": 0})
    client.wait_for_operation_event({**identity, "after_seq": 1})

    paths = [request.url.path for request in seen]
    assert paths.count("/api/ledger/leases/lease-123/heartbeat") == 1


def test_operation_cancel_and_retry_send_only_backend_contract_fields() -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport({"ok": True}, seen)

    client.cancel_c3_operation(
        {
            "operation_id": "op-123",
            "agent_id": "agent-codex-a1b2",
            "lease_id": "lease-123",
            "reason": "stalled",
            "redispatch": True,
            "ignored": "no",
        }
    )
    client.retry_c3_operation(
        {
            "operation_id": "op-123",
            "agent_id": "agent-codex-a1b2",
            "command_id": "cmd-retry",
            "trace_id": "trace-retry",
            "lease_id": "lease-123",
            "reason": "retry terminal operation",
            "deadline_seconds": 120,
            "ignored": "no",
        }
    )

    assert json.loads(seen[0].content) == {
        "agent_id": "agent-codex-a1b2",
        "lease_id": "lease-123",
        "reason": "stalled",
        "redispatch": True,
    }
    assert json.loads(seen[1].content) == {
        "agent_id": "agent-codex-a1b2",
        "command_id": "cmd-retry",
        "trace_id": "trace-retry",
        "lease_id": "lease-123",
        "reason": "retry terminal operation",
        "deadline_seconds": 120,
    }


def test_bootstrap_lane_composes_ledger_target_and_lease_routes() -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport({"ok": True}, seen)

    result = client.bootstrap_lane(
        {
            "agent_id": "agent-codex-a1b2",
            "lane_id": "lane-9401",
            "session_id": "session-abc",
            "extension_id": "ext-abc",
            "debug_port": 9401,
            "target_id": "target-job-1",
            "job_url": "https://jobs.example/apply",
        }
    )

    assert result["ok"] is True
    assert result["browser_target_id"] == "session-abc"
    assert [request.url.path for request in seen] == [
        "/api/ledger/agents",
        "/api/ledger/lanes",
        "/api/ledger/sessions",
        "/api/ledger/leases/claim",
        "/api/c3/browser-targets/register",
    ]
    target_body = json.loads(seen[-1].content)
    assert target_body["metadata"]["target_id"] == "target-job-1"


def test_bootstrap_and_compatibility_command_require_exact_target_id() -> None:
    client = _client_with_transport({"ok": True})

    with pytest.raises(ValueError, match="target_id is required"):
        client.bootstrap_lane(
            {
                "agent_id": "agent-codex-a1b2",
                "lane_id": "lane-9401",
                "session_id": "session-abc",
                "extension_id": "ext-abc",
                "debug_port": 9401,
                "job_url": "https://jobs.example/apply",
            }
        )

    with pytest.raises(ValueError, match="target_id is required"):
        client.run_c3_command(
            {
                "command_id": "cmd-123",
                "command_name": "c3.inspect_fields",
                "agent_id": "agent-codex-a1b2",
                "lane_id": "lane-9401",
                "session_id": "session-abc",
                "lease_id": "lease-123",
                "trace_id": "trace-abc",
                "reason": "inspect",
                "command_payload": {},
            }
        )


def test_bootstrap_lane_compensates_target_and_lease_when_target_registration_fails() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/ledger/leases/claim":
            return httpx.Response(
                200,
                json={"lease": {"lease_id": "lease-123"}},
                request=request,
            )
        if request.url.path == "/api/c3/browser-targets/register":
            return httpx.Response(
                500,
                json={"detail": {"reason_code": "target_registration_failed"}},
                request=request,
            )
        return httpx.Response(200, json={"ok": True}, request=request)

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(HuntBackendError, match="target_registration_failed"):
        client.bootstrap_lane(
            {
                "agent_id": "agent-codex-a1b2",
                "lane_id": "lane-9401",
                "session_id": "session-abc",
                "extension_id": "ext-abc",
                "debug_port": 9401,
                "target_id": "target-job-1",
                "job_url": "https://jobs.example/apply",
            }
        )

    assert [request.url.path for request in seen[-2:]] == [
        "/api/c3/browser-targets/session-abc",
        "/api/ledger/leases/lease-123/release",
    ]


def test_bootstrap_lane_reports_incomplete_cleanup_and_appends_failure_evidence() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/ledger/leases/claim":
            return httpx.Response(
                200,
                json={"lease": {"lease_id": "lease-123"}},
                request=request,
            )
        if request.url.path == "/api/c3/browser-targets/register":
            return httpx.Response(
                500,
                json={"detail": {"reason_code": "target_registration_failed"}},
                request=request,
            )
        if request.url.path == "/api/c3/browser-targets/session-abc":
            return httpx.Response(
                503,
                json={"detail": {"reason_code": "target_cleanup_failed"}},
                request=request,
            )
        if request.url.path == "/api/ledger/leases/lease-123/release":
            return httpx.Response(
                503,
                json={"detail": {"reason_code": "lease_cleanup_failed"}},
                request=request,
            )
        if request.url.path == "/api/ledger/events":
            return httpx.Response(200, json={"event_id": "evt-cleanup"}, request=request)
        return httpx.Response(200, json={"ok": True}, request=request)

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(HuntBackendError) as raised:
        client.bootstrap_lane(
            {
                "agent_id": "agent-codex-a1b2",
                "lane_id": "lane-9401",
                "session_id": "session-abc",
                "extension_id": "ext-abc",
                "debug_port": 9401,
                "target_id": "target-job-1",
            }
        )

    assert raised.value.reason["reason_code"] == "bootstrap_cleanup_incomplete"
    assert raised.value.reason["original_error"]["reason"]["reason_code"] == (
        "target_registration_failed"
    )
    assert (
        raised.value.reason["cleanup"]["unregister_target"]["error"]["reason"]["reason_code"]
        == "target_cleanup_failed"
    )
    assert (
        raised.value.reason["cleanup"]["release_lease"]["error"]["reason"]["reason_code"]
        == "lease_cleanup_failed"
    )
    assert [request.url.path for request in seen[-3:]] == [
        "/api/c3/browser-targets/session-abc",
        "/api/ledger/leases/lease-123/release",
        "/api/ledger/events",
    ]
    evidence = json.loads(seen[-1].content)
    assert evidence["event_type"] == "lane.bootstrap_cleanup_incomplete"
    assert evidence["payload"]["reason_code"] == "bootstrap_cleanup_incomplete"


@pytest.mark.parametrize(
    ("method_name", "event_type"),
    [("finish_lane", "lane.finished"), ("fail_lane", "lane.failed")],
)
def test_terminal_lane_helpers_use_atomic_backend_terminal_endpoint(
    method_name: str, event_type: str
) -> None:
    seen: list[httpx.Request] = []
    client = _client_with_transport({"ok": True}, seen)

    result = getattr(client, method_name)(
        {
            "agent_id": "agent-codex-a1b2",
            "lane_id": "lane-9401",
            "session_id": "session-abc",
            "lease_id": "lease-123",
            "reason": "done",
        }
    )

    assert result["ok"] is True
    assert [request.url.path for request in seen] == [
        "/api/ledger/lanes/lane-9401/terminal",
    ]
    body = json.loads(seen[0].content)
    assert body["event_type"] == event_type
    assert body["agent_id"] == "agent-codex-a1b2"
    assert body["lease_id"] == "lease-123"


def test_terminal_lane_helper_can_retry_atomic_endpoint_from_fresh_client() -> None:
    seen: list[httpx.Request] = []
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        seen.append(request)
        assert request.url.path == "/api/ledger/lanes/lane-9401/terminal"
        attempts += 1
        if attempts == 1:
            return httpx.Response(
                503,
                json={"detail": {"reason_code": "temporary_terminal_failure"}},
                request=request,
            )
        return httpx.Response(200, json={"ok": True, "terminal": {}}, request=request)

    transport = httpx.MockTransport(handler)
    config = HuntBackendConfig(backend_url="http://backend.test")
    client = HuntLedgerClient(config, transport=transport)
    payload = {
        "agent_id": "agent-codex-a1b2",
        "lane_id": "lane-9401",
        "session_id": "session-abc",
        "lease_id": "lease-123",
        "reason": "done",
    }

    with pytest.raises(HuntBackendError, match="temporary_terminal_failure"):
        client.finish_lane(payload)
    fresh_client = HuntLedgerClient(config, transport=transport)
    result = fresh_client.finish_lane(payload)

    assert result["ok"] is True
    assert [request.url.path for request in seen] == [
        "/api/ledger/lanes/lane-9401/terminal",
        "/api/ledger/lanes/lane-9401/terminal",
    ]


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


def test_c3_run_command_rejects_reserved_nested_command_payload_keys() -> None:
    client = _client_with_transport({})

    with pytest.raises(ValueError, match="reserved control key"):
        client.run_c3_command(
            {
                "command_id": "cmd-123",
                "command_name": "c3.detect_page",
                "agent_id": "agent-codex-a1b2",
                "session_id": "session-abc",
                "lease_id": "lease-123",
                "reason": "inspect page",
                "target_id": "target-job-1",
                "command_payload": {"nested": [{"operation_id": "caller-owned"}]},
            }
        )


def test_c3_run_command_preserves_backend_not_implemented_error() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            501,
            json={"detail": {"code": "not_implemented", "endpoint": "/api/c3/commands/run"}},
            request=request,
        )

    client = HuntLedgerClient(
        HuntBackendConfig(backend_url="http://backend.test"),
        transport=httpx.MockTransport(handler),
    )

    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 11,
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
                    "target_id": "target-job-1",
                    "command_payload": {},
                },
            },
        },
        client,
    )

    assert seen[0].url.path == "/api/c3/commands/run"
    assert response["error"]["data"] == {
        "status_code": 501,
        "reason": {"code": "not_implemented", "endpoint": "/api/c3/commands/run"},
    }


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
