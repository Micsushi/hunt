# C3 25-Job Strict Browser-Truth Re-audit

Date: 2026-07-25
Evidence root: `C:\Users\sushi\Documents\hunt-logs\c3-25-strict-reaudit-20260725b`

Source under test: base commit
`9b8253d69d76950390755a532bd6219a08ad42ce` plus the uncommitted control,
evidence, CLI-environment, and sensitive-option changes listed in “Changes
implemented during this audit.” The main auth/classifier/watchdog/Adobe fixes
were not present.

## Bottom line

The newer control work made the test process safer and the evidence more
trustworthy. It did **not** fix most of the application workflow.

- Fully exact C3 reports: **1/25**
- Partially correct reports: **14/25**
- Materially wrong reports: **10/25**
- Actual CAPTCHA or visible anti-bot challenge: **0/25**
- Final application submissions: **0**
- Independent final-browser checks: **25/25**

C3 therefore cannot yet be trusted to decide by itself whether a job reached
Review or why it failed. The final browser page must still be reconciled with
the operation ledger and generated report.

The earlier conclusion that 22 lanes failed because of CAPTCHA was wrong.
`noCaptchaWrapper` is an internal Workday implementation name, not proof that
a CAPTCHA was visible. Most affected lanes instead showed an explicit Workday
credential/account-lock alert, a normal Sign In page, an unavailable posting,
or a C3 control/reporting defect.

## What this run did differently

Each lane used the exact historical job ID and URL. Agents did not accept the
C3 report as truth. For every lane they:

1. waited for the C3 operation or controller to terminalize;
2. captured the pinned page directly through CDP;
3. visually inspected a PNG before reading the C3 report;
4. compared the browser, operation, events, diagnosis, artifacts, and report;
5. recorded the first divergence and separated proven from uncertain fixes;
6. verified `allow_foreground=false`, `allow_submit=false`, and no final Submit
   activation.

The initial shared-desktop minimized launcher still flashed, took focus, and
could restore when the extension opened its Options tab. Testing was stopped
twice when the user observed that behavior. The remaining lanes ran on named,
unswitched Windows desktops (`HuntC3_<port>`). A pChrome window may change its
internal minimized flag on that isolated desktop, but it cannot appear on the
user's active desktop, become the active foreground window, or receive the
user's keystrokes.

Incident and isolation proof:

- [initial focus incident](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/wave-01b-user-observed-focus-incident.md)
- [runtime restore incident](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/wave-07-runtime-focus-incident.md)
- [isolated-desktop preparation proof](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/isolated-desktop-preparation-probe.md)

## Per-lane browser truth

`Exact` means the report correctly described the final browser state and
specific cause. `Partial` means the broad area was right but the primary cause
or important evidence was wrong. `Wrong` means the report materially
contradicted the browser or authoritative operation.

| # | Exact posting | Browser truth | C3 report | Grade |
|---:|---|---|---|---|
| 1 | AMA `JR102421-1` | Explicit wrong-email/password-or-locked alert | `auth_ui_cycle_detected` after retrying unchanged credentials | Partial |
| 2 | Bird `JR-8532` | Review 6/6, Submit visible and untouched | `fill_failed / browser_execution_completed` | Wrong |
| 3 | Finning `R-2026-2351` | Review 4/4, Submit visible and untouched | `fill_failed / browser_execution_completed` | Wrong |
| 4 | Workday `JR-0104569` | Explicit credential/account-lock alert | `operation_heartbeat_missing`; specific late result ignored | Wrong |
| 5 | Adobe `R169103` | My Information; Source stayed empty/required and Province unset | Generic `visible_validation_errors` | Partial |
| 6 | AMA `JR102420-1` | Explicit credential/account-lock alert | Secondary auth cycle | Partial |
| 7 | UBC `JR23860` | Explicit credential/account-lock alert | Secondary auth cycle | Partial |
| 8 | SNDL `R6164` | Explicit credential/account-lock alert | Secondary auth cycle | Partial |
| 9 | Shell `R187261` | “The page you are looking for doesn't exist” | Treated as form validation | Wrong |
| 10 | Orion `R7559` | Explicit credential/account-lock alert | Secondary auth cycle | Partial |
| 11 | People Inc. `JR15429` | Explicit credential/account-lock alert | Secondary auth cycle | Partial |
| 12 | Workday `JR-0105395` | Explicit credential/account-lock alert | `operation_heartbeat_missing`; late result ignored | Wrong |
| 13 | NVIDIA `JR1999599` | Explicit credential/account-lock alert | Secondary auth cycle | Partial |
| 14 | CVS `R0862807` | Explicit credential/account-lock alert | Secondary auth cycle; Sign In also mislabeled as Submit | Partial |
| 15 | Capital One `R243024-1` | Explicit credential/account-lock alert | Secondary auth cycle | Partial |
| 16 | AMA repeat `JR102421-1` | Usable blank Sign In form, no error | `no_safe_next_button` based on stale signup state | Wrong |
| 17 | Finning repeat `R-2026-2351` | Review 4/4, Submit visible and untouched | `fill_failed / browser_execution_completed` | Wrong |
| 18 | Adobe repeat `R169103` | Source empty with exact required validation | Same exact visible validation failure | Exact |
| 19 | SNDL repeat `R6164` | Explicit credential/account-lock alert | Secondary auth cycle | Partial |
| 20 | Shell repeat `R187261` | Stable unavailable-posting page | `operation_heartbeat_missing` after invalid repair work | Wrong |
| 21 | Sun Life `JR00122038` | Explicit credential/account-lock alert | Secondary auth cycle | Partial |
| 22 | AMA `JR102422-1` | Usable blank Sign In form | `auth_primary_action_not_found`, retaining stale Create Account | Partial |
| 23 | Sun Life `JR00126052` | Explicit credential/account-lock alert | Secondary auth cycle; report omitted later failure artifact | Partial |
| 24 | Sun Life `JR00125115` | Empty Sign In form | Claimed authentication completed, then fields not ready | Wrong |
| 25 | Sun Life `JR00126217-1` | Explicit credential/account-lock alert | Secondary auth cycle with zero validation messages | Wrong |

Detailed reviews:

- [lanes 1–5](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-01-independent-review.md),
  [2](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-02-independent-review.md),
  [3](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-03-independent-review.md),
  [4](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-04-independent-review.md),
  [5](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-05-independent-review.md)
- [lanes 6–10](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-06-independent-review.md),
  [7](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-07-independent-review.md),
  [8](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-08-independent-review.md),
  [9](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-09-independent-review.md),
  [10](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-10-independent-review.md)
- [lanes 11–15](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-11-independent-review.md),
  [12](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-12-independent-review.md),
  [13](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-13-independent-review.md),
  [14](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-14-independent-review.md),
  [15](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-15-independent-review.md)
- [lanes 16–20](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-16-independent-review.md),
  [17](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-17-independent-review.md),
  [18](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-18-independent-review.md),
  [19](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-19-independent-review.md),
  [20](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-20-independent-review.md)
- [lanes 21–25](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-21-functional-retest-independent-review.md),
  [22](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-22-independent-review.md),
  [23](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-23-independent-review.md),
  [24](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-24-independent-review.md),
  [25](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-25-independent-review.md)

Lane 21 also had an invalid first attempt. Three concurrent lane registrations
raced while replacing `ledger/active.json`, and Windows returned
`PermissionError [WinError 5]`. That attempt never dispatched C3 and was not
used as the functional result. It is retained in the
[bootstrap review](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-21-independent-review.md)
and [backend traceback](C:/Users/sushi/Documents/hunt-logs/c3-25-strict-reaudit-20260725b/lane-21-backend-error-evidence.md).

## Confirmed code causes

### 1. Workday rejection alerts lose to generic auth repair

The browser repeatedly showed Workday's `data-automation-id="errorMessage"` /
`role="alert"` credential rejection. The alert collector in
[background/index.js](../executioner/src/background/index.js) filters text using
narrow validation words such as “error,” “required,” and “must have a value.”
Workday's actual sentence contains none of those words, so validation artifacts
often record zero errors.

The auth workflow then treats errors on the same auth page as repairable,
re-enters the same credentials, and checks the structural cycle before the
specific site error can win. This turns the agent's own retry loop into the
reported root cause.

Required fix:

- Treat a visible owned Workday error container or role-alert as an auth error
  based on structure, not a small English keyword list.
- After the first rejected Sign In, stop with
  `auth_credentials_rejected_or_account_locked`.
- Never resubmit unchanged credentials unless the first activation was proven
  not to have reached the site.
- Give a specific site error precedence over cycle detection.

### 2. Auth transitions are not stable states

Lanes 16, 22, and 24 show three variants of the same problem:

- C3 acts on Create Account.
- A transient or stale state is sampled.
- The workflow either falls into generic Safe Next, retains a stale Create
  Account candidate, or treats `unknown/unknown` as proof that auth completed.
- The real page settles as a usable Sign In form.

Required fix:

- Use one explicit workflow detector with states such as `loading`,
  `apply_choice`, `signup`, `signin`, `auth_rejected`, `application_step`,
  `review`, `maintenance`, `job_unavailable`, and `unknown`.
- A transition is complete only after two stable samples or positive evidence
  from the destination state.
- `unknown` never means “authenticated.”
- Re-detect after every wait before returning `no_safe_next_button` or
  `application_fields_not_ready_after_auth`.

### 3. Successful Review results are read from the wrong shape

Bird and both Finning runs stored
`result.stoppedReason="final_submit_visible"` directly on the operation result.
[classifier.py](../tools/c3_agent_testing/classifier.py) checks only
`result.pageWalk.stoppedReason`, then falls through to `fill_failed`.

Required fix:

- Normalize direct and nested operation results before classification.
- Make completed + `final_submit_visible` authoritative `review_ready`.
- Classify before polling for failure artifacts; successful operations should
  not wait for nonexistent failure bundles.

### 4. The watchdog mistakes a busy monitor bridge for a dead operation

On lanes 4, 12, and 20, the monitor received `monitor_bridge_busy`, outer
operation heartbeats aged, and the supervisor cancelled. Retained extension
progress showed the operation was still active. A more specific result then
arrived and was recorded as ignored after cancellation.

Required fix:

- Treat extension progress/internal heartbeat as liveness even when the
  monitoring bridge is busy.
- Do not cancel solely because the same single-threaded bridge cannot answer a
  concurrent health probe.
- Reconcile a late definitive result before committing a generic watchdog
  diagnosis.

### 5. Missing postings default to job-fill

Shell's public page says “The page you are looking for doesn't exist,” has no
application fields, and returns HTTP 200. The product detector defaults an
unrecognized page to `job_fill`, while a separate script helper already knows
the missing-page text. Generic Safe Next then treats the page-level message as
field validation.

Required fix:

- Detect terminal posting states before application-form detection.
- Default ambiguous pages to `unknown`, not `job_fill`.
- Require positive application evidence before repair or navigation.
- Return typed `job_unavailable`.

### 6. Workday dropdown commit is not proven

Adobe reproduced the same Source failure twice. The popup interaction ran, but
the field still showed `0 items selected`, the required error remained, and
Next could not advance.

Required fix:

- Bind options to the currently owned popup.
- Distinguish category rows from selectable leaves.
- After activation, require a selected pill/backing value plus cleared
  validation before considering the field filled.
- Retain the attempted option, popup generation, activation method, selected
  count, and post-action validation in the audit.

### 7. Failure artifacts and reports can be stale or contradictory

Several `validation.json` files say zero errors while the retained DOM and
direct screenshot show an alert. Lane 23's report finalized using an early
heartbeat artifact and omitted the later real failure artifact. The independent
capture helper also initially treated “main.pdf successfully uploaded” as an
error on Review.

Required fix:

- Take a bounded terminal truth snapshot for every operation.
- Reconcile URL, workflow state, visible structural alerts, current step,
  Review/Submit state, and operation result before classification.
- Refresh the report when a later authoritative artifact arrives.
- Separate success confirmations from errors in the capture helper.

### 8. Concurrent ledger registration is not safely serialized

The first lane 21 attempt proved concurrent `create_lane` calls can race while
replacing `ledger/active.json`. One request failed with `WinError 5`.

Required fix:

- Serialize active-index updates across request threads/processes.
- Keep unique temporary files, but also use one cross-thread/process lock for
  the read-modify-replace transaction.
- Retry bounded Windows sharing violations and test concurrent lane creation.

### 9. Review does not prove truthful answer quality

Bird and Finning reached Review, but retained answers included unsupported
demographic, experience, travel, and proficiency defaults. A successful browser
walk is not a valid application if C3 invented material answers.

Required fix:

- Never use a first-real-option fallback for identity, demographic, disability,
  veteran, or other sensitive questions.
- Require profile-backed material answers or a real neutral/non-disclosure
  option.
- Show every defaulted or unproven answer in the Review handoff.

## Changes implemented during this audit

These changes improve safety/evidence. They do not by themselves fix the
remaining job workflows.

- [launch_c3_chrome.ps1](../scripts/launch_c3_chrome.ps1): named unswitched
  Windows desktop per pChrome lane.
- [setup_c3_parallel_lanes.ps1](../scripts/setup_c3_parallel_lanes.ps1):
  isolated desktops enabled for test lanes.
- [verify_c3_window_safety.ps1](../scripts/verify_c3_window_safety.ps1):
  active and isolated desktop enumeration, foreground checks, and window
  ownership evidence.
- [c3_capture_final_ui.js](../scripts/c3_capture_final_ui.js): terminal PNG
  evidence in addition to JSON/TXT.
- [c3_retarget_exact_plan.py](../scripts/c3_retarget_exact_plan.py): fresh
  sessions/ports without changing exact job IDs or URLs.
- [c3_agent_batch.py](../scripts/c3_agent_batch.py): direct CLI runs load the
  repository `.env` without overriding explicit environment values.
- [option-matcher.js](../executioner/src/shared/v2/option-matcher.js): sensitive
  questions now return `sensitive_no_safe_option` instead of inventing a
  first-option answer when no safe neutral choice exists.
- Project and vault runbooks now require no-focus testing, terminal evidence
  before cleanup, a preferred maximum of 10 open test browsers, and a hard cap
  of 20.

The auth state machine, result classifier, watchdog, unavailable-posting
detector, Adobe Source driver, terminal truth reconciliation, and ledger
concurrency defects remain to be implemented.

## Fixes with high confidence

1. Structural Workday auth-alert detection and stop-after-one-rejection.
2. Direct/nested result normalization for `final_submit_visible`.
3. Positive `job_unavailable` detection before form repair.
4. Stable-state auth transitions where `unknown` is never success.
5. Progress-aware watchdog cancellation.
6. Cross-thread/process serialization of the ledger active index.
7. Refusal to infer sensitive answers.

These changes directly match retained browser and code evidence.

## Fixes that still need live proof

- **Adobe Source activation:** the failure is certain, but the exact low-level
  cause could be a stale virtualized option, wrong leaf ownership, or an
  untrusted activation. Add commit telemetry before choosing a narrow click
  fix.
- **Auth-transition timing:** a stability protocol is clearly needed, but the
  correct quiet period should be activity-based and deadline-bounded rather
  than another guessed fixed delay.
- **Credential rejection:** C3 can report the site's ambiguity correctly, but
  code cannot determine whether the email is wrong, the password is wrong, or
  the account is locked.
- **Lane 22 candidate loss:** the retained evidence proves stale Create Account
  state and a later usable Sign In form. It does not prove whether the exact
  trigger was a 2.5-second delayed transition, stale classification, or a
  transient empty candidate set.

## Input still needed from the account owner

Only one item requires user/account-owner input: verify or reset the Workday
account used by C3. The site intentionally combines wrong email, wrong password,
and account lock in one message, so logs cannot distinguish them.

Everything else above can be implemented and regression-tested without another
product decision.

## Acceptance criteria

C3 is not trustworthy end-to-end until:

1. Every available exact posting reaches Review or returns a typed cause that
   matches an independently captured final page.
2. A visible Workday credential rejection stops after one unchanged attempt.
3. Review + final Submit visible is always reported as `review_ready`.
4. Loading, auth choice, signup, signin, auth rejection, application step,
   maintenance, unavailable posting, and Review are distinct states.
5. No operation is cancelled as dead while extension progress is advancing.
6. Every dropdown fill proves persisted selection before Next.
7. Every terminal report reconciles an independent final-page snapshot.
8. Sensitive/material answers are never invented.
9. Final Submit remains visible but untouched.
