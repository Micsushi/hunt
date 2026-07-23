# C3 Last-20 Functional Remediation Implementation Plan

> REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans.

**Goal:** Fix the reusable detection and functional boundaries found across the last 20 C3 jobs.

**Architecture:** Extend the existing extension-to-operation terminal envelope with bounded structural evidence. Repair the Workday auth/page-walk state machine and isolated-lane prerequisites without weakening target ownership, privacy, or Submit safety.

**Tech Stack:** Python/FastAPI/Pydantic, Chrome MV3 JavaScript, Workday DOM drivers, pytest, Node syntax/fixture tests, PowerShell lane setup.

**Repository rule:** Do not commit, stage, push, or modify regular Chrome. User did not authorize git publication.

## Task 1: Persist actionable terminal evidence

**Files:** Modify `backend/c3_operations.py`, `backend/c3_failure_context.py`, `tests/test_c3_operations.py`, `tests/test_c3_failure_context.py`.

- [ ] Add a failing operations test with bridge response containing `stoppedReason`, compact `stopDetails`, terminal auth step, and a stable `nearMissCandidates` button. Assert `operation.failed.error.failure_evidence` retains structural fields and excludes email/password/value keys.
- [ ] Run `pytest tests/test_c3_operations.py -k 'bridge_failure and auth' -q`; confirm failure is missing evidence.
- [ ] Add bounded extractor: last matching terminal step, allowlisted stop-details keys, and at most eight structural candidates. Reuse event sanitizer.
- [ ] Add failing failure-context tests for `auth_primary_action_not_found`, `auth_signup_signin_loop`, and `workday_runtime_not_ready` expected/observed states and next actions.
- [ ] Implement specialized scopes/confidence/missing-evidence rules. Stable near-miss candidate is expected action evidence, not automatically a proven broken element.
- [ ] Run focused operation/failure-context suites to green.

## Task 2: Continue signup-to-signin auth chain

**Files:** Modify `executioner/src/background/index.js`, `tests/test_component3_stage1.py`.

- [ ] Add failing source/fixture assertions requiring a bounded `signupToSigninTransitions` counter, `auth_signup_to_signin_continue` step, and typed `auth_signup_signin_loop` terminal.
- [ ] Run `pytest tests/test_component3_stage1.py -k 'signup_to_signin' -q`; confirm failure.
- [ ] Replace immediate `auth_create_account_to_signin_sink` break with one recorded continuation and `pageIndex -= 1`; repeated transition stops as `auth_signup_signin_loop`.
- [ ] Preserve visible validation and email-verification gates before continuation.
- [ ] Run focused stage tests to green.

## Task 3: Accept stable email sign-in gateway and retain near misses

**Files:** Modify `executioner/src/background/index.js`, `tests/test_component3_stage1.py`.

- [ ] Add failing assertions/fixture for `button[data-automation-id="SignInWithEmailButton"]` when `authState=login` and `authUiState` is stale/non-landing.
- [ ] Change auth scoring so exact stable email gateway is eligible for any sign-in state, while social and generic navigation controls remain excluded.
- [ ] Return up to eight zero-score actionable near misses with stable structural identity when no candidate wins.
- [ ] Include auth state/UI state and near misses in blocked auth step/stop details.
- [ ] Run focused stage tests to green.

## Task 4: Classify empty Workday runtime before missing Next

**Files:** Modify `executioner/src/background/index.js`, `tests/test_component3_stage1.py`, `tests/test_c3_failure_context.py`.

- [ ] Add failing assertions/fixture for empty `#root`, no step/fields/validation/loading surface: missing Next must wait, then return `workday_runtime_not_ready`.
- [ ] Add bounded runtime readiness helper using existing workflow/readiness probes. Rendered pages keep current safe-Next behavior.
- [ ] Record readiness probe summary in stop details and failure evidence.
- [ ] Run focused stage/failure-context tests to green.

## Task 5: Seed and verify default resume in isolated lanes

**Files:** Modify `scripts/configure_c3_debug_sink.js`, `scripts/setup_c3_parallel_lanes.ps1`, `tests/test_component3_stage1.py`.

- [ ] Add failing tests requiring `--resume`, readable-file preflight, `hunt.apply.defaultResume` storage, and inspect-only `defaultResumeReady` confirmation.
- [ ] Encode configured PDF once in Node, seed bounded metadata/data URL into local extension storage, and never print contents.
- [ ] Pass worktree `main.pdf` from setup and reject missing/unconfirmed resume before lane execution.
- [ ] Run focused stage tests and PowerShell parse check to green.

## Task 6: Verify Adobe Source and Bird cancellation regressions

**Files:** Modify only tests or production code proven deficient by red tests.

- [ ] Run Source commit tests covering active popup scoping, `promptLeafNode`, selected pill, and backing value.
- [ ] Run cancellation tests covering acknowledgement, retry-after, orphan terminalization, and released lease.
- [ ] If a focused test fails, use one-variable root-cause cycle and minimal patch. Otherwise record existing implementation as sufficient.

## Task 7: Full verification and live acceptance

**Files:** Update smallest relevant docs/handoff after evidence exists.

- [ ] Run backend, runner/MCP, runtime/stage, generic extension, Workday, and static gates.
- [ ] Restart only verified worktree backend. Confirm `/health` and exact PID/source.
- [ ] Reload isolated pChrome profiles only.
- [ ] Run five representative jobs sequentially with `allow_foreground=false`, `allow_submit=false`.
- [ ] Compare Review reach, root cause, exact action evidence, artifacts, stalls, and safety to prior 20-job baseline.
- [ ] Update `modules/c3-current-handoff.md`; keep under 80 lines/8 KB.
