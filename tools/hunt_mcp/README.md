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
- `hunt_ledger_get_command_timeline` -> `GET /api/ledger/commands/{command_id}/timeline`
- `hunt_ledger_find_recent_failures` -> `GET /api/ledger/failures/recent`
- `hunt_c3_write_probe_file` -> `POST /api/ledger/probes`
- `hunt_c3_register_browser_target` -> `POST /api/c3/browser-targets/register`
- `hunt_c3_get_browser_target` -> `GET /api/c3/browser-targets/{session_id}`
- `hunt_c3_list_browser_targets` -> `GET /api/c3/browser-targets`
- `hunt_c3_unregister_browser_target` -> `DELETE /api/c3/browser-targets/{session_id}`
- `hunt_c3_command_catalog` -> `GET /api/c3/commands/catalog`
- `hunt_c3_run_command` -> `POST /api/c3/commands/run`
- typed C3 wrappers -> `POST /api/c3/commands/run`:
  `hunt_c3_inspect_fields`, `hunt_c3_inspect_validation`,
  `hunt_c3_snapshot_page`, `hunt_c3_get_progress`, `hunt_c3_fill_page`,
  `hunt_c3_click_next_after_fill`

`hunt_c3_write_probe_file` sends probe content and metadata to the backend. The
backend must store the file under the ledger-root policy, record metadata, and
initialize `trusted=false`.

`hunt_c3_run_command` requires `command_id`, `command_name`, `agent_id`,
`session_id`, `lease_id`, and `reason`, validates `command_payload` as an object,
then forwards the command request to `/api/c3/commands/run`. The MCP adapter
returns the backend receipt JSON as text content without adding
`recorded_not_executed` fields. If the backend endpoint is missing or returns
`not_implemented`, the MCP error preserves the backend status code and `detail`
payload.

Use `hunt_c3_command_catalog` before running unfamiliar commands. `c3.page_walk`
is known in the shared registry but currently reports `executable=false` because
the extension receiver does not expose it as a direct bridge route yet.

Use `hunt_ledger_get_command_timeline` after any command to review immutable
JSONL events for that `command_id`. Use `hunt_ledger_find_recent_failures` when
an agent needs the latest rejected/failed/error events without manually walking
every active log.

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
5. hunt_c3_inspect_fields
   {"command_id":"cmd-123","agent_id":"agent-codex-a1b2","lane_id":"lane-9401","session_id":"session-abc","lease_id":"lease-123","command_payload":{"scope":"visible_controls"}}
6. hunt_ledger_get_command_timeline
   {"command_id":"cmd-123"}
7. hunt_ledger_release_lease
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
