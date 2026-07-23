# C3 Agent Testing Control Plane Implementation Plan

> **Required sub-skill:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan.

**Goal:** Let multiple agents run isolated C3 job-fill tests, detect stalls within seconds, cancel safely, and receive field-level evidence explaining every failure without controlling the foreground screen.

**Architecture:** Keep the existing JSONL ledger, leases, browser-target registry, synchronous command endpoint, and extension command registry. Add a durable asynchronous operation layer in the backend, cooperative runtime heartbeat/cancellation in the extension, safe read-oriented Playwright diagnostics, automatic failure bundles, enforced probe budgets, and an MCP-owned batch supervisor. The existing synchronous endpoint remains a compatibility shim until the operation path passes live gates.

**Tech stack:** FastAPI/Pydantic, Python JSONL ledger and pytest, MCP stdio adapter, Chrome extension JavaScript, CDP/Playwright, p Chrome isolated profiles.

**Design:** `docs/superpowers/specs/2026-07-21-c3-agent-testing-control-plane-design.md`

**Execution rule:** Create a dedicated git worktree before implementation. Complete packages in order; do not run browser-mutating packages in parallel against the same session. Use the human Git identity and make no automated final job submission.

## Existing Foundation To Preserve

- `backend/ledger/`: JSONL source of truth, projections, lease lifecycle, Postgres index, hash verification, and probe status.
- `backend/c3_commands.py`: authenticated/leased command validation and audit logging.
- `backend/c3_browser_bridge.py`: CDP-to-extension bridge.
- `tools/hunt_mcp/`: ledger, target, generic C3 command, and seven typed C3 wrappers.
- `executioner/src/background/commands/registry.js`: all 11 extension commands.
- `scripts/c3_workday_live_smoke.js`: temporary compatibility/live-debug runner.

Baseline already verified on 2026-07-21:

```text
98 passed in 5.06s  # ledger, MCP, leases, schema, indexer, command endpoint
5 passed in 9.99s  # focused progress, timeout, popup, phone, command-bus contracts
```

## Package 0: Background-Safety And Runner Lifecycle

### Task 1: Make foreground focus an explicit capability

**Files:**

- Modify: `scripts/lib/c3_workday_auth_workflow.js`
- Modify: `scripts/c3_workday_live_smoke.js`
- Modify: `tests/test_component3_stage1.py`

**Step 1: Write the failing contract test**

Add a source/runtime contract that calls the auth helper with `allowForeground: false` and records CDP calls:

```python
def test_workday_auth_does_not_focus_without_capability():
    script = build_auth_focus_script(allow_foreground=False)
    result = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    assert "Page.bringToFront" not in json.loads(result.stdout)["cdp_methods"]
```

Add `build_auth_focus_script` beside the test, following the file's existing inline Node fixture pattern.

Also assert the opt-in path may call it so the capability is intentional, not dead code.

**Step 2: Run the test and confirm failure**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_stage1.py -k "auth and focus" -q
```

Expected: failure showing unconditional `Page.bringToFront`.

**Step 3: Add the guard**

Thread `allowForeground = false` through the workflow and guard the CDP call:

```javascript
if (allowForeground === true && typeof browserClient.send === "function") {
  await browserClient.send("Page.bringToFront");
}
```

Make the live-smoke runner pass `allowForeground` only from an explicit CLI flag. Record it in the audit header.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_stage1.py -k "auth and focus" -q
git add scripts/lib/c3_workday_auth_workflow.js scripts/c3_workday_live_smoke.js tests/test_component3_stage1.py
git commit -m "fix(c3): guard foreground browser focus"
```

### Task 2: Guarantee live-smoke process cleanup

**Files:**

- Modify: `scripts/c3_workday_live_smoke.js`
- Modify: `tests/test_component3_prompt.py`

**Step 1: Write a failing child-process test**

Add a fixture mode that substitutes fake CDP/browser clients and reaches both success and failure cleanup. Assert each process exits within five seconds and all clients report closed.

```python
proc = subprocess.run(
    ["node", "scripts/c3_workday_live_smoke.js", "--fixture", "cleanup-success"],
    timeout=5,
    capture_output=True,
    text=True,
)
assert proc.returncode == 0
assert '"cleanupComplete":true' in proc.stdout
```

**Step 2: Confirm the success fixture hangs or fails**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_prompt.py -k "live_smoke and cleanup" -q
```

**Step 3: Centralize cleanup**

Track timers, CDP clients, browser contexts, and heartbeat intervals. Clear/close all of them in one awaited `finally`; assign `process.exitCode` instead of calling `process.exit()`.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_prompt.py -k "live_smoke and cleanup" -q
git add scripts/c3_workday_live_smoke.js tests/test_component3_prompt.py
git commit -m "fix(c3): close live smoke resources deterministically"
```

## Package 1: Durable Asynchronous Operations

### Task 3: Define the operation and event contracts

**Files:**

- Create: `backend/c3_operation_models.py`
- Create: `tests/test_c3_operations.py`

**Step 1: Write model tests**

Cover the exact state set and transition table:

```python
NONTERMINAL = {"queued", "running", "slow", "suspected_stall", "stalled", "cancelling"}
TERMINAL = {"completed", "failed", "cancelled", "orphaned"}

def test_completed_operation_cannot_return_to_running():
    with pytest.raises(InvalidOperationTransition):
        validate_transition("completed", "running")
```

Require `operation_id`, `command_id`, `agent_id`, `lane_id`, `session_id`, `lease_id`, `browser_target_id`, `command`, `state`, timestamps, heartbeat/progress sequence numbers, deadline, `allow_submit`, cancellation fields, result/error, and artifact IDs. Reject `allow_submit=True` unless an explicit submit capability is supplied.

**Step 2: Run and confirm import failure**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_operations.py -q
```

**Step 3: Implement Pydantic models and pure transition validation**

Keep policy pure and deterministic. Include `OperationEvent` with monotonic `seq`, `event_type`, UTC timestamp, IDs, and redacted payload.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_operations.py -q
git add backend/c3_operation_models.py tests/test_c3_operations.py
git commit -m "feat(c3): define durable operation contracts"
```

### Task 4: Add the durable operation store and recovery

**Files:**

- Create: `backend/c3_operations.py`
- Modify: `backend/ledger/config.py`
- Modify: `backend/ledger/service.py`
- Modify: `tests/test_c3_operations.py`

**Step 1: Write failing persistence/recovery tests**

Test create, append event, atomic projection, event reads after a sequence, and restart recovery. The JSONL event stream is authoritative; `operation.json` is a replace-on-write projection.

```python
store = C3OperationStore(tmp_path)
op = store.create(request)
store.append(op.operation_id, "operation.started", {"progress_seq": 0})
reloaded = C3OperationStore(tmp_path)
assert reloaded.get(op.operation_id).state == "orphaned"
assert reloaded.events(op.operation_id, after_seq=0)[0].seq == 1
```

Only operations left nonterminal across backend restart become `orphaned`; never silently resume browser mutation.

**Step 2: Run and confirm failure**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_operations.py -k "store or recovery or events" -q
```

**Step 3: Implement under the existing ledger session tree**

Use:

```text
c3/sessions/<date>/<session_id>/operations/<operation_id>/events.jsonl
c3/sessions/<date>/<session_id>/operations/<operation_id>/operation.json
```

Use existing redaction and hash-chain utilities. Serialize writes per operation and use a temporary sibling plus `Path.replace()` for projection updates.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_operations.py tests\test_ledger_store.py tests\test_ledger_verify.py -q
git add backend/c3_operations.py backend/ledger/config.py backend/ledger/service.py tests/test_c3_operations.py
git commit -m "feat(c3): persist operation event streams"
```

### Task 5: Expose nonblocking operation APIs

**Files:**

- Modify: `backend/c3_browser_bridge.py`
- Modify: `backend/c3_commands.py`
- Modify: `backend/app.py`
- Modify: `tests/test_c3_command_endpoint.py`
- Modify: `tests/test_c3_operations.py`

**Step 1: Write API tests first**

Required routes:

```text
POST /api/c3/operations
GET  /api/c3/operations/{operation_id}
GET  /api/c3/operations/{operation_id}/events?after_seq=N
POST /api/c3/operations/{operation_id}/cancel
POST /api/c3/operations/{operation_id}/retry
```

Mock the bridge with a blocking event. Assert POST returns `202` plus `operation_id` in under two seconds while state is `queued|running`. Assert a second mutation on the same session returns `409`, while read-only commands are allowed. Assert retry creates a child ID and refuses until the parent is terminal or cancellation is acknowledged.

**Step 2: Run and confirm route failures**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_operations.py tests\test_c3_command_endpoint.py -q
```

**Step 3: Implement the manager**

Use one backend-owned bounded executor, not request-thread work. Validate target/session/lease using existing command rules before enqueue. The worker emits requested, started, heartbeat/progress, and terminal events. Preserve `/api/c3/commands/run` as a compatibility shim; agent clients must use operations.

Cancellation endpoint changes state to `cancelling`, sends `cancel_session` with the operation/run IDs, and waits asynchronously for acknowledgment. It must not delete active state immediately.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_operations.py tests\test_c3_command_endpoint.py tests\test_ledger_integration.py -q
git add backend/c3_browser_bridge.py backend/c3_commands.py backend/app.py tests/test_c3_operations.py tests/test_c3_command_endpoint.py
git commit -m "feat(c3): add asynchronous operation API"
```

### Task 6: Add complete MCP lifecycle and command coverage

**Files:**

- Modify: `tools/hunt_mcp/client.py`
- Modify: `tools/hunt_mcp/server.py`
- Modify: `tools/hunt_mcp/tests/test_contract.py`
- Modify: `tools/hunt_mcp/README.md`

**Step 1: Extend failing contract tests**

Require tools for operation start/get/wait/cancel/retry and typed wrappers for all registry commands. The four currently missing typed wrappers are:

```text
hunt_c3_detect_page
hunt_c3_fill_remaining_with_llm
hunt_c3_clear_page
hunt_c3_cancel_session
```

Also require lane bootstrap, finish/fail/transfer, and lease heartbeat helpers composed from existing ledger APIs. `wait` accepts `after_seq` and a bounded timeout; it returns on new events or terminal state.

**Step 2: Run and confirm missing tools**

```powershell
.venv\Scripts\python.exe -m pytest tools\hunt_mcp\tests\test_contract.py -q
```

**Step 3: Implement thin MCP adapters**

All mutation wrappers start operations; they do not call the blocking command endpoint. Keep schemas explicit and require agent/session/lane/lease/target IDs. Default `allow_submit` to false and omit any foreground-focus capability from ordinary lane tools.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tools\hunt_mcp\tests\test_contract.py tests\test_c3_command_endpoint.py -q
git add tools/hunt_mcp/client.py tools/hunt_mcp/server.py tools/hunt_mcp/tests/test_contract.py tools/hunt_mcp/README.md
git commit -m "feat(mcp): expose complete C3 operation lifecycle"
```

## Package 2: Extension Runtime Observability And Control

### Task 7: Add run-scoped heartbeat and progress state

**Files:**

- Create: `executioner/src/background/operations/state.js`
- Create: `executioner/src/background/operations/heartbeat.js`
- Modify: `executioner/src/background/index.js`
- Modify: `executioner/src/background/commands/registry.js`
- Modify: `tests/test_component3_prompt.py`
- Modify: `tests/test_c3_command_endpoint.py`

**Step 1: Write failing runtime tests**

Use the existing Node fixture harness. Start a simulated long field wait and poll `get_progress`. Assert heartbeat sequence and timestamp advance at least every two seconds even when semantic progress does not. Require this payload:

```javascript
{
  active, operationId, fillRunId, command, phase, substep,
  fieldKey, fieldLabel, fieldKind, attempt,
  heartbeatSeq, progressSeq, lastHeartbeatAt, lastProgressAt,
  elapsedMs, pendingAction, popupOwner, cancelRequested
}
```

**Step 2: Run and confirm the current payload is insufficient**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_prompt.py -k "heartbeat or progress_payload" -q
```

**Step 3: Implement one state record per tab and operation**

Heartbeat updates liveness only. Semantic transitions increment `progressSeq`. Thread `operationId` through the registry context and reject updates from a stale operation/run pair.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_prompt.py tests\test_c3_command_endpoint.py -k "heartbeat or progress or registry" -q
git add executioner/src/background/operations/state.js executioner/src/background/operations/heartbeat.js executioner/src/background/index.js executioner/src/background/commands/registry.js tests/test_component3_prompt.py tests/test_c3_command_endpoint.py
git commit -m "feat(c3): emit run scoped heartbeat and progress"
```

### Task 8: Replace non-cancelling field timeouts

**Files:**

- Create: `executioner/src/background/operations/guard.js`
- Modify: `executioner/src/shared/v2/field-pipeline.js`
- Modify: `executioner/src/background/index.js`
- Modify: `tests/test_component3_generic_fill.py`
- Modify: `tests/test_component3_prompt.py`

**Step 1: Write failing stale-mutation tests**

Simulate a driver resolving after its field timeout. Assert it cannot click, type, select, or report success after cancellation acknowledgment or after a newer run starts.

```javascript
await assert.rejects(runField(lateDriver, ctx), /field_timeout/);
ctx.acknowledgeCancel();
lateDriver.resolve();
assert.equal(domMutationCount, 0);
```

Also test cancellation cause preservation and `cancel_acknowledged` emission.

**Step 2: Confirm current `Promise.race` permits a late mutation**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_generic_fill.py tests\test_component3_prompt.py -k "late_mutation or cancel_ack" -q
```

**Step 3: Add cooperative cancellation**

Replace bare timeout racing with a run guard checked before and after every wait and immediately before every DOM mutation. Drivers receive `{signal, guard, heartbeat}`. Timeout aborts the signal, waits for driver cleanup, emits acknowledgment, and only then permits recovery/retry. Never erase the active mapping before acknowledgment.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_generic_fill.py tests\test_component3_prompt.py -k "timeout or cancel or stale or late" -q
git add executioner/src/background/operations/guard.js executioner/src/shared/v2/field-pipeline.js executioner/src/background/index.js tests/test_component3_generic_fill.py tests/test_component3_prompt.py
git commit -m "fix(c3): make field cancellation cooperative"
```

### Task 9: Emit structured field, popup, and commit traces

**Files:**

- Modify: `executioner/src/shared/v2/field-pipeline.js`
- Modify: `executioner/src/ats/workday/workday-drivers-v2.js`
- Modify: `executioner/src/background/index.js`
- Modify: `tests/test_component3_workday_fill.py`
- Modify: `tests/test_component3_prompt.py`

**Step 1: Write trace-contract tests**

Require ordered events for every field attempt:

```text
field.discovered
field.attempt.started
field.action.started
popup.opened|popup.reused|popup.rejected|popup.closed
field.commit.checked
field.action.completed|failed|cancelled
```

Each contains operation/run/field IDs, label, kind, required state, attempt, driver, action, elapsed time, popup owner/geometry when relevant, and a stable reason code. Assert terminal audits retain partial traces when an outer timeout wins.

**Step 2: Run and confirm failures**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_workday_fill.py tests\test_component3_prompt.py -k "trace or popup_event or partial_audit" -q
```

**Step 3: Implement append-only checkpoints**

Emit checkpoints during execution instead of assembling them only at return. Separate action evidence from commit evidence; `clicked=true` is never equivalent to `committed=true`.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_workday_fill.py tests\test_component3_prompt.py -k "trace or popup or commit or audit" -q
git add executioner/src/shared/v2/field-pipeline.js executioner/src/ats/workday/workday-drivers-v2.js executioner/src/background/index.js tests/test_component3_workday_fill.py tests/test_component3_prompt.py
git commit -m "feat(c3): capture field and popup evidence"
```

### Task 10: Fix Workday popup ownership and commit proof

**Files:**

- Modify: `executioner/src/ats/workday/workday-drivers-v2.js`
- Modify: `executioner/src/shared/v2/ui-inspector.js`
- Modify: `tests/test_component3_workday_fill.py`
- Modify: `tests/test_component3_stage1.py`

**Step 1: Add regression fixtures for all observed failures**

Cover:

- off-viewport button-listbox whose owned listbox is valid;
- two open sibling popups where only `aria-controls`/`aria-owns` identifies the owner;
- option click without committed backing value;
- preselected required value that must count as filled;
- footer text such as `LinkedIn` that must not satisfy a Source field;
- required phone/email fields scheduled before optional dropdowns.

**Step 2: Run and confirm failures**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_workday_fill.py tests\test_component3_stage1.py -k "offviewport or owned_popup or committed or preselected or required_first" -q
```

**Step 3: Correct the driver**

Call `scrollIntoView({block: "center", inline: "nearest"})` before focus/click. Resolve popup ownership from `aria-controls`, `aria-owns`, and relationship IDs before geometry. Close unrelated expanded controls. Verify commit through the control/backing input plus selected option state. Recognize valid preselection. Sort required actionable fields before optional fields.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_workday_fill.py tests\test_component3_stage1.py -k "workday and (popup or commit or required or preselected)" -q
git add executioner/src/ats/workday/workday-drivers-v2.js executioner/src/shared/v2/ui-inspector.js tests/test_component3_workday_fill.py tests/test_component3_stage1.py
git commit -m "fix(c3): bind Workday popups to their controls"
```

## Package 3: Watchdog, Diagnostics, And Failure Evidence

### Task 11: Classify liveness separately from semantic progress

**Files:**

- Create: `backend/c3_watchdog.py`
- Modify: `backend/c3_operations.py`
- Modify: `backend/c3_commands.py`
- Modify: `tests/test_c3_operations.py`

**Step 1: Write deterministic clock tests**

Use a fake clock and assert:

```text
heartbeat age 10s -> suspected_stall + health probe
heartbeat age 20s -> failure bundle request
heartbeat age 30s -> stalled + cancellation request
heartbeat alive, progress age 45s -> slow, no cancellation
hard deadline 120s -> cancellation regardless of heartbeat
```

Assert recovery never starts while a prior mutation is nonterminal or cancellation is unacknowledged.

**Step 2: Run and confirm module failure**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_operations.py -k "watchdog or slow or stalled" -q
```

**Step 3: Implement the monitor**

Poll extension progress through the bridge at a bounded interval. Convert bridge transport errors, extension heartbeat age, semantic progress age, browser-target health, and deadline into distinct reason codes. Make thresholds configurable but retain design defaults.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_operations.py tests\test_c3_command_endpoint.py -k "watchdog or operation or progress" -q
git add backend/c3_watchdog.py backend/c3_operations.py backend/c3_commands.py tests/test_c3_operations.py
git commit -m "feat(c3): detect stalls from runtime heartbeat"
```

### Task 12: Add bounded, screen-independent diagnostics

**Files:**

- Create: `backend/c3_browser_controls.py`
- Modify: `backend/c3_browser_bridge.py`
- Modify: `backend/c3_commands.py`
- Modify: `tools/hunt_mcp/client.py`
- Modify: `tools/hunt_mcp/server.py`
- Create: `tests/test_c3_browser_controls.py`
- Modify: `tools/hunt_mcp/tests/test_contract.py`

**Step 1: Write capability tests**

Define safe operations for target health, URL/title, DOM snapshot, screenshot, console tail, failed-request tail, active/focused element, popup ownership, and selector-scoped attribute reads. Assert ordinary diagnostics cannot click/type/evaluate arbitrary JavaScript, invoke `Page.bringToFront`, or click a submit control.

**Step 2: Run and confirm missing controls**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_browser_controls.py tools\hunt_mcp\tests\test_contract.py -q
```

**Step 3: Implement a bounded allowlist**

Attach over CDP without focusing the page. Sanitize DOM/text output and cap byte counts. Any mutating diagnostic belongs to the separately leased probe path in Task 14, never this API.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_browser_controls.py tools\hunt_mcp\tests\test_contract.py tests\test_c3_browser_registry.py -q
git add backend/c3_browser_controls.py backend/c3_browser_bridge.py backend/c3_commands.py tools/hunt_mcp/client.py tools/hunt_mcp/server.py tests/test_c3_browser_controls.py tools/hunt_mcp/tests/test_contract.py
git commit -m "feat(c3): expose bounded browser diagnostics"
```

### Task 13: Capture automatic redacted failure bundles

**Files:**

- Create: `backend/c3_artifacts.py`
- Modify: `backend/ledger/models.py`
- Modify: `backend/ledger/service.py`
- Modify: `backend/ledger/api.py`
- Modify: `backend/c3_operations.py`
- Create: `tests/test_c3_artifacts.py`
- Modify: `tests/test_ledger_api.py`

**Step 1: Write artifact tests**

On `suspected_stall`, `stalled`, `failed`, and cancellation timeout, require a manifest linked to the operation. Bundle: screenshot, sanitized DOM excerpt, inspected fields, validation state, extension progress, console/network tails, target health, last 100 events, and checkpoint audit. Assert password, token, cookie, authorization, resume-body, email, phone, and street-address values are redacted. Capture failure must append `artifact_capture_failed` without replacing the original operation error.

**Step 2: Run and confirm failure**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_artifacts.py tests\test_ledger_api.py -q
```

**Step 3: Implement artifact storage and API**

Store under the operation directory, hash every file, add artifact IDs to the projection, and provide authenticated list/manifest/download endpoints with traversal rejection. Reuse the existing redaction and verifier layers.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_artifacts.py tests\test_ledger_api.py tests\test_ledger_verify.py -q
git add backend/c3_artifacts.py backend/ledger/models.py backend/ledger/service.py backend/ledger/api.py backend/c3_operations.py tests/test_c3_artifacts.py tests/test_ledger_api.py
git commit -m "feat(c3): capture automatic failure bundles"
```

### Task 14: Enforce probe budgets before mutation

**Files:**

- Create: `backend/c3_probe_budgets.py`
- Modify: `backend/c3_commands.py`
- Modify: `backend/ledger/models.py`
- Modify: `tools/hunt_mcp/client.py`
- Modify: `tools/hunt_mcp/server.py`
- Create: `tests/test_c3_probe_budgets.py`
- Modify: `tools/hunt_mcp/tests/test_contract.py`

**Step 1: Write atomic budget tests**

Require limits for total attempts, mutating actions, wall time, files, and bytes. Reserve budget before the action, not after. Test the observed two-click defect: an opener click consumes one mutation even if the following option click is denied.

```python
ticket = budget.reserve(kind="dom_mutation", count=1)
perform_click()
budget.commit(ticket, proof={"predicate": "popup_open", "passed": True})
```

Concurrent reservations must not exceed the limit. Every mutation requires a lease, reason, operation ID, expected predicate, and automatic before/after evidence.

**Step 2: Run and confirm module failure**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_probe_budgets.py tools\hunt_mcp\tests\test_contract.py -q
```

**Step 3: Implement server-side reservations**

Do not trust agent-side counters. Reject arbitrary script execution; expose named probe actions only. Mark results untrusted through the existing probe lifecycle until promoted with evidence.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_probe_budgets.py tools\hunt_mcp\tests\test_contract.py tests\test_ledger_api.py -q
git add backend/c3_probe_budgets.py backend/c3_commands.py backend/ledger/models.py tools/hunt_mcp/client.py tools/hunt_mcp/server.py tests/test_c3_probe_budgets.py tools/hunt_mcp/tests/test_contract.py
git commit -m "feat(c3): enforce diagnostic probe budgets"
```

## Package 4: Autonomous Multi-Lane Testing

### Task 15: Build availability and lane planning

**Files:**

- Create: `tools/c3_agent_testing/__init__.py`
- Create: `tools/c3_agent_testing/availability.py`
- Create: `tools/c3_agent_testing/planner.py`
- Create: `tests/test_c3_agent_planner.py`

**Step 1: Write planner tests**

Feed CSV fixtures containing live, expired, duplicate, malformed, and unknown jobs. Classify a successful CXS/API check as live, terminal 404/410 as expired, and protected 401/403 as unknown requiring a bounded browser check. Never treat 403 alone as expired.

Assert the planner emits one immutable lane descriptor per selected job with unique profile, port, target, agent, lane, session, lease, artifact root, and deadline. Duplicate URL/job IDs are removed deterministically.

**Step 2: Run and confirm imports fail**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_agent_planner.py -q
```

**Step 3: Implement pure planning plus injected availability clients**

Keep network/browser adapters injectable. Selection output is JSON so a run can be reproduced. Never launch a browser in the planner unit tests.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_agent_planner.py -q
git add tools/c3_agent_testing tests/test_c3_agent_planner.py
git commit -m "feat(c3): plan isolated test lanes from CSV"
```

### Task 16: Build the MCP-owned batch supervisor

**Files:**

- Create: `tools/c3_agent_testing/runner.py`
- Create: `tools/c3_agent_testing/classifier.py`
- Create: `tools/c3_agent_testing/report.py`
- Create: `tests/test_c3_agent_runner.py`
- Modify: `tools/hunt_mcp/README.md`

**Step 1: Write supervisor tests with fake MCP clients**

Test a five-lane rolling queue. For each lane, require this sequence:

```text
register agent/lane/session -> claim lease -> attach exact target
-> start operation -> wait on events -> heartbeat lease
-> diagnose/cancel if unhealthy -> terminal classification
-> release lease -> render artifact-linked report
```

Assert one lane stall does not block others, the same target/session never receives concurrent mutations, final Submit remains untouched, and buffered child stdout is never used as the source of truth.

Classify at least: `review_ready`, `fill_failed`, `site_auth_gate`, `job_expired`, `operation_stalled`, `bridge_unreachable`, `cancel_not_acknowledged`, `artifact_capture_failed`, and `safety_blocked`.

**Step 2: Run and confirm failure**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_agent_runner.py -q
```

**Step 3: Implement bounded concurrency**

Use backend operations and MCP event waits only. The runner may launch/stop its own isolated p Chrome lanes, but it must not focus them or close pre-existing user browsers. Always preserve per-lane artifacts and generate a batch summary from ledger truth.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_agent_runner.py tests\test_c3_agent_planner.py tools\hunt_mcp\tests\test_contract.py -q
git add tools/c3_agent_testing tests/test_c3_agent_runner.py tools/hunt_mcp/README.md
git commit -m "feat(c3): supervise parallel agent test lanes"
```

### Task 17: Add CLI entry point and legacy migration path

**Files:**

- Create: `scripts/c3_agent_batch.py`
- Modify: `scripts/c3_workday_live_smoke.js`
- Modify: `docs/C3_PARALLEL_BATCH.md`
- Modify: `docs/C3_AGENT_COMMAND_LEDGER.md`
- Modify: `docs/superpowers/plans/c3-agent-command-ledger-workpackages/README.md`
- Modify: `docs/superpowers/plans/c3-agent-command-ledger-workpackages/remaining-tickets/README.md`
- Create: `tests/test_c3_agent_batch_cli.py`

**Step 1: Write CLI tests**

Test `plan`, `run`, `resume-report`, and `cancel-batch` using fixture clients. Require explicit CSV path, count, max concurrency, port range, deadline, and output directory. Defaults: no foreground, no submit, preserve artifacts.

**Step 2: Run and confirm missing command**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_agent_batch_cli.py -q
```

**Step 3: Implement and update docs**

Mark the Node live-smoke runner compatibility-only after the new path passes live gates. Replace the 31-ticket view with package/status links; keep historical ticket documents but label superseded mappings rather than deleting them.

**Step 4: Verify and commit**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_c3_agent_batch_cli.py tests\test_c3_agent_runner.py -q
git add scripts/c3_agent_batch.py scripts/c3_workday_live_smoke.js docs/C3_PARALLEL_BATCH.md docs/C3_AGENT_COMMAND_LEDGER.md docs/superpowers/plans/c3-agent-command-ledger-workpackages tests/test_c3_agent_batch_cli.py
git commit -m "docs(c3): make MCP supervisor the standard batch path"
```

## Package 5: Verification And Live Rollout

### Task 18: Run the complete automated regression matrix

**Files:**

- Modify only if failures reveal a scoped defect.

**Step 1: Run foundation and new backend/MCP tests**

```powershell
.venv\Scripts\python.exe -m pytest tools\hunt_mcp\tests tests\test_ledger_store.py tests\test_ledger_api.py tests\test_ledger_leases.py tests\test_ledger_schema.py tests\test_ledger_indexer.py tests\test_ledger_integration.py tests\test_ledger_verify.py tests\test_c3_command_endpoint.py tests\test_c3_operations.py tests\test_c3_browser_controls.py tests\test_c3_artifacts.py tests\test_c3_probe_budgets.py tests\test_c3_agent_planner.py tests\test_c3_agent_runner.py tests\test_c3_agent_batch_cli.py -q
```

Expected: all pass; no timeout.

**Step 2: Run C3 extension regression groups separately**

```powershell
.venv\Scripts\python.exe -m pytest tests\test_component3_prompt.py -q
.venv\Scripts\python.exe -m pytest tests\test_component3_generic_fill.py -q
.venv\Scripts\python.exe -m pytest tests\test_component3_workday_fill.py -q
.venv\Scripts\python.exe -m pytest tests\test_component3_stage1.py -q
```

Run separately so a timeout identifies the group. Record elapsed time and failing node fixture when any group exceeds its test timeout.

**Step 3: Run repository hygiene checks**

```powershell
git diff --check
rg -n "Page\.bringToFront|allowSubmit\s*[:=]\s*true|TODO|TBD" backend executioner scripts tools docs/C3_*.md
git status --short
```

Review every match; do not blindly remove legitimate guarded/test occurrences.

**Step 4: Handle any regression without bundling unrelated edits**

If a test fails, return to the task that owns the defect, add a focused regression test there, and commit only that task's reviewed files. If all checks pass and no file changed, make no commit for this step.

### Task 19: Prove lease, stall, cancellation, and human override behavior

**Files:**

- Create: `tests/integration/test_c3_agent_control_plane.py`
- Modify: `docs/C3_AGENT_COMMAND_LEDGER.md`

**Step 1: Add integration scenarios**

Use controlled local fixtures for:

1. two agents racing for one session lease;
2. heartbeat alive but semantic progress slow;
3. heartbeat stopped and bundle captured by 20 seconds;
4. stale field resolution after cancellation acknowledgment;
5. human interrupt during active mutation;
6. backend restart with a nonterminal operation becoming orphaned;
7. exact-target loss with no fallback to another browser.

**Step 2: Run the integration file**

```powershell
.venv\Scripts\python.exe -m pytest tests\integration\test_c3_agent_control_plane.py -q
```

Expected: all pass; the clock-controlled tests do not require real 20/30-second sleeps.

**Step 3: Document actual transition timelines and commit**

```powershell
git add tests/integration/test_c3_agent_control_plane.py docs/C3_AGENT_COMMAND_LEDGER.md
git commit -m "test(c3): verify operation safety transitions"
```

### Task 20: Run real-browser acceptance gates

**Files:**

- Create: `docs/C3_AGENT_TESTING_ACCEPTANCE.md`
- Update: `docs/C3_PARALLEL_BATCH.md`
- Update the smallest relevant vault C3 page after results are final.

**Step 1: Confirm changed code is live**

Restart the backend, reload the unpacked extension in each isolated profile, and query the command catalog/version. Record commit hash, extension version, backend PID/start time, and browser-target IDs. Do not claim acceptance against stale processes.

**Step 2: Run a one-lane instrumented fixture gate**

Verify operation start under two seconds, heartbeat under three seconds, field trace visibility, cancellation acknowledgment, automatic artifacts, no focus, and untouched Submit.

**Step 3: Run ATS breadth before scale**

Run one live available job each for Workday, Greenhouse, and Lever. Stop at Review or the last pre-submit page. Any hard failure must contain a complete automatic bundle and stable reason code.

**Step 4: Re-run five isolated Workday lanes**

Select five currently live CSV jobs with the planner. Run maximum concurrency five only after one-lane and ATS gates pass. Acceptance criteria:

```text
start response <= 2s
active heartbeat gap <= 3s
suspected stall visible <= 10s
failure bundle requested <= 20s
zero stale DOM mutations after cancel acknowledgment
zero overlapping mutations per session
zero foreground focus events
zero final Submit activations
all terminal failures have field/popup/commit traces and artifacts
all runner processes exit within 5s of terminal batch state
```

**Step 5: Test mixed human/agent control**

Interrupt one safe fixture lane as a human. Verify the lease transfers or cancels cleanly, the agent does not resume mutation, and diagnostics remain readable.

**Step 6: Record evidence and commit docs**

```powershell
git add docs/C3_AGENT_TESTING_ACCEPTANCE.md docs/C3_PARALLEL_BATCH.md
git commit -m "docs(c3): record agent testing acceptance evidence"
```

If backend or extension changes are not loaded into the running instances, state that explicitly and ask whether to restart/reload before claiming the result is live.

## Final Release Gate

Do not deprecate the legacy runner or call the control plane complete until all are true:

- Automated foundation, extension, control-plane, and integration suites pass.
- The operation API is the source of truth for batch state.
- Every extension command has a typed MCP wrapper and operation lifecycle.
- Stall detection uses heartbeat independently from semantic progress.
- Cancellation is acknowledged and stale runs are mutation-blocked.
- Probe budgets are reserved server-side before mutations.
- Failure bundles are automatic, redacted, hashed, and linked.
- One-lane, three-ATS, five-lane, and human-interrupt live gates pass.
- Running backend and extension instances are verified to contain the tested code.
