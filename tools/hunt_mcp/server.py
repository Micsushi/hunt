from __future__ import annotations

import json
import sys
from collections.abc import Callable
from typing import Any

from client import HuntBackendError, HuntLedgerClient

JsonObject = dict[str, Any]
ToolHandler = Callable[[JsonObject], Any]

_OPERATION_REQUIRED = [
    "command_id",
    "trace_id",
    "agent_id",
    "lane_id",
    "session_id",
    "lease_id",
    "browser_target_id",
]
_OPERATION_PROPERTIES: JsonObject = {
    "command_id": {"type": "string"},
    "command_name": {"type": "string"},
    "agent_id": {"type": "string"},
    "lane_id": {"type": "string"},
    "session_id": {"type": "string"},
    "lease_id": {"type": "string"},
    "trace_id": {"type": "string"},
    "reason": {"type": "string"},
    "command_payload": {"type": "object"},
    "target": {"type": "object"},
    "browser_target_id": {"type": "string"},
    "deadline_at": {"type": "string"},
    "deadline_seconds": {
        "type": "integer",
        "minimum": 1,
        "maximum": 86_400,
        "default": 600,
    },
    "capabilities": {
        "type": "array",
        "items": {"type": "string"},
        "maxItems": 0,
    },
    "actor": {"type": "object"},
    "allow_submit": {"type": "boolean", "const": False, "default": False},
}
_CONTROL_IDENTITY_REQUIRED = [
    "operation_id",
    "agent_id",
    "lane_id",
    "session_id",
    "lease_id",
]
_CONTROL_IDENTITY_PROPERTIES: JsonObject = {
    key: {"type": "string", "minLength": 1} for key in _CONTROL_IDENTITY_REQUIRED
}
_READONLY_CONTROL_ACTIONS = [
    "active_element",
    "console_tail",
    "dom_snapshot",
    "failed_request_tail",
    "page_info",
    "popup_ownership",
    "read_attributes",
    "screenshot",
    "target_health",
]
_PROBE_CONTROL_ACTIONS = [
    *_READONLY_CONTROL_ACTIONS,
    "click_owned_option",
    "open_owned_popup",
]


def _typed_command_schema(*, operation: bool) -> JsonObject:
    required = list(_OPERATION_REQUIRED)
    properties = dict(_OPERATION_PROPERTIES)
    if not operation:
        required.append("target_id")
        properties["target_id"] = {"type": "string", "minLength": 1}
    return {
        "type": "object",
        "required": required,
        "properties": properties,
        "additionalProperties": True,
        "x-hunt-execution": "operation" if operation else "synchronous-read",
    }


TOOLS: dict[str, dict[str, Any]] = {
    "hunt_ledger_create_agent": {
        "description": "Create or register a Hunt ledger agent through the backend.",
        "inputSchema": {"type": "object", "additionalProperties": True},
    },
    "hunt_ledger_create_lane": {
        "description": "Create or register a ledger lane through the backend.",
        "inputSchema": {"type": "object", "additionalProperties": True},
    },
    "hunt_ledger_open_session": {
        "description": "Open or register a concrete ledger session through the backend.",
        "inputSchema": {"type": "object", "additionalProperties": True},
    },
    "hunt_ledger_claim_lease": {
        "description": "Claim a lane or session mutation lease through the backend.",
        "inputSchema": {"type": "object", "additionalProperties": True},
    },
    "hunt_ledger_heartbeat_lease": {
        "description": "Heartbeat an active lease through the backend.",
        "inputSchema": {
            "type": "object",
            "required": ["lease_id"],
            "properties": {"lease_id": {"type": "string"}},
            "additionalProperties": True,
        },
    },
    "hunt_ledger_release_lease": {
        "description": "Release an active lease through the backend.",
        "inputSchema": {
            "type": "object",
            "required": ["lease_id"],
            "properties": {"lease_id": {"type": "string"}},
            "additionalProperties": True,
        },
    },
    "hunt_ledger_append_event": {
        "description": "Append an immutable ledger event through the backend.",
        "inputSchema": {"type": "object", "additionalProperties": True},
    },
    "hunt_ledger_get_active": {
        "description": "Get active ledger agents, lanes, sessions, and leases from the backend.",
        "inputSchema": {"type": "object", "additionalProperties": True},
    },
    "hunt_ledger_get_agent_log": {
        "description": "Get one agent log from the backend.",
        "inputSchema": {
            "type": "object",
            "required": ["agent_id"],
            "properties": {"agent_id": {"type": "string"}},
            "additionalProperties": True,
        },
    },
    "hunt_ledger_get_session_log": {
        "description": "Get one session log from the backend.",
        "inputSchema": {
            "type": "object",
            "required": ["session_id"],
            "properties": {"session_id": {"type": "string"}},
            "additionalProperties": True,
        },
    },
    "hunt_ledger_get_command_timeline": {
        "description": "Get immutable ledger events for one command id across active agent/lane/session logs.",
        "inputSchema": {
            "type": "object",
            "required": ["command_id"],
            "properties": {"command_id": {"type": "string"}},
            "additionalProperties": True,
        },
    },
    "hunt_ledger_find_recent_failures": {
        "description": "Find recent failed/rejected/error C3 ledger events for agent debugging.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "component": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "additionalProperties": True,
        },
    },
    "hunt_c3_write_probe_file": {
        "description": "Ask backend to store an untrusted C3 probe file under ledger policy.",
        "inputSchema": {
            "type": "object",
            "required": ["component", "agent_id", "session_id", "filename", "content"],
            "properties": {
                "component": {"type": "string"},
                "agent_id": {"type": "string"},
                "session_id": {"type": "string"},
                "filename": {"type": "string"},
                "content": {"type": "string"},
            },
            "additionalProperties": True,
        },
    },
    "hunt_c3_register_browser_target": {
        "description": "Register the active pChrome/C3 extension target for a ledger session.",
        "inputSchema": {
            "type": "object",
            "required": ["agent_id", "lane_id", "session_id", "extension_id", "target_id"],
            "properties": {
                "agent_id": {"type": "string"},
                "lane_id": {"type": "string"},
                "session_id": {"type": "string"},
                "browser_kind": {"type": "string"},
                "debug_port": {"type": "integer"},
                "cdp_port": {"type": "integer"},
                "extension_id": {"type": "string"},
                "options_url": {"type": "string"},
                "tab_id": {"type": "integer"},
                "target_id": {"type": "string"},
                "url": {"type": "string"},
                "metadata": {"type": "object"},
            },
            "additionalProperties": True,
        },
    },
    "hunt_c3_get_browser_target": {
        "description": "Read the registered browser target for a C3 session.",
        "inputSchema": {
            "type": "object",
            "required": ["session_id"],
            "properties": {"session_id": {"type": "string"}},
            "additionalProperties": True,
        },
    },
    "hunt_c3_list_browser_targets": {
        "description": "List active registered C3 browser targets.",
        "inputSchema": {"type": "object", "additionalProperties": True},
    },
    "hunt_c3_unregister_browser_target": {
        "description": "Unregister a C3 browser target for a session.",
        "inputSchema": {
            "type": "object",
            "required": ["session_id"],
            "properties": {
                "session_id": {"type": "string"},
                "agent_id": {"type": "string"},
                "reason": {"type": "string"},
            },
            "additionalProperties": True,
        },
    },
    "hunt_c3_run_command": {
        "description": "Execute a C3 command through the backend command endpoint.",
        "inputSchema": {
            "type": "object",
            "required": [
                "command_id",
                "command_name",
                "agent_id",
                "session_id",
                "lease_id",
                "reason",
                "target_id",
            ],
            "properties": {
                "command_id": {"type": "string"},
                "command_name": {"type": "string"},
                "agent_id": {"type": "string"},
                "lane_id": {"type": "string"},
                "session_id": {"type": "string"},
                "lease_id": {"type": "string"},
                "trace_id": {"type": "string"},
                "reason": {"type": "string"},
                "command_payload": {"type": "object"},
                "metadata": {"type": "object"},
                "probe_budget_id": {"type": "string"},
                "target_id": {"type": "string"},
            },
            "additionalProperties": True,
        },
    },
    "hunt_c3_command_catalog": {
        "description": "List C3 command names, mutation flags, and whether each is executable through the bridge.",
        "inputSchema": {"type": "object", "additionalProperties": True},
    },
    "hunt_c3_bootstrap_lane": {
        "description": "Register an isolated agent/lane/session, claim its mutation lease, and attach its exact background browser target.",
        "inputSchema": {
            "type": "object",
            "required": ["agent_id", "lane_id", "session_id", "extension_id", "target_id"],
            "properties": {
                "agent_id": {"type": "string"},
                "lane_id": {"type": "string"},
                "session_id": {"type": "string"},
                "parent_session_id": {"type": "string"},
                "extension_id": {"type": "string"},
                "debug_port": {"type": "integer", "minimum": 1, "maximum": 65535},
                "cdp_port": {"type": "integer", "minimum": 1, "maximum": 65535},
                "job_url": {"type": "string"},
                "tab_id": {"type": "integer"},
                "target_id": {"type": "string"},
                "ttl_seconds": {"type": "integer", "minimum": 1},
                "metadata": {"type": "object"},
            },
            "anyOf": [
                {"required": ["debug_port"]},
                {"required": ["cdp_port"]},
            ],
            "additionalProperties": True,
        },
    },
    "hunt_c3_start_operation": {
        "description": "Start a durable nonblocking C3 operation. Final Submit and foreground focus are unavailable.",
        "inputSchema": {
            "type": "object",
            "required": [*_OPERATION_REQUIRED, "command_name", "reason"],
            "properties": dict(_OPERATION_PROPERTIES),
            "additionalProperties": True,
        },
    },
    "hunt_c3_get_operation": {
        "description": "Read one durable C3 operation projection as its stored owner.",
        "inputSchema": {
            "type": "object",
            "required": ["operation_id", "agent_id", "lease_id"],
            "properties": {
                "operation_id": {"type": "string"},
                "agent_id": {"type": "string"},
                "lease_id": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    "hunt_c3_wait_for_event": {
        "description": "Wait a bounded time for operation events or terminal state without controlling the foreground screen.",
        "inputSchema": {
            "type": "object",
            "required": ["operation_id", "agent_id", "lease_id"],
            "properties": {
                "operation_id": {"type": "string"},
                "agent_id": {"type": "string"},
                "lease_id": {"type": "string"},
                "after_seq": {"type": "integer", "minimum": 0, "default": 0},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 500,
                    "default": 100,
                },
                "timeout_seconds": {"type": "number", "minimum": 0, "maximum": 60},
                "poll_interval_seconds": {
                    "type": "number",
                    "minimum": 0.05,
                    "maximum": 2,
                },
            },
            "additionalProperties": False,
        },
    },
    "hunt_c3_cancel_operation": {
        "description": "Request cooperative cancellation for a durable C3 operation.",
        "inputSchema": {
            "type": "object",
            "required": ["operation_id", "agent_id", "lease_id", "reason"],
            "properties": {
                "operation_id": {"type": "string"},
                "agent_id": {"type": "string"},
                "lease_id": {"type": "string"},
                "reason": {"type": "string"},
                "redispatch": {"type": "boolean"},
            },
            "additionalProperties": False,
        },
    },
    "hunt_c3_retry_operation": {
        "description": "Create a child retry for a terminal or cancellation-acknowledged operation.",
        "inputSchema": {
            "type": "object",
            "required": ["operation_id", "agent_id", "lease_id", "reason"],
            "properties": {
                "operation_id": {"type": "string"},
                "agent_id": {"type": "string"},
                "command_id": {"type": "string"},
                "trace_id": {"type": "string"},
                "lease_id": {"type": "string"},
                "reason": {"type": "string"},
                "deadline_at": {"type": "string"},
                "deadline_seconds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 86_400,
                },
            },
            "additionalProperties": False,
        },
    },
    "hunt_c3_finish_lane": {
        "description": "Record successful lane completion and release its mutation lease.",
        "inputSchema": {
            "type": "object",
            "required": ["agent_id", "lane_id", "session_id", "lease_id", "reason"],
            "properties": dict(_OPERATION_PROPERTIES),
            "additionalProperties": True,
        },
    },
    "hunt_c3_fail_lane": {
        "description": "Record terminal lane failure and release its mutation lease.",
        "inputSchema": {
            "type": "object",
            "required": ["agent_id", "lane_id", "session_id", "lease_id", "reason"],
            "properties": dict(_OPERATION_PROPERTIES),
            "additionalProperties": True,
        },
    },
    "hunt_c3_transfer_lane": {
        "description": "Transfer the active lane/session lease to a replacement agent.",
        "inputSchema": {
            "type": "object",
            "required": ["lease_id", "agent_id", "target_agent_id", "reason"],
            "properties": {
                "lease_id": {"type": "string"},
                "agent_id": {"type": "string"},
                "target_agent_id": {"type": "string"},
                "reason": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    "hunt_c3_heartbeat_lease": {
        "description": "Heartbeat the mutation lease owned by a C3 lane agent.",
        "inputSchema": {
            "type": "object",
            "required": ["lease_id", "agent_id"],
            "properties": {
                "lease_id": {"type": "string"},
                "agent_id": {"type": "string"},
                "reason": {"type": "string"},
            },
            "additionalProperties": True,
        },
    },
    "hunt_c3_detect_page": {
        "description": "Typed read-only wrapper for c3.detect_page through the backend bridge.",
        "inputSchema": _typed_command_schema(operation=False),
    },
    "hunt_c3_inspect_fields": {
        "description": "Typed wrapper for c3.inspect_fields through the backend bridge.",
        "inputSchema": _typed_command_schema(operation=False),
    },
    "hunt_c3_inspect_validation": {
        "description": "Typed wrapper for c3.inspect_validation through the backend bridge.",
        "inputSchema": _typed_command_schema(operation=False),
    },
    "hunt_c3_snapshot_page": {
        "description": "Typed wrapper for c3.snapshot_page through the backend bridge.",
        "inputSchema": _typed_command_schema(operation=False),
    },
    "hunt_c3_get_progress": {
        "description": "Typed wrapper for c3.get_progress through the backend bridge.",
        "inputSchema": _typed_command_schema(operation=False),
    },
    "hunt_c3_fill_page": {
        "description": "Typed nonblocking operation wrapper for c3.fill_page.",
        "inputSchema": _typed_command_schema(operation=True),
    },
    "hunt_c3_fill_remaining_with_llm": {
        "description": "Typed nonblocking operation wrapper for c3.fill_remaining_with_llm.",
        "inputSchema": _typed_command_schema(operation=True),
    },
    "hunt_c3_page_walk": {
        "description": "Typed nonblocking operation wrapper for c3.page_walk.",
        "inputSchema": _typed_command_schema(operation=True),
    },
    "hunt_c3_click_next_after_fill": {
        "description": "Typed nonblocking operation wrapper for c3.click_next_after_fill.",
        "inputSchema": _typed_command_schema(operation=True),
    },
    "hunt_c3_clear_page": {
        "description": "Typed nonblocking operation wrapper for c3.clear_page.",
        "inputSchema": _typed_command_schema(operation=True),
    },
    "hunt_c3_cancel_session": {
        "description": "Typed nonblocking operation wrapper for c3.cancel_session.",
        "inputSchema": _typed_command_schema(operation=True),
    },
    "hunt_c3_run_diagnostic": {
        "description": "Run one strictly read-only browser diagnostic for an exactly owned operation.",
        "inputSchema": {
            "type": "object",
            "required": [*_CONTROL_IDENTITY_REQUIRED, "action"],
            "properties": {
                **_CONTROL_IDENTITY_PROPERTIES,
                "action": {"type": "string", "enum": _READONLY_CONTROL_ACTIONS},
                "options": {"type": "object", "default": {}},
            },
            "additionalProperties": False,
        },
    },
    "hunt_c3_create_probe_budget": {
        "description": "Create an exactly owned, bounded probe budget before any diagnostic mutation.",
        "inputSchema": {
            "type": "object",
            "required": ["budget_id", *_CONTROL_IDENTITY_REQUIRED],
            "properties": {
                **_CONTROL_IDENTITY_PROPERTIES,
                "budget_id": {"type": "string", "minLength": 1},
                "attempts": {"type": "integer", "minimum": 1, "maximum": 100},
                "mutations": {"type": "integer", "minimum": 0, "maximum": 10},
                "wall_seconds": {"type": "number", "exclusiveMinimum": 0, "maximum": 600},
                "files": {"type": "integer", "minimum": 0, "maximum": 50},
                "bytes": {"type": "integer", "minimum": 0, "maximum": 10000000},
            },
            "additionalProperties": False,
        },
    },
    "hunt_c3_execute_probe": {
        "description": "Reserve budget and execute one allowlisted probe; only this tool permits bounded popup mutations.",
        "inputSchema": {
            "type": "object",
            "required": [
                "budget_id",
                *_CONTROL_IDENTITY_REQUIRED,
                "action",
                "reason",
                "expected_predicate",
            ],
            "properties": {
                **_CONTROL_IDENTITY_PROPERTIES,
                "budget_id": {"type": "string", "minLength": 1},
                "action": {"type": "string", "enum": _PROBE_CONTROL_ACTIONS},
                "options": {"type": "object", "default": {}},
                "reason": {"type": "string", "minLength": 1},
                "expected_predicate": {"type": "string", "minLength": 1},
            },
            "additionalProperties": False,
        },
    },
    "hunt_c3_commit_probe": {
        "description": "Commit proof for one reservation using the reservation's exact operation ownership.",
        "inputSchema": {
            "type": "object",
            "required": [
                "reservation_id",
                *_CONTROL_IDENTITY_REQUIRED,
                "predicate",
            ],
            "properties": {
                **_CONTROL_IDENTITY_PROPERTIES,
                "reservation_id": {"type": "string", "minLength": 1},
                "predicate": {"type": "string", "minLength": 1},
                "observed": {"type": "object", "default": {}},
            },
            "additionalProperties": False,
        },
    },
    "hunt_c3_list_operation_artifacts": {
        "description": "List diagnostic artifacts for an exactly owned operation.",
        "inputSchema": {
            "type": "object",
            "required": ["operation_id", "agent_id", "lease_id"],
            "properties": {
                "operation_id": {"type": "string", "minLength": 1},
                "agent_id": {"type": "string", "minLength": 1},
                "lease_id": {"type": "string", "minLength": 1},
            },
            "additionalProperties": False,
        },
    },
    "hunt_c3_get_failure_context": {
        "description": "Read the retained, bounded failure explanation for an exactly owned operation before using live browser control.",
        "inputSchema": {
            "type": "object",
            "required": ["operation_id", "agent_id", "lease_id"],
            "properties": {
                "operation_id": {"type": "string", "minLength": 1},
                "agent_id": {"type": "string", "minLength": 1},
                "lease_id": {"type": "string", "minLength": 1},
            },
            "additionalProperties": False,
        },
    },
    "hunt_c3_download_operation_artifact": {
        "description": "Download one owned operation artifact as base64 without controlling the browser screen.",
        "inputSchema": {
            "type": "object",
            "required": [
                "operation_id",
                "agent_id",
                "lease_id",
                "artifact_id",
                "filename",
            ],
            "properties": {
                "operation_id": {"type": "string", "minLength": 1},
                "agent_id": {"type": "string", "minLength": 1},
                "lease_id": {"type": "string", "minLength": 1},
                "artifact_id": {"type": "string", "pattern": "^[A-Za-z0-9_.-]+$"},
                "filename": {"type": "string", "pattern": "^[A-Za-z0-9_.-]+$"},
            },
            "additionalProperties": False,
        },
    },
}


def make_handlers(client: HuntLedgerClient) -> dict[str, ToolHandler]:
    return {
        "hunt_ledger_create_agent": client.create_agent,
        "hunt_ledger_create_lane": client.create_lane,
        "hunt_ledger_open_session": client.open_session,
        "hunt_ledger_claim_lease": client.claim_lease,
        "hunt_ledger_heartbeat_lease": client.heartbeat_lease,
        "hunt_ledger_release_lease": client.release_lease,
        "hunt_ledger_append_event": client.append_event,
        "hunt_ledger_get_active": client.get_active,
        "hunt_ledger_get_agent_log": client.get_agent_log,
        "hunt_ledger_get_session_log": client.get_session_log,
        "hunt_ledger_get_command_timeline": client.get_command_timeline,
        "hunt_ledger_find_recent_failures": client.find_recent_failures,
        "hunt_c3_write_probe_file": client.write_probe_file,
        "hunt_c3_register_browser_target": client.register_browser_target,
        "hunt_c3_get_browser_target": client.get_browser_target,
        "hunt_c3_list_browser_targets": client.list_browser_targets,
        "hunt_c3_unregister_browser_target": client.unregister_browser_target,
        "hunt_c3_run_command": client.run_c3_command,
        "hunt_c3_command_catalog": client.get_c3_command_catalog,
        "hunt_c3_bootstrap_lane": client.bootstrap_lane,
        "hunt_c3_start_operation": client.start_c3_operation,
        "hunt_c3_get_operation": client.get_c3_operation,
        "hunt_c3_wait_for_event": client.wait_for_operation_event,
        "hunt_c3_cancel_operation": client.cancel_c3_operation,
        "hunt_c3_retry_operation": client.retry_c3_operation,
        "hunt_c3_finish_lane": client.finish_lane,
        "hunt_c3_fail_lane": client.fail_lane,
        "hunt_c3_transfer_lane": client.transfer_lane,
        "hunt_c3_heartbeat_lease": client.heartbeat_lease,
        "hunt_c3_detect_page": client.detect_page,
        "hunt_c3_inspect_fields": client.inspect_fields,
        "hunt_c3_inspect_validation": client.inspect_validation,
        "hunt_c3_snapshot_page": client.snapshot_page,
        "hunt_c3_get_progress": client.get_progress,
        "hunt_c3_fill_page": client.fill_page,
        "hunt_c3_fill_remaining_with_llm": client.fill_remaining_with_llm,
        "hunt_c3_page_walk": client.page_walk,
        "hunt_c3_click_next_after_fill": client.click_next_after_fill,
        "hunt_c3_clear_page": client.clear_page,
        "hunt_c3_cancel_session": client.cancel_session,
        "hunt_c3_run_diagnostic": client.run_c3_diagnostic,
        "hunt_c3_create_probe_budget": client.create_c3_probe_budget,
        "hunt_c3_execute_probe": client.execute_c3_probe,
        "hunt_c3_commit_probe": client.commit_c3_probe,
        "hunt_c3_list_operation_artifacts": client.list_c3_operation_artifacts,
        "hunt_c3_get_failure_context": client.get_c3_failure_context,
        "hunt_c3_download_operation_artifact": client.download_c3_operation_artifact,
    }


def handle_request(request: JsonObject, client: HuntLedgerClient) -> JsonObject | None:
    request_id = request.get("id")
    method = request.get("method")
    try:
        if method == "initialize":
            return _result(
                request_id,
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "hunt-mcp", "version": "0.1.0"},
                },
            )
        if method == "notifications/initialized":
            return None
        if method == "tools/list":
            tools = [
                {"name": name, **definition}
                for name, definition in sorted(TOOLS.items(), key=lambda item: item[0])
            ]
            return _result(request_id, {"tools": tools})
        if method == "tools/call":
            return _result(request_id, _call_tool(request.get("params") or {}, client))
        return _error(request_id, -32601, f"Unknown method: {method}")
    except Exception as error:
        return _error(request_id, -32000, str(error), data=_error_data(error))


def _call_tool(params: JsonObject, client: HuntLedgerClient) -> JsonObject:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    if not isinstance(name, str) or name not in TOOLS:
        raise ValueError(f"Unknown tool: {name}")
    if not isinstance(arguments, dict):
        raise ValueError("Tool arguments must be an object")
    handlers = make_handlers(client)
    result = handlers[name](arguments)
    return {"content": [{"type": "text", "text": json.dumps(result, sort_keys=True)}]}


def _result(request_id: Any, result: JsonObject) -> JsonObject:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str, data: JsonObject | None = None) -> JsonObject:
    error: JsonObject = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def _error_data(error: Exception) -> JsonObject | None:
    if isinstance(error, HuntBackendError):
        return {"status_code": error.status_code, "reason": error.reason}
    return None


def serve_stdio(client: HuntLedgerClient | None = None) -> None:
    owned_client = client or HuntLedgerClient()
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            response = handle_request(json.loads(line), owned_client)
            if response is not None:
                print(json.dumps(response), flush=True)
    finally:
        owned_client.close()


if __name__ == "__main__":
    serve_stdio()
