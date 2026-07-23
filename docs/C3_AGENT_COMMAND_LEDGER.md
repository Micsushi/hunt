# C3 Agent Command Ledger

This guide is the release-integration checklist and operating contract for the C3 agent command ledger.

## Status

- JSONL remains the source of truth.
- Postgres is a rebuildable index.
- Runtime ledger roots must stay outside the repo. Use `HUNT_LEDGER_ROOT`, or the default user-home path: Windows `%USERPROFILE%\Documents\hunt-logs`; POSIX `~/.hunt/logs`.
- Mutating agent commands require an active session lease unless the actor is a logged human override.
- Probe files must be outside the repo and begin with `trusted=false`.
- Agent mutations run as durable asynchronous operations. Use the operation
  projection/events as truth; never infer success or a stall from process
  stdout.
- Extension heartbeats occur every two seconds. The watchdog records a
  suspected stall after 10 seconds without heartbeat, captures a failure
  bundle at 20 seconds, and requests cancellation at 30 seconds. Cancellation
  is not acknowledged until the active field driver has unwound.
- Ordinary agent tools cannot request final Submit or foreground control.
- Every mutating route requires an exact Chrome `target_id` in addition to the
  session-bound tab ID. The bridge rechecks both identities immediately before
  dispatch and fails closed if Chrome replaced or reused the tab.
- Bridge and cancellation pools have bounded admission. Exhausted capacity is
  reported immediately as `operation_bridge_capacity_exhausted` or
  `cancel_bridge_capacity_exhausted`; it is never hidden behind an unbounded
  executor queue.

## Current MCP Control Surface

### Failure context is the first diagnostic read

After a C3 operation reaches `completed`, `failed`, `cancelled`, or `orphaned`, call
`hunt_c3_get_failure_context` with its exact `operation_id`, `agent_id`, and
`lease_id`. This read remains authorized after the mutation lease is released.
It returns a redacted, bounded packet derived from the append-only event stream:
scope and stable cause code, causal element when proven, last-touched element,
expected versus observed state, validation and evidence IDs, artifact summaries,
confidence, missing evidence, and whether live inspection is still required.

`diagnosis.json` is an atomic projection beside `operation.json`; it is never a
second source of truth. The first terminal lifecycle event owns state, result,
error, terminal reason, and cause. Later monitor or artifact events may refresh
monitor/artifact summaries, but cannot replace that cause. A causal element is
the element proved to have failed; `last_touched_element` is context only and
must not be blamed automatically.

The operation projection retains the first terminal event ID/type/sequence so a
missing or corrupt diagnosis can be rebuilt from bounded evidence without
changing terminal authority. Event pagination is writer-locked, cursor indexed,
and byte bounded. Operation events and projections remove applicant answers,
raw values, and DOM/HTML before persistence; reports retain only structural UI
identity, expected/observed state, and bounded evidence references.

Use direct Playwright/browser inspection only when the packet says
`live_inspection_required=true`, names missing evidence, or the packet retrieval
itself has an explicit unavailable/error status. Do not re-open every site merely
to reconstruct facts C3 already retained.

The MCP adapter exposes the full C3 lifecycle:

- bootstrap agent/lane/session, claim/heartbeat/release or transfer the lease,
  and register the isolated browser target;
- start, inspect, wait for, cancel, redispatch cancellation, and retry durable
  C3 operations;
- typed wrappers for every registered C3 command, including `c3.page_walk`,
  progress, field/validation inspection, and page snapshot;
- read-only browser diagnostics plus budgeted owned-popup probes;
- failure-artifact listing and downloads;
- durable idempotent lane finish/fail helpers.

Diagnostics never navigate, focus, type, evaluate arbitrary JavaScript, or
click arbitrary elements. The only mutation probes are opening a control's
verified `aria-controls`/`aria-owns` popup and clicking an exact expected option
inside that popup. A probe reservation consumes its mutation budget before the
action.

DOM evidence is structure-only: input values, textarea content, and
contenteditable text are removed. Raw screenshots are omitted unless a masking
implementation can prove redaction. Historical console/network tails report
`supported=false` when the browser cannot supply durable history; an empty list
must not be interpreted as proof that no errors occurred.

## Ledger Root Wiring

Backend code reads `HUNT_LEDGER_ROOT` as the ledger root. It rejects paths inside the Hunt repo so runtime logs cannot be committed.

For Docker/C0 review, remember there are two paths:

| Side | Variable | Example |
| --- | --- | --- |
| Windows host folder that persists forever | `HUNT_LEDGER_HOST_ROOT` | `C:\Users\you\Documents\hunt-logs` |
| Container path mounted from that host folder | `HUNT_LEDGER_CONTAINER_ROOT` / `HUNT_LEDGER_ROOT` | `/hunt-ledger` |

`docker-compose.pipeline.yml` mounts `${HUNT_LEDGER_HOST_ROOT:-${USERPROFILE}/Documents/hunt-logs}` into the review container at `${HUNT_LEDGER_CONTAINER_ROOT:-/hunt-ledger}` and sets backend `HUNT_LEDGER_ROOT` to the container path. Agents inside the container should use `/hunt-ledger`, not the Windows host path.

The root structure files stay at the ledger root itself:

- `LEDGER_STRUCTURE.md`
- `schema.json`
- `index.json`
- `active.json`

Agents should traverse the root in this order:

1. Read `active.json` for current `active_agents`, `active_lanes`, and
   `active_sessions`.
2. Open the referenced `manifest.json` files for stable IDs and current
   `log_path` values.
3. Read append-only JSONL logs as the source of truth.
4. Query Postgres only as a rebuildable index; if it disagrees with JSONL,
   JSONL wins.

C3 agent, lane, and session paths are date partitioned:

- Agent manifest/log:
  `c3/agents/<YYYY-MM-DD>/<agent_id>/manifest.json` and `agent.jsonl`.
- Lane manifest/log:
  `c3/lanes/<YYYY-MM-DD>/<lane_id>/manifest.json` and `lane.jsonl`.
- Session manifest/log:
  `c3/sessions/<YYYY-MM-DD>/<session_id>/manifest.json` and `session.jsonl`.
- Session probes and artifacts:
  `c3/sessions/<YYYY-MM-DD>/<session_id>/probes/` and `artifacts/`.
- Global fallback logs:
  `c3/global/system.jsonl` and `c3/global/human.jsonl`.

Common queries:

- By agent: use `active.json.active_agents[agent_id].log_path`, API
  `GET /api/ledger/agents/{agent_id}`, or MCP `hunt_ledger_get_agent_log`.
- By session: use `active.json.active_sessions[session_id].log_path`, API
  `GET /api/ledger/sessions/{session_id}`, or MCP
  `hunt_ledger_get_session_log`.
- By command: use API `GET /api/ledger/commands/{command_id}/timeline` or MCP
  `hunt_ledger_get_command_timeline`; it dedupes immutable events across active
  agent, lane, and session logs.

## Package Dependencies

| Proof Area | Required Packages |
| --- | --- |
| ledger root and traversal files | 01 |
| redacted append-only JSONL | 01 |
| Postgres rebuild/query index | 02 |
| session/lane lease blocking and human override | 03 |
| MCP create-agent/session/lease/probe tools | 04 |
| C3 command bus and actor metadata | 05 |
| exact field/browser interaction events | 06 |
| human click and deep-debug logging | 07 |
| p Chrome batch workflow migration | 08 |

Run package-level tests first. Only run the live proof after all dependencies for the target proof area have landed.

## Fast Verification

Backend ledger gate:

```powershell
.venv\Scripts\python.exe -m pytest tests/test_ledger_store.py tests/test_ledger_api.py tests/test_ledger_leases.py tests/test_ledger_schema.py tests/test_ledger_indexer.py tests/test_ledger_integration.py -q
```

C3 command/instrumentation gate:

```powershell
.venv\Scripts\python.exe -m pytest tests/test_component3_stage1.py tests/test_component3_workday_fill.py tests/test_component3_generic_fill.py -q
```

Full local gate:

```powershell
.venv\Scripts\python.exe -m pytest tests/ -q
```

If Postgres, MCP, or p Chrome are unavailable, record that as a proof gap instead of treating file-only tests as release proof.

## Human UI Parity Logging

The C0 frontend helper `frontend/src/api/humanCommandLog.ts` posts best-effort `human.command` events to `/api/ledger/events`. It must remain fail-open and must not include form values, notes, job descriptions, credentials, or resume text.

Current C0 coverage:

- C1 gateway buttons: scrape, enrich, reauth.
- C0 operator mutations: component setting save, LinkedIn account save, transient-error requeue, stale-processing requeue, bulk requeue count/run.
- Job-row mutations: edit field names, requeue, set/clear priority, delete, and bulk actions.
- C2/C4 commands already invoked from C0: Fletcher queue/move/cancel/delete/clear and C4 run/approve.

Current C3-adjacent coverage:

- Easy Apply verification logs `component: "c3"` with `action: "c3.verify_easy_apply"`.
- Opening a job apply page from C0 logs `component: "c3"` with `action: "c3.open_apply_page"`.
- The helper supports top-level `lane_id`, `session_id`, `command_id`, and `trace_id`; call sites should pass them when a UI action is tied to an active C3 lane/session.

## Live Proof

Use one small lane first. Keep runtime logs outside the repo.

1. Set a fresh ledger root:

```powershell
$env:HUNT_LEDGER_ROOT = "$env:USERPROFILE\Documents\hunt-logs\ledger-proof-YYYYMMDD-HHMM"
```

2. Start or restart the backend with that environment.
3. Confirm the backend ledger root exists and contains:
   - `LEDGER_STRUCTURE.md`
   - `schema.json`
   - `index.json`
   - `active.json`
4. Start the MCP adapter and create one agent.
5. Launch one p Chrome C3 lane.
6. Create lane and session records through MCP or backend API.
7. Claim a session mutation lease for agent A.
8. Trigger one C3 agent command, such as `c3.fill_page` or a safe page inspection command.
9. Confirm agent log records the command with actor `{type:"agent", surface:"mcp"}`.
10. Confirm session log records exact C3/browser events for that session.
11. Run one probe command and confirm the probe record/file starts `trusted=false`.
12. Attempt a second mutating command from agent B on the same session and confirm it is blocked by the active lease.
13. Perform a human click or command override and confirm actor `{type:"human"}` is logged.
14. Confirm the override interrupts or supersedes the owning lease as designed.
15. Rebuild or query the Postgres index and confirm it contains the same event IDs as JSONL, with JSONL path and line/byte location when available.

### Bridge Command Smoke

After the backend command endpoint, extension command receiver, and MCP execution upgrade land, run the repeatable bridge smoke:

```powershell
$env:HUNT_BACKEND_URL = "http://127.0.0.1:8000"
$env:HUNT_DB_URL = "postgresql://hunt:hunt@127.0.0.1:5432/hunt"
$env:HUNT_C3_CDP_PORT = "9222"
$env:HUNT_C3_EXTENSION_ID = "<unpacked-extension-id>"
$env:HUNT_C3_JOB_URL = "<page-open-in-pchrome>"
.venv\Scripts\python.exe scripts\smoke_c3_bridge_live.py --rebuild-index
```

For a pre-integration dry run that reports missing bridge pieces instead of requiring target registration:

```powershell
.venv\Scripts\python.exe scripts\smoke_c3_bridge_live.py --allow-missing-target-registration
```

The smoke creates fresh `agent_id`, `lane_id`, `session_id`, claims a session mutation lease, optionally registers the p Chrome target through MCP when the tool exists, and calls `hunt_c3_run_command` with `command_name=c3.inspect_fields`.

Expected proof in the JSON report:

- `proof.commandReceipt` exists and came from the extension command path.
- `proof.logs.agent_log_path`, `lane_log_path`, and `session_log_path` are present, accessible, and contain the smoke `command_id`.
- Session JSONL contains `command.requested`, `command.started`, and `command.completed` for that `command_id`.
- `proof.postgres.summary.session_event_count` is nonzero and `missing_jsonl_path_count` is `0`.
- `proof.postgres.command_rows` contains rows for the smoke `command_id` with `jsonl_path` and line numbers.

### Agent Log Traversal Tools

Code-side helpers now exist so agents do not need to manually traverse every
JSONL path for common debugging:

- `hunt_c3_command_catalog`: lists C3 command names, mutation flags, and whether
  the bridge can execute the command directly.
- typed command wrappers: `hunt_c3_inspect_fields`,
  `hunt_c3_inspect_validation`, `hunt_c3_snapshot_page`,
  `hunt_c3_get_progress`, `hunt_c3_fill_page`,
  `hunt_c3_page_walk`, `hunt_c3_click_next_after_fill`.
- `hunt_ledger_get_command_timeline`: returns deduped immutable events for one
  `command_id` across active agent/lane/session logs.
- `hunt_ledger_find_recent_failures`: returns recent rejected/failed/error event
  summaries for agent debugging.

`c3.page_walk` is a first-class MCP/backend/extension command. Agents should
call it through `hunt_c3_page_walk` only while holding the session mutation
lease for the target browser session.

Required live inputs from other packages/workers:

- MCP must expose a real command execution path for `hunt_c3_run_command`; `recorded_not_executed` is a blocker.
- MCP/backend should expose one browser-target registration tool, currently probed as `hunt_c3_register_browser_target` or `hunt_c3_register_target`.
- p Chrome must be running on the configured debug port with the freshly reloaded C3 extension and target page.
- Backend must run with the same `HUNT_LEDGER_ROOT` intended for proof, outside the repo.
- `HUNT_DB_URL` must point at Postgres with ledger tables applied; use `--rebuild-index` when the smoke should rebuild the index before querying.

Docker C0/review variant:

```powershell
$env:HUNT_LEDGER_HOST_ROOT = "$env:USERPROFILE\Documents\hunt-logs"
$env:HUNT_LEDGER_CONTAINER_ROOT = "/hunt-ledger"
docker compose -f docker-compose.pipeline.yml --profile c0 up review
```

Inside the `review` container, backend `HUNT_LEDGER_ROOT` is `/hunt-ledger`; on Windows, the files persist under `$env:HUNT_LEDGER_HOST_ROOT`.

## Release Evidence To Capture

Record the following before release handoff:

- test commands run, exit code, and any known unrelated failures
- ledger root path used for live proof
- agent ID, lane ID, session ID, lease ID, command ID, and trace ID from the smoke
- JSONL file paths proving agent and session events
- Postgres query proving matching event IDs
- screenshot or copied output proving second-agent lease block
- copied event snippet proving human override
- note that the running backend/extension instance was restarted or reloaded after relevant code changes

## Remaining Gaps Until Proven Live

- MCP create-agent proof depends on package 04 being wired to the running backend.
- p Chrome lane proof depends on package 08 workflow migration and current p Chrome availability.
- Human click/deep-debug proof depends on package 07 and a freshly reloaded extension instance.
- Postgres proof depends on local DB availability and package 02 schema/indexer completion.
