# C3 Last-20 Functional Remediation Design

## Goal

Turn the last 20 Workday failures into reusable C3 fixes: preserve enough structural evidence for blind diagnosis, continue valid authentication chains, reject false navigation failures, and guarantee test-lane resume prerequisites.

## Evidence Set

- Ten blind lanes: `C:\Users\sushi\Documents\hunt-logs\c3-prev-next10-blind-20260721c\current_debug.md`
- Five remediation lanes: `C:\Users\sushi\Documents\hunt-logs\c3-remediation-acceptance-20260722`
- Five post-remediation lanes: `C:\Users\sushi\Documents\hunt-logs\c3-next5-post-remediation-20260722`

The 20 outcomes reduce to six reusable boundaries:

1. Fifteen signup-to-signin transitions were stopped before C3 tried the valid login continuation.
2. CVS exposed `SignInWithEmailButton`, but auth action scoring rejected it after UI-state classification drift.
3. Orion exposed an empty Workday application root; C3 reported `no_safe_next_button` instead of page readiness failure.
4. Finning reached a required resume upload without a seeded default resume.
5. Adobe Source selection lacked verified selected-pill/backing-state commit evidence.
6. Bird cancellation acknowledgement was lost; current control-plane work already fixes this boundary and needs regression verification.

## Chosen Design

### 1. Structural terminal evidence

Extension bridge failures persist a bounded, privacy-safe envelope:

- stopped reason;
- compact stop details;
- final workflow/auth state transition;
- terminal step kind and reason;
- up to eight visible near-miss action candidates containing only tag, role, stable selector/automation ID, label, disabled state, and score.

No applicant-entered field values, passwords, emails, DOM text dumps, or raw response objects are persisted. Failure-context projection specializes auth-action, auth-loop, runtime-readiness, resume-preflight, and commit failures. Expected action stays distinct from proven causal element and last-touched element.

### 2. Bounded authentication continuation

Signup-to-signin is a normal state transition, not an immediate terminal. C3 records transition, decrements page-walk index, and continues using the configured account credentials. One signup-to-signin continuation is allowed per run. Repetition becomes typed `auth_signup_signin_loop` with from/to states and last safe candidate.

Stable email gateway controls such as `SignInWithEmailButton` remain eligible whenever C3 wants sign-in, even if `authUiState` was misclassified. Generic social-login and navigation controls remain rejected.

### 3. Runtime readiness before navigation

Before reporting missing Next, C3 distinguishes an empty/unrendered Workday shell from a rendered application surface. Empty root, no step, no fields, no validation, and no safe navigation trigger a bounded readiness wait. Persistent emptiness becomes `workday_runtime_not_ready`, not a UI-element failure. No final Submit is ever clicked.

### 4. Resume prerequisite

Isolated batch setup seeds and verifies a default PDF resume alongside the Workday profile. Setup fails before lane mutation if the configured resume is absent or storage confirmation fails. Production active-apply context remains authoritative when present.

### 5. Existing fixes retained

Current Source driver must prove selected pill/backing value and keep option selection scoped to the active popup. Existing Bird cancellation reconciliation remains unchanged unless regression tests fail.

## Error Contract

- `auth_signup_signin_loop`: bounded auth chain returned to Sign In repeatedly.
- `auth_primary_action_not_found`: no safe action; includes bounded near-miss candidates when present.
- `workday_runtime_not_ready`: Workday shell never exposed application/auth/navigation surface within budget.
- `resume_preflight_missing`: lane setup lacks readable default resume.
- `workday_commit_not_verified`: attempted option failed selected-pill/backing-state proof.

## Verification

1. Red/green focused unit and fixture tests for each boundary.
2. Full backend, runner/MCP, generic extension, Workday, and stage suites.
3. Static Python/JavaScript/PowerShell/diff checks.
4. Restart worktree backend and reload only isolated pChrome profiles.
5. Sequential representative live retests: auth sink, CVS gateway, Orion readiness, resume path, and Adobe Source. Stop on weekly remaining capacity warning at or below 25%.

## Non-goals

- Tenant-specific hardcoding.
- CAPTCHA, MFA, email-code bypass, or final Submit.
- Raw DOM in MCP failure packets.
- Full Workday state-machine rewrite.
