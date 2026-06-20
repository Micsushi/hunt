from __future__ import annotations

import json
import sys
from collections.abc import Callable
from typing import Any

from client import HuntBackendError, HuntLedgerClient

JsonObject = dict[str, Any]
ToolHandler = Callable[[JsonObject], Any]


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
            "required": ["agent_id", "lane_id", "session_id", "extension_id"],
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
            },
            "additionalProperties": True,
        },
    },
    "hunt_c3_command_catalog": {
        "description": "List C3 command names, mutation flags, and whether each is executable through the bridge.",
        "inputSchema": {"type": "object", "additionalProperties": True},
    },
    "hunt_c3_inspect_fields": {
        "description": "Typed wrapper for c3.inspect_fields through the backend bridge.",
        "inputSchema": {"type": "object", "required": ["command_id", "agent_id", "session_id", "lease_id"], "additionalProperties": True},
    },
    "hunt_c3_inspect_validation": {
        "description": "Typed wrapper for c3.inspect_validation through the backend bridge.",
        "inputSchema": {"type": "object", "required": ["command_id", "agent_id", "session_id", "lease_id"], "additionalProperties": True},
    },
    "hunt_c3_snapshot_page": {
        "description": "Typed wrapper for c3.snapshot_page through the backend bridge.",
        "inputSchema": {"type": "object", "required": ["command_id", "agent_id", "session_id", "lease_id"], "additionalProperties": True},
    },
    "hunt_c3_get_progress": {
        "description": "Typed wrapper for c3.get_progress through the backend bridge.",
        "inputSchema": {"type": "object", "required": ["command_id", "agent_id", "session_id", "lease_id"], "additionalProperties": True},
    },
    "hunt_c3_fill_page": {
        "description": "Typed wrapper for c3.fill_page through the backend bridge.",
        "inputSchema": {"type": "object", "required": ["command_id", "agent_id", "session_id", "lease_id"], "additionalProperties": True},
    },
    "hunt_c3_click_next_after_fill": {
        "description": "Typed wrapper for c3.click_next_after_fill through the backend bridge.",
        "inputSchema": {"type": "object", "required": ["command_id", "agent_id", "session_id", "lease_id"], "additionalProperties": True},
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
        "hunt_c3_inspect_fields": client.inspect_fields,
        "hunt_c3_inspect_validation": client.inspect_validation,
        "hunt_c3_snapshot_page": client.snapshot_page,
        "hunt_c3_get_progress": client.get_progress,
        "hunt_c3_fill_page": client.fill_page,
        "hunt_c3_click_next_after_fill": client.click_next_after_fill,
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
