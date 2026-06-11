# Hunt MCP Adapter

`tools/hunt_mcp` is a separate MCP adapter process for Hunt agents. It exposes
ledger, session, lease, and probe tools by calling Hunt backend APIs. The adapter
does not import backend app internals, write ledger JSONL, write the database, or
decide trusted probe paths.

The initial tools are C3-first because the agent command ledger starts with C3,
but the adapter is intentionally component-neutral so later C1/C2/C4 tools can
share the same process and auth shape.

## Runtime Choice

This adapter uses Python because the repo already has Python test/runtime support
and `httpx` in `requirements-dev.txt`. No local `mcp` or `fastmcp` package was
installed when this package was created, so `server.py` implements the small stdio
MCP JSON-RPC surface needed for `initialize`, `tools/list`, and `tools/call`
without adding a new dependency.

## Configuration

Environment variables:

- `HUNT_BACKEND_URL`: backend base URL. Defaults to `http://127.0.0.1:8000`.
- `HUNT_SERVICE_TOKEN`: optional bearer token sent as
  `Authorization: Bearer <token>`.
- `HUNT_MCP_HTTP_TIMEOUT`: HTTP timeout in seconds. Defaults to `30`.

## Run

```powershell
cd tools\hunt_mcp
..\..\.venv\Scripts\python.exe server.py
```

## Tools

- `hunt_ledger_create_agent` -> `POST /api/ledger/agents`
- `hunt_ledger_create_lane` -> `POST /api/ledger/lanes`
- `hunt_ledger_open_session` -> `POST /api/ledger/sessions`
- `hunt_ledger_claim_lease` -> `POST /api/ledger/leases/claim`
- `hunt_ledger_heartbeat_lease` -> `POST /api/ledger/leases/{lease_id}/heartbeat`
- `hunt_ledger_release_lease` -> `POST /api/ledger/leases/{lease_id}/release`
- `hunt_ledger_append_event` -> `POST /api/ledger/events`
- `hunt_ledger_get_active` -> `GET /api/ledger/active`
- `hunt_ledger_get_agent_log` -> `GET /api/ledger/agents/{agent_id}`
- `hunt_ledger_get_session_log` -> `GET /api/ledger/sessions/{session_id}`
- `hunt_c3_write_probe_file` -> `POST /api/ledger/probes`
- `hunt_c3_run_command` -> `POST /api/ledger/events` with
  `event_type=command.requested`

`hunt_c3_write_probe_file` sends probe content and metadata to the backend. The
backend must store the file under the ledger-root policy, record metadata, and
initialize `trusted=false`.

`hunt_c3_run_command` is currently a contract scaffold, not a browser executor.
No backend/browser-control command endpoint exists yet in this repo, so the tool
requires `command_id`, `command_name`, `agent_id`, `session_id`, `lease_id`, and
`reason`, appends an immutable `command.requested` ledger event, and returns a
`recorded_not_executed` receipt with
`bridge_status=missing_backend_browser_control_bridge`. Once a bridge route
exists, this tool should forward the same command request to that endpoint and
preserve the ledger receipt fields.

## Example Flow For Package 08

```text
1. hunt_ledger_create_agent
   {"component":"c3","actor":{"type":"agent","id":"agent-codex-a1b2","surface":"mcp"}}
2. hunt_ledger_create_lane
   {"component":"c3","agent_id":"agent-codex-a1b2","job_url":"https://example/jobs/1"}
3. hunt_ledger_open_session
   {"component":"c3","agent_id":"agent-codex-a1b2","lane_id":"lane-9401","cdp_port":9401}
4. hunt_ledger_claim_lease
   {"component":"c3","agent_id":"agent-codex-a1b2","session_id":"session-abc","lease_type":"session_mutation"}
5. hunt_c3_run_command
   {"command_id":"cmd-123","command_name":"c3.inspect_fields","agent_id":"agent-codex-a1b2","lane_id":"lane-9401","session_id":"session-abc","lease_id":"lease-123","reason":"inspect visible controls before fill","command_payload":{"scope":"visible_controls"}}
6. hunt_ledger_release_lease
   {"lease_id":"lease-123","agent_id":"agent-codex-a1b2","reason":"done"}
```

## Smoke Command For Package 09

With a backend running:

```powershell
$env:HUNT_BACKEND_URL = "http://127.0.0.1:8000"
cd tools\hunt_mcp
..\..\.venv\Scripts\python.exe server.py
```

Expected: the process waits for stdio JSON-RPC messages. Sending a
`tools/list` MCP request returns the tool names above.

## Tests

```powershell
cd tools\hunt_mcp
..\..\.venv\Scripts\python.exe -m pytest tests -q
```
