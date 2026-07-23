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
- operation lifecycle:
  - `hunt_c3_start_operation` -> `POST /api/c3/operations`
  - `hunt_c3_get_operation` -> `GET /api/c3/operations/{operation_id}`
  - `hunt_c3_wait_for_event` polls
    `GET /api/c3/operations/{operation_id}/events?after_seq=N` and the operation
    projection for at most 60 seconds
  - `hunt_c3_cancel_operation` ->
    `POST /api/c3/operations/{operation_id}/cancel`
  - `hunt_c3_retry_operation` ->
    `POST /api/c3/operations/{operation_id}/retry`
- lane lifecycle helpers composed from ledger and target APIs:
  `hunt_c3_bootstrap_lane`, `hunt_c3_finish_lane`, `hunt_c3_fail_lane`,
  `hunt_c3_transfer_lane`, `hunt_c3_heartbeat_lease`
- typed read-only C3 wrappers -> `POST /api/c3/commands/run`:
  `hunt_c3_detect_page`, `hunt_c3_get_progress`, `hunt_c3_snapshot_page`,
  `hunt_c3_inspect_fields`, `hunt_c3_inspect_validation`
- typed mutating C3 wrappers -> `POST /api/c3/operations`:
  `hunt_c3_fill_page`, `hunt_c3_fill_remaining_with_llm`,
  `hunt_c3_page_walk`, `hunt_c3_click_next_after_fill`,
  `hunt_c3_clear_page`, `hunt_c3_cancel_session`
- owned diagnostic control-plane tools:
  - `hunt_c3_run_diagnostic` -> `POST /api/c3/control/diagnostics/run`
  - `hunt_c3_create_probe_budget` -> `POST /api/c3/control/probes`
  - `hunt_c3_execute_probe` -> `POST /api/c3/control/probes/{budget_id}/execute`
  - `hunt_c3_commit_probe` ->
    `POST /api/c3/control/probes/reservations/{reservation_id}/commit`
  - `hunt_c3_get_failure_context` ->
    `GET /api/c3/control/operations/{operation_id}/failure-context`
  - `hunt_c3_list_operation_artifacts` and
    `hunt_c3_download_operation_artifact` read exactly owned operation evidence

`hunt_c3_write_probe_file` sends probe content and metadata to the backend. The
backend must store the file under the ledger-root policy, record metadata, and
initialize `trusted=false`.

`hunt_c3_run_command` is the synchronous compatibility endpoint. It requires
`command_id`, `command_name`, `agent_id`,
`session_id`, `lease_id`, `target_id`, and `reason`, validates `command_payload` as an object,
then forwards the command request to `/api/c3/commands/run`. The MCP adapter
returns the backend receipt JSON as text content without adding
`recorded_not_executed` fields. If the backend endpoint is missing or returns
`not_implemented`, the MCP error preserves the backend status code and `detail`
payload.

Use `hunt_c3_command_catalog` before running unfamiliar commands. Agent mutation
tools never call the compatibility endpoint; they return an operation ID while
browser work continues in the backend. Operation starts require `command_id`,
`trace_id`, `agent_id`, `lane_id`, `session_id`, `lease_id`,
`browser_target_id`, and `reason`. They force `allow_submit=false` and do not
expose a foreground-focus capability. Ordinary operation `capabilities` must be
absent or empty; unknown/escalated capabilities and `c3.final_submit` are
rejected. Reserved safety, ownership, and operation-run keys are also rejected
anywhere inside `command_payload`. `deadline_seconds` is an integer from 1
through 86400.

`hunt_c3_bootstrap_lane` requires `target_id` plus either `debug_port` or `cdp_port`.
The CDP target pin is persisted in browser-target metadata, and compatibility
commands fail closed when it is absent. Operation cancellation
and retry require the explicit owning `agent_id` and `lease_id`. A cancellation
that previously recorded `cancel_failed` can be retried with `redispatch=true`.
If bootstrap cleanup is incomplete, the tool reports both cleanup outcomes and
best-effort appends `lane.bootstrap_cleanup_incomplete` evidence.

Control-plane diagnostic actions are an explicit read-only allowlist. Popup
open/click probes are available only through an owned probe budget; submit,
focus, and arbitrary actions are not tool inputs. All seven control-plane schemas
reject extra properties, and artifact downloads return base64 plus content type
and byte count.

Call `hunt_c3_get_failure_context` first when an operation ends unsuccessfully.
It returns the persisted diagnosis plus bounded action, validation, navigation,
and artifact summaries, and remains readable by the operation's exact stored
`agent_id` and `lease_id` after that lease is released. Use direct browser
control only when the returned context says retained evidence is insufficient.
The tool never exposes the raw operation ledger.

Call `hunt_c3_wait_for_event` with the owning `agent_id`, `lease_id`, and last
observed `after_seq`. The first wait heartbeats immediately, then the cadence is
shared across successive waits at about once every two seconds while event
polling continues independently. It returns as soon as a
newer event exists, the operation reaches a terminal state, or the bounded
timeout expires. Each backend request is clamped to the remaining wait deadline.

Use `hunt_ledger_get_command_timeline` after any command to review immutable
JSONL events for that `command_id`. Use `hunt_ledger_find_recent_failures` when
an agent needs the latest rejected/failed/error events without manually walking
every active log.

## Agent Operation Flow

```text
1. `hunt_c3_bootstrap_lane` registers the explicit agent/lane/session, claims
   the session mutation lease, and attaches the exact p Chrome target.
2. `hunt_c3_fill_page` or another typed mutation wrapper starts an operation.
3. `hunt_c3_wait_for_event` reads events after the last sequence and heartbeats
   the owning lease on an independent two-second cadence.
4. `hunt_c3_cancel_operation` requests cooperative cancellation when needed;
   do not start another mutation until cancellation is acknowledged.
5. `hunt_c3_retry_operation` creates a child operation only when backend policy
   allows retry.
6. `hunt_c3_finish_lane` or `hunt_c3_fail_lane` calls the authenticated atomic
   backend terminal endpoint, which records one durable event and releases the
   lease idempotently across fresh MCP clients.
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
