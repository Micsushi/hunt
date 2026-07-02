from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parents[1]
MCP_ROOT = REPO_ROOT / "tools" / "hunt_mcp"
DEFAULT_BACKEND_URL = "http://127.0.0.1:8000"
TARGET_REGISTRATION_TOOLS = (
    "hunt_c3_register_browser_target",
    "hunt_c3_register_target",
)
REQUIRED_SESSION_EVENTS = {
    "command.requested",
    "command.started",
    "command.completed",
}


class SmokeFailure(RuntimeError):
    pass


class McpClient:
    def __init__(self, python_exe: str, backend_url: str, service_token: str = "") -> None:
        env = os.environ.copy()
        env["HUNT_BACKEND_URL"] = backend_url
        if service_token:
            env["HUNT_SERVICE_TOKEN"] = service_token
        self._next_id = 1
        self._proc = subprocess.Popen(
            [python_exe, "server.py"],
            cwd=MCP_ROOT,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )

    def close(self) -> None:
        if self._proc.stdin:
            self._proc.stdin.close()
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.terminate()
            self._proc.wait(timeout=5)

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._proc.poll() is not None:
            stderr = self._proc.stderr.read() if self._proc.stderr else ""
            raise SmokeFailure(
                f"MCP server exited early with code {self._proc.returncode}: {stderr}"
            )
        request_id = self._next_id
        self._next_id += 1
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        assert self._proc.stdin is not None
        assert self._proc.stdout is not None
        self._proc.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            stderr = self._proc.stderr.read() if self._proc.stderr else ""
            raise SmokeFailure(f"MCP server returned no response for {method}: {stderr}")
        response = json.loads(line)
        if response.get("id") != request_id:
            raise SmokeFailure(
                f"MCP response id mismatch: expected {request_id}, got {response.get('id')}"
            )
        if "error" in response:
            raise SmokeFailure(f"MCP {method} failed: {response['error']}")
        return response["result"]

    def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        content = result.get("content") or []
        if not content:
            raise SmokeFailure(f"MCP tool {name} returned no content")
        text = content[0].get("text", "")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise SmokeFailure(f"MCP tool {name} returned non-JSON text: {text}") from exc

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        assert self._proc.stdin is not None
        self._proc.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        self._proc.stdin.flush()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report: dict[str, Any] = {
        "ok": False,
        "started_at": iso_stamp(),
        "backend_url": args.backend_url,
        "ids": {},
        "steps": [],
        "proof": {},
        "blockers": [],
    }
    try:
        run_smoke(args, report)
    except SmokeFailure as exc:
        report["blockers"].append(str(exc))
    except Exception as exc:  # pragma: no cover - defensive live-smoke reporting
        report["blockers"].append(f"unexpected smoke error: {type(exc).__name__}: {exc}")
    report["ok"] = not report["blockers"]
    report["finished_at"] = iso_stamp()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


def run_smoke(args: argparse.Namespace, report: dict[str, Any]) -> None:
    check_backend(args.backend_url, args.service_token)
    report["steps"].append({"name": "backend_health", "ok": True})

    stamp = time.strftime("%Y%m%d-%H%M%S")
    agent_id = args.agent_id or f"agent-bridge-smoke-{stamp}"
    lane_id = args.lane_id or f"lane-bridge-smoke-{stamp}"
    session_id = args.session_id or f"session-bridge-smoke-{stamp}"
    command_id = args.command_id or f"cmd-bridge-smoke-{stamp}"
    trace_id = args.trace_id or f"trace-bridge-smoke-{stamp}"
    report["ids"] = {
        "agent_id": agent_id,
        "lane_id": lane_id,
        "session_id": session_id,
        "command_id": command_id,
        "trace_id": trace_id,
    }

    client = McpClient(args.python, args.backend_url, args.service_token)
    try:
        initialize = client.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "hunt-c3-bridge-live-smoke", "version": "0.1.0"},
            },
        )
        client.notify("notifications/initialized")
        report["proof"]["mcp_initialize"] = initialize
        report["steps"].append({"name": "mcp_initialize", "ok": True})

        tools = client.request("tools/list")
        tool_names = {tool["name"] for tool in tools.get("tools", [])}
        report["proof"]["mcp_tools"] = sorted(tool_names)
        report["steps"].append({"name": "mcp_tools_list", "ok": True})

        actor = {"type": "agent", "id": agent_id, "surface": "mcp"}
        agent = client.call_tool(
            "hunt_ledger_create_agent",
            {
                "component": "c3",
                "agent_id": agent_id,
                "actor": actor,
                "metadata": {"smoke": "c3_bridge_live"},
            },
        )
        lane = client.call_tool(
            "hunt_ledger_create_lane",
            {
                "component": "c3",
                "lane_id": lane_id,
                "agent_id": agent_id,
                "actor": actor,
                "metadata": {"smoke": "c3_bridge_live", "job_url": args.job_url},
            },
        )
        session = client.call_tool(
            "hunt_ledger_open_session",
            {
                "component": "c3",
                "session_id": session_id,
                "agent_id": agent_id,
                "lane_id": lane_id,
                "actor": actor,
                "metadata": {
                    "smoke": "c3_bridge_live",
                    "cdp_port": args.cdp_port,
                    "extension_id": args.extension_id,
                    "target_id": args.target_id,
                    "tab_id": args.tab_id,
                },
            },
        )
        report["proof"]["manifests"] = {"agent": agent, "lane": lane, "session": session}
        report["steps"].append({"name": "ledger_agent_lane_session", "ok": True})

        lease_response = client.call_tool(
            "hunt_ledger_claim_lease",
            {
                "component": "c3",
                "lease_type": "session_mutation",
                "agent_id": agent_id,
                "lane_id": lane_id,
                "session_id": session_id,
                "ttl_seconds": args.lease_ttl_seconds,
                "actor": actor,
                "metadata": {"smoke": "c3_bridge_live"},
            },
        )
        lease_id = (lease_response.get("lease") or {}).get("lease_id", "")
        if not lease_id:
            raise SmokeFailure(f"lease claim did not return lease.lease_id: {lease_response}")
        report["ids"]["lease_id"] = lease_id
        report["proof"]["lease"] = lease_response
        report["steps"].append({"name": "session_mutation_lease", "ok": True})

        register_target_if_available(
            client, tool_names, args, report, agent_id, lane_id, session_id, lease_id
        )

        command_payload = {
            "scope": args.inspect_scope,
            "cdp_port": args.cdp_port,
            "extension_id": args.extension_id,
            "target_id": args.target_id,
            "tab_id": args.tab_id,
            "url": args.job_url,
        }
        command_result = client.call_tool(
            "hunt_c3_run_command",
            {
                "command_id": command_id,
                "command_name": "c3.inspect_fields",
                "agent_id": agent_id,
                "lane_id": lane_id,
                "session_id": session_id,
                "lease_id": lease_id,
                "trace_id": trace_id,
                "reason": "Bridge live smoke: verify MCP to backend to extension command path.",
                "command_payload": command_payload,
                "metadata": {"smoke": "c3_bridge_live", "requires_real_bridge": True},
            },
        )
        report["proof"]["command_result"] = command_result
        receipt = find_command_receipt(command_result)
        if not receipt:
            raise SmokeFailure(
                "hunt_c3_run_command did not return a real commandReceipt. "
                "Workers 01-04 likely have not landed or the bridge is still returning ledger-only receipt."
            )
        report["proof"]["commandReceipt"] = receipt
        report["steps"].append({"name": "mcp_command_receipt", "ok": True})

        agent_log = client.call_tool("hunt_ledger_get_agent_log", {"agent_id": agent_id})
        session_log = client.call_tool("hunt_ledger_get_session_log", {"session_id": session_id})
        active = client.call_tool("hunt_ledger_get_active", {})
        report["proof"]["logs"] = {
            "agent_log_path": agent_log.get("log_path"),
            "lane_log_path": (
                ((active.get("active_lanes") or {}).get(lane_id) or {}).get("log_path")
            ),
            "session_log_path": session_log.get("log_path"),
        }
        verify_log_events(session_log, command_id)
        verify_accessible_jsonl_paths(report["proof"]["logs"], command_id, args.ledger_host_root)
        report["steps"].append({"name": "jsonl_agent_lane_session", "ok": True})

        if args.rebuild_index:
            rebuild_result = backend_json(
                args.backend_url, args.service_token, "/api/ledger/rebuild-index", method="POST"
            )
            report["proof"]["postgres_rebuild"] = rebuild_result
        postgres_proof = verify_postgres(args.db_url, session_id, command_id)
        report["proof"]["postgres"] = postgres_proof
        report["steps"].append({"name": "postgres_jsonl_path", "ok": True})
    finally:
        client.close()


def register_target_if_available(
    client: McpClient,
    tool_names: set[str],
    args: argparse.Namespace,
    report: dict[str, Any],
    agent_id: str,
    lane_id: str,
    session_id: str,
    lease_id: str,
) -> None:
    tool_name = next((name for name in TARGET_REGISTRATION_TOOLS if name in tool_names), "")
    if not tool_name:
        if args.require_target_registration:
            raise SmokeFailure(
                "No MCP browser target registration tool found. Expected one of: "
                + ", ".join(TARGET_REGISTRATION_TOOLS)
            )
        report["steps"].append(
            {
                "name": "browser_target_registration",
                "ok": False,
                "skipped": True,
                "reason": "registration tool not present; target metadata will be sent with command payload",
            }
        )
        return
    target = client.call_tool(
        tool_name,
        {
            "component": "c3",
            "agent_id": agent_id,
            "lane_id": lane_id,
            "session_id": session_id,
            "lease_id": lease_id,
            "cdp_port": args.cdp_port,
            "extension_id": args.extension_id,
            "target_id": args.target_id,
            "tab_id": args.tab_id,
            "url": args.job_url,
        },
    )
    report["proof"]["target_registration"] = {"tool": tool_name, "response": target}
    report["steps"].append({"name": "browser_target_registration", "ok": True, "tool": tool_name})


def verify_log_events(session_log: dict[str, Any], command_id: str) -> None:
    if not session_log.get("found"):
        raise SmokeFailure(f"session log not found: {session_log}")
    matching = [
        event
        for event in session_log.get("events", [])
        if event.get("command_id") == command_id
        or (event.get("payload") or {}).get("commandId") == command_id
        or ((event.get("payload") or {}).get("receipt") or {}).get("commandId") == command_id
    ]
    event_types = {event.get("event_type") for event in matching}
    missing = sorted(REQUIRED_SESSION_EVENTS - event_types)
    if missing:
        raise SmokeFailure(
            f"session JSONL is missing command lifecycle events for {command_id}: {missing}; "
            f"saw {sorted(event_types)}"
        )


def verify_accessible_jsonl_paths(
    paths: dict[str, str],
    command_id: str,
    ledger_host_root: str = "",
) -> None:
    missing = [
        name
        for name in ("agent_log_path", "lane_log_path", "session_log_path")
        if not paths.get(name)
    ]
    if missing:
        raise SmokeFailure(f"backend did not expose expected JSONL log paths: {missing}")
    inaccessible = []
    missing_command = []
    for name, raw_path in paths.items():
        path = resolve_jsonl_path(raw_path, ledger_host_root)
        if not path.exists():
            inaccessible.append(f"{name}={raw_path}")
            continue
        text = path.read_text(encoding="utf-8")
        if command_id not in text:
            missing_command.append(f"{name}={raw_path}")
    if inaccessible:
        raise SmokeFailure(
            "JSONL paths are not accessible from this process. Run the smoke on the backend host/container "
            f"or mount the ledger root here: {inaccessible}"
        )
    if missing_command:
        raise SmokeFailure(f"JSONL logs do not contain command_id {command_id}: {missing_command}")


def resolve_jsonl_path(raw_path: str, ledger_host_root: str = "") -> Path:
    path = Path(raw_path)
    if path.exists():
        return path
    if raw_path.startswith("/hunt-ledger/") and ledger_host_root:
        relative = raw_path.removeprefix("/hunt-ledger/").replace("/", os.sep)
        return Path(ledger_host_root) / relative
    return path


def verify_postgres(db_url: str, session_id: str, command_id: str) -> dict[str, Any]:
    if not db_url:
        raise SmokeFailure("HUNT_DB_URL or --db-url is required for Postgres jsonl_path proof")
    try:
        import psycopg2
        import psycopg2.extras
    except ImportError as exc:
        raise SmokeFailure("psycopg2 is required for Postgres jsonl_path proof") from exc

    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) AS session_event_count,
                    COUNT(*) FILTER (WHERE jsonl_path IS NULL OR jsonl_path = '') AS missing_jsonl_path_count
                FROM ledger_events
                WHERE session_id = %s
                """,
                (session_id,),
            )
            summary = dict(cur.fetchone())
            cur.execute(
                """
                SELECT event_id, event_type, command_id, jsonl_path, jsonl_line_number
                FROM ledger_events
                WHERE session_id = %s AND command_id = %s
                ORDER BY created_at, event_type
                """,
                (session_id, command_id),
            )
            command_rows = [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()
    if int(summary["session_event_count"]) == 0:
        raise SmokeFailure(f"Postgres ledger_events has no rows for session_id={session_id}")
    if int(summary["missing_jsonl_path_count"]) != 0:
        raise SmokeFailure(
            f"Postgres rows for session_id={session_id} include missing jsonl_path: {summary}"
        )
    if not command_rows:
        raise SmokeFailure(f"Postgres ledger_events has no rows for command_id={command_id}")
    return {"summary": summary, "command_rows": command_rows}


def find_command_receipt(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        receipt = value.get("commandReceipt")
        if isinstance(receipt, dict):
            return receipt
        payload_receipt = (
            (value.get("payload") or {}).get("receipt")
            if isinstance(value.get("payload"), dict)
            else None
        )
        if isinstance(payload_receipt, dict):
            return payload_receipt
        for nested_key in ("result", "response", "data"):
            nested = value.get(nested_key)
            found = find_command_receipt(nested)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = find_command_receipt(item)
            if found:
                return found
    return None


def check_backend(backend_url: str, service_token: str) -> None:
    try:
        backend_json(backend_url, service_token, "/api/ledger/active")
    except Exception as exc:
        raise SmokeFailure(f"backend ledger API is not reachable at {backend_url}: {exc}") from exc


def backend_json(backend_url: str, service_token: str, path: str, method: str = "GET") -> Any:
    headers = {"Accept": "application/json"}
    if service_token:
        headers["Authorization"] = f"Bearer {service_token}"
    request = Request(backend_url.rstrip("/") + path, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SmokeFailure(f"{method} {path} returned HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise SmokeFailure(f"{method} {path} failed: {exc.reason}") from exc
    return json.loads(body) if body else {"ok": True}


def iso_stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Live smoke for MCP -> backend -> C3 extension command ledger bridge.",
    )
    parser.add_argument(
        "--backend-url", default=os.environ.get("HUNT_BACKEND_URL", DEFAULT_BACKEND_URL)
    )
    parser.add_argument("--service-token", default=os.environ.get("HUNT_SERVICE_TOKEN", ""))
    parser.add_argument("--db-url", default=os.environ.get("HUNT_DB_URL", ""))
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--agent-id", default=os.environ.get("HUNT_C3_AGENT_ID", ""))
    parser.add_argument("--lane-id", default=os.environ.get("HUNT_C3_LANE_ID", ""))
    parser.add_argument("--session-id", default=os.environ.get("HUNT_C3_SESSION_ID", ""))
    parser.add_argument("--command-id", default="")
    parser.add_argument("--trace-id", default="")
    parser.add_argument("--lease-ttl-seconds", type=int, default=300)
    parser.add_argument(
        "--cdp-port", type=int, default=int(os.environ.get("HUNT_C3_CDP_PORT", "9222"))
    )
    parser.add_argument("--extension-id", default=os.environ.get("HUNT_C3_EXTENSION_ID", ""))
    parser.add_argument("--target-id", default=os.environ.get("HUNT_C3_TARGET_ID", ""))
    parser.add_argument("--tab-id", default=os.environ.get("HUNT_C3_TAB_ID", ""))
    parser.add_argument("--job-url", default=os.environ.get("HUNT_C3_JOB_URL", "about:blank"))
    parser.add_argument("--ledger-host-root", default=os.environ.get("HUNT_LEDGER_HOST_ROOT", ""))
    parser.add_argument("--inspect-scope", default="visible_controls")
    parser.add_argument("--rebuild-index", action="store_true")
    parser.add_argument(
        "--allow-missing-target-registration",
        action="store_false",
        dest="require_target_registration",
        help="Allow pre-Worker-01 runs where no MCP target registration tool exists yet.",
    )
    parser.set_defaults(require_target_registration=True)
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(main())
