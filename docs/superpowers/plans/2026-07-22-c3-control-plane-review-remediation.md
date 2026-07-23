# C3 Control-Plane Review Remediation Implementation Plan

> REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

Goal: Eliminate every reviewed C3 diagnostic, stall, isolation, privacy, recovery, and runner defect while preserving no-submit/no-foreground safety.

Architecture: Keep JSONL as operation authority, but add bounded indexed projections, paginated reads, stable target identity across expected navigation, and permanent cancellation guards. Share sanitization and ownership rules across browser controls, artifacts, REST, MCP, runner, and extension.

Tech Stack: Python 3, FastAPI, Pydantic, pytest, JavaScript MV3 extension, Node syntax/harness tests, PowerShell lane setup.

## Task 1: Browser identity, DOM privacy, artifact containment

Files:
- Modify `backend/c3_browser_controls.py`
- Modify `backend/c3_artifacts.py`
- Modify `backend/c3_control_plane.py`
- Modify `tests/test_c3_browser_controls.py`
- Modify `tests/test_c3_artifacts.py`
- Modify `tests/test_c3_control_plane.py`

- [ ] Add failing tests: same CDP target accepts changed URL; changed target fails; remote host resolution works.
- [ ] Add failing seeded-secret tests for arbitrary attributes, custom-control text, href/query data, and label bounds.
- [ ] Add failing tests for symlink manifests, oversized manifests/files/sections, and raw extra manifest fields.
- [ ] Implement shared structural DOM sanitizer used by direct snapshots and persisted artifacts.
- [ ] Pin target ID/tab identity while returning current sanitized URL as observation.
- [ ] Reuse bridge candidate CDP hosts.
- [ ] Add per-section/file/bundle limits and streaming hash validation.
- [ ] Route artifact listing through bounded validated summaries.
- [ ] Run `pytest tests/test_c3_browser_controls.py tests/test_c3_artifacts.py tests/test_c3_control_plane.py -q`.

## Task 2: Operation lifecycle, bounded events, diagnosis performance

Files:
- Modify `backend/c3_operations.py`
- Modify `backend/c3_failure_context.py`
- Modify `backend/c3_operation_monitor.py`
- Modify `backend/c3_monitor_runtime.py`
- Modify `backend/c3_watchdog.py`
- Modify `tests/test_c3_operations.py`
- Modify `tests/test_c3_failure_context.py`
- Modify `tests/test_c3_operation_monitor.py`
- Modify `tests/test_c3_watchdog.py`

- [ ] Add failing test for terminal-during-progress-probe capture.
- [ ] Add failing concurrent callback test proving two artifact IDs persist/download.
- [ ] Add failing cursor pagination/count/byte-bound tests.
- [ ] Add failing 500-event diagnosis performance and deterministic truncation tests.
- [ ] Add failing queued-deadline and acknowledged-cancel restart tests.
- [ ] Add failing malformed-operation recovery isolation test.
- [ ] Capture failed terminals before every cleanup path.
- [ ] Add atomic additive artifact-link store operation.
- [ ] Implement bounded event window and cursor API primitives.
- [ ] Replace nested diagnosis scans with bounded indexed evidence selection.
- [ ] Evaluate deadline before queued early return.
- [ ] Recover acknowledged cancellation as cancelled and isolate corrupt operation recovery.
- [ ] Run focused operation/monitor/failure/watchdog tests.

## Task 3: API ownership, terminal idempotency, identity integrity

Files:
- Modify `backend/c3_commands.py`
- Modify `backend/c3_browser_bridge.py`
- Modify `backend/ledger/api.py`
- Modify `backend/ledger/models.py`
- Modify `tests/test_c3_command_endpoint.py`
- Modify `tests/test_ledger_api.py`
- Modify `tools/hunt_mcp/client.py`
- Modify `tools/hunt_mcp/server.py`
- Modify `tools/hunt_mcp/tests/test_contract.py`

- [ ] Add failing cross-agent operation/event read tests and released-owner read test.
- [ ] Add failing nested identity-spoof tests for every reserved control key.
- [ ] Add failing terminal-marker redaction and changed-retry-body tests.
- [ ] Require agent/lease identity on operation/event reads.
- [ ] Add bounded event `limit`, `next_after_seq`, `has_more`, and `truncated` contract.
- [ ] Define one reserved normalized identity-key set and overwrite nested values from outer backend authority.
- [ ] Redact marker before persistence; append only marker-owned terminal payload.
- [ ] Update MCP schemas, client calls, wait cursor handling, and tests.
- [ ] Run endpoint, ledger API, and MCP contract tests.

## Task 4: Extension bounded cancellation, input cleanup, state retention

Files:
- Modify `executioner/src/background/index.js`
- Modify `executioner/src/background/fill-runner.js`
- Modify `executioner/src/background/operations/state.js`
- Modify `executioner/src/ats/workday/fill-v2.js`
- Modify `executioner/src/shared/v2/field-pipeline.js`
- Modify relevant Node harnesses in `tests/test_component3_*.py`

- [ ] Add failing timeout tests proving return after unwind cap while late mutations remain blocked.
- [ ] Add failing worker/queue test proving late promise settlement cannot change terminal result.
- [ ] Add failing mouse/key cancellation tests proving matching release is always sent.
- [ ] Add failing state-retention test for completed runs and capped tombstones.
- [ ] Remove every unbounded post-timeout join.
- [ ] Keep cancelled action guard/tombstone independent from returned command lifetime.
- [ ] Add best-effort CDP release cleanup in `finally`.
- [ ] Clear completed operation entries; expire cancelled tombstones with hard cap.
- [ ] Run component-3 harnesses and `node --check` for all changed JS.

## Task 5: Runner uniqueness, target cleanup, late evidence refresh

Files:
- Modify `tools/c3_agent_testing/planner.py`
- Modify `tools/c3_agent_testing/runner.py`
- Modify `tools/c3_agent_testing/report.py`
- Modify `scripts/c3_agent_batch.py`
- Modify `tests/test_c3_agent_planner.py`
- Modify `tests/test_c3_agent_runner.py`
- Modify `tests/test_c3_agent_batch_cli.py`

- [ ] Add failing replacement test where search returns already-selected canonical URL.
- [ ] Add failing preparation test where validation throws after tab creation and assert tab close.
- [ ] Add failing paginated waiter test with no replay.
- [ ] Add failing late-artifact refresh and completed-resume refresh tests.
- [ ] Seed replacement exclusions from selected jobs and continue search after duplicates.
- [ ] Return/track every created tab ID and close it on all failure paths.
- [ ] Poll terminal failure context for a bounded late-artifact window.
- [ ] Persist compact evidence tails/artifact summaries and refresh completed checkpoints.
- [ ] Run planner, runner, and CLI tests.

## Task 6: Integrated safety and regression verification

Files:
- Modify docs only if contracts changed: `docs/C3_AGENT_COMMAND_LEDGER.md`, `docs/C3_LANE_AGENT.md`, `docs/C3_PARALLEL_BATCH.md`, `tools/hunt_mcp/README.md`

- [ ] Run focused new regression suites.
- [ ] Run broader C3 backend/control/MCP suites.
- [ ] Run component-3 extension suites.
- [ ] Run Ruff format/check on every changed Python file.
- [ ] Run `node --check` on every changed JavaScript file.
- [ ] Parse changed PowerShell scripts.
- [ ] Run `git diff --check` and inspect full diff for unrelated changes.
- [ ] Perform independent spec-compliance and code-quality review; fix all critical/important findings.

## Task 7: Live activation and autonomous acceptance

- [ ] Restart worktree backend and verify process source, ledger root, and health.
- [ ] Reload only isolated C3 test profiles/extensions.
- [ ] Run controlled expected-navigation failure and verify DOM/health/validation artifacts are populated.
- [ ] Run five available jobs sequentially, one at a time.
- [ ] For each result, verify terminal state, failure-context availability, exact UI identity when evidence supports it, and explicit unknown cause otherwise.
- [ ] Verify no operation remains queued/cancelling, no worker saturation, no final Submit, and no foreground activation.
- [ ] Update smallest C3 vault handoff with current evidence and remaining honest limits.

## Execution

Selected: subagent-driven development in this existing dedicated worktree. Repository policy overrides plan-template commit steps: leave all work uncommitted unless user separately authorizes commit.
