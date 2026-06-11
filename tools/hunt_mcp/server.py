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
    "hunt_c3_run_command": {
        "description": (
            "Record a C3 command request through the ledger. Until a backend/browser-control "
            "bridge exists, this returns a not-executed receipt."
        ),
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
        "hunt_c3_write_probe_file": client.write_probe_file,
        "hunt_c3_run_command": client.run_c3_command,
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
