# C3 Failure Context Implementation Plan

> REQUIRED SUB-SKILL: Use superpowers:executing-plans.

Goal: Give agents one durable, structured failure-context packet containing all retained causal evidence, while making Playwright/live inspection an explicit fallback only when evidence is genuinely missing.

Architecture: Build diagnosis deterministically from append-only operation events, never from mutable `operation.json.error` alone. Persist `diagnosis.json` beside each operation, expose it through one owned control endpoint and one MCP tool, and project its compact fields into lane reports. Make terminal truth write-once, separate monitor errors, reconcile cooperative cancellation, and link late artifacts after caller timeout.

Tech Stack: Python 3.14, Pydantic, FastAPI, JSONL ledger, pytest, existing Hunt MCP stdio server.

Repository policy: Work already lives in dedicated worktree `C:\Users\sushi\Documents\Github\hunt-worktrees\c3-agent-testing-control-plane`. No commits without explicit user authorization; each task still ends with a verified checkpoint.

## Task 1: Deterministic failure-context model and builder

Files:

- Create `backend/c3_failure_context.py`
- Create `tests/test_c3_failure_context.py`

- [ ] Write fixture tests for auth redirect, missing resume, Workday commit failure, control-plane cancellation, generic unknown, redaction, causal-versus-last-touched separation, and authoritative terminal-event selection.
- [ ] Run `pytest tests/test_c3_failure_context.py -q`; expect import/test failure.
- [ ] Add strict Pydantic models `C3ElementEvidence`, `C3FailureContext`, and pure `build_failure_context(operation, events, artifact_ids=())`.
- [ ] Extract terminal cause from latest immutable terminal/control event; normalize scopes/codes; retain evidence event IDs, expected/observed states, confidence, unknown flag, missing evidence, monitor summary, artifact status, and `live_inspection_required`.
- [ ] Never emit `causal_element` for navigation/control-plane/external-server failures. Preserve last-touched and exposing-action separately.
- [ ] Run focused tests; expect pass.

Core output:

```python
C3FailureContext(
    operation_id="op_...",
    failure_scope="setup",
    root_cause_code="resume_upload_missing_data",
    causal_element={"selector": "button#resumeAttachments--attachments", "label": "Upload a file"},
    expected_state="Resume attachment committed before continuing.",
    observed_state="Required upload validation remained visible.",
    confidence="proven",
    root_cause_unknown=False,
    evidence_event_ids=["evt_..."],
    artifact_ids=[],
    live_inspection_required=False,
)
```

## Task 2: Persist/rebuild diagnosis from operation source of truth

Files:

- Modify `backend/c3_operations.py`
- Modify `backend/c3_operation_models.py`
- Modify `tests/test_c3_operations.py`

- [ ] Write tests proving terminal append creates atomic `diagnosis.json`, rebuild reproduces it, late health/artifact events refresh evidence without changing primary cause, and malformed diagnosis generation records `diagnosis.failed` without changing operation failure.
- [ ] Run focused tests; expect failure.
- [ ] Add store methods `get_failure_context()` and `rebuild_failure_context()` using operation directory plus append-only events.
- [ ] Generate diagnosis after terminal events and refresh it after artifact linkage; keep `diagnosis.json` a projection, never source of truth.
- [ ] Add optional `monitor_error` and `diagnosis_id` projection fields; health/artifact capture failures update monitoring fields instead of primary `error`.
- [ ] Run focused tests; expect pass.

## Task 3: Make terminal truth immutable and reject stale post-terminal telemetry

Files:

- Modify `backend/c3_operations.py`
- Modify `backend/c3_operation_monitor.py`
- Modify `tests/test_c3_operations.py`
- Modify `tests/test_c3_operation_monitor.py`

- [ ] Write regressions reproducing UBC/Shell terminal error overwrite and Workday/Adobe post-terminal progress.
- [ ] Run focused tests; expect failure.
- [ ] Restrict `error`, `result`, and `terminal_reason` projection changes to their authoritative lifecycle events.
- [ ] Route `operation.health_probe_failed`, `operation.monitor_failed`, and artifact failures to `monitor_error` only.
- [ ] Re-read operation after every bounded probe; if terminal, discard returned progress/health without appending stale telemetry.
- [ ] Stop tracking terminal operations even when late probe callbacks finish.
- [ ] Run focused tests; expect pass.

## Task 4: Reconcile cooperative cancellation and orphaned cancelling operations

Files:

- Modify `backend/c3_operations.py`
- Modify `backend/c3_operation_monitor.py`
- Modify `tools/c3_agent_testing/runner.py`
- Modify `tests/test_c3_operations.py`
- Modify `tests/test_c3_operation_monitor.py`
- Modify `tests/test_c3_agent_runner.py`

- [ ] Write Bird regression: deadline request, extension page-walk returns `stoppedReason=user_cancelled`, cancel bridge remains pending, runner sees `cancel_failed_at`, lease later disappears.
- [ ] Run tests; expect operation stuck `cancelling` and early `cancel_backoff_active`.
- [ ] When original bridge returns owned `user_cancelled` during cancellation, append `operation.cancel_acknowledged` then terminal `operation.cancelled` instead of `result_ignored_after_cancel`.
- [ ] Make runner wait until parsed `cancel_retry_after` before redispatch; never convert backoff conflict into generic lane failure.
- [ ] Add bounded monitor reconciliation: cancellation failure past hard reconciliation age becomes terminal `operation.orphaned` with `control_plane_cancel_unreconciled`, then monitoring stops. No mutation lease required for backend-owned reconciliation.
- [ ] Run focused tests; expect pass.

## Task 5: Link late artifacts atomically

Files:

- Modify `backend/c3_operation_monitor.py`
- Modify `backend/c3_artifacts.py`
- Modify `tests/test_c3_operation_monitor.py`
- Modify `tests/test_c3_artifacts.py`

- [ ] Write test where capture exceeds caller timeout but later returns valid artifact ID.
- [ ] Run test; expect timeout event and permanently empty `artifact_ids`.
- [ ] Attach completion callback before bounded wait; callback validates manifest, appends `operation.artifact_captured`, refreshes diagnosis, and never overwrites primary cause.
- [ ] Make linkage idempotent so on-time and late completion cannot duplicate IDs/events.
- [ ] Record capture state `capturing|partial|completed|failed` in failure context.
- [ ] Run focused tests; expect pass.

## Task 6: Owned failure-context API

Files:

- Modify `backend/c3_control_plane.py`
- Modify `tests/test_c3_control_plane.py`

- [ ] Write API tests for `GET /api/c3/control/operations/{operation_id}/failure-context` covering ownership, terminal and nonterminal operations, rebuild fallback, missing evidence, and released-lease read access.
- [ ] Run focused tests; expect 404.
- [ ] Add read endpoint using exact operation agent/lease identity stored on operation. Reads remain valid after lane lease release because no mutation occurs.
- [ ] Return persisted context, bounded action/validation/navigation evidence tail, artifact manifests/status, and source event sequence.
- [ ] Run focused tests; expect pass.

## Task 7: Single MCP retrieval tool

Files:

- Modify `tools/hunt_mcp/client.py`
- Modify `tools/hunt_mcp/server.py`
- Modify `tools/hunt_mcp/README.md`
- Modify `tools/hunt_mcp/tests/test_contract.py`

- [ ] Add failing strict-contract tests for `hunt_c3_get_failure_context` requiring `operation_id`, `agent_id`, and `lease_id`, rejecting extras and preserving backend error detail.
- [ ] Run MCP contract tests; expect missing tool/client failures.
- [ ] Add client route, strict schema, handler, and concise agent instructions: inspect this tool before browser control.
- [ ] Run MCP contract tests; expect pass.

## Task 8: Project compact context into lane reports

Files:

- Modify `tools/c3_agent_testing/report.py`
- Modify `tools/c3_agent_testing/runner.py`
- Modify `scripts/c3_agent_batch.py`
- Modify `tests/test_c3_agent_runner.py`
- Modify `tests/test_c3_agent_batch_cli.py`

- [ ] Write tests that terminal and cancellation-pending reports include compact diagnosis fields without embedding raw DOM/logs.
- [ ] Run focused tests; expect dataclass/serialization failures.
- [ ] Add MCP client protocol method, fetch failure context after terminal/cancel reconciliation, and populate scope/code/causal selector/expected/observed/confidence/unknown/evidence IDs/artifact IDs/missing evidence/live-inspection flag.
- [ ] Preserve generic classification for backward compatibility.
- [ ] If context retrieval fails, report explicit `failure_context_status=unavailable` and error reason; never silently omit it.
- [ ] Run focused tests; expect pass.

## Task 9: Documentation and combined verification

Files:

- Modify `docs/C3_AGENT_COMMAND_LEDGER.md`
- Modify `docs/C3_LANE_AGENT.md`
- Modify `docs/C3_PARALLEL_BATCH.md`
- Modify `tools/hunt_mcp/README.md`
- Modify `C:\Users\sushi\Documents\agentsvault\Wiki\Projects\hunt\modules\c3-current-handoff.md`

- [ ] Document packet semantics, causal-versus-last-touched rule, event authority, Playwright fallback rule, cancellation reconciliation, and artifact lifecycle.
- [ ] Run focused suites:

```powershell
pytest tests/test_c3_failure_context.py tests/test_c3_operations.py tests/test_c3_operation_monitor.py tests/test_c3_artifacts.py tests/test_c3_control_plane.py tests/test_c3_agent_runner.py tests/test_c3_agent_batch_cli.py tools/hunt_mcp/tests/test_contract.py -q
```

- [ ] Run existing broader C3/backend/MCP suites, Ruff format/check on changed Python, `node --check` only if JavaScript changes, PowerShell parse only if PowerShell changes, and `git diff --check`.
- [ ] Verify live backend process code origin. Restart backend only after preserving current command/env and confirm `/health` plus failure-context endpoint.
- [ ] Reconcile/verify prior Bird orphan no longer generates events after backend reload/recovery.
- [ ] Run one isolated Finning and one isolated auth-sink live acceptance without foreground/final Submit. Confirm fresh blind agent uses failure-context packet only and does not inspect browser/site.
- [ ] Record fresh evidence paths and whether changes are live.
