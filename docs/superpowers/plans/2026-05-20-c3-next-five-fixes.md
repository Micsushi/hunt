# C3 Next-Five Reliability Fix Plan

Date: 2026-05-20
Project: Hunt
Scope: C3 Workday live smoke reliability after the next-five p Chrome run

## Investigation Summary

The first next-five run looked worse than the clean rerun because multiple issues were mixed together:

- Qualcomm was not a Workday flow and has been removed from `wd_test_jobs.csv`.
- GM got stuck on Voluntary Disclosures because the neutral checkbox text was `I do not wish to answer. (United States of America)`, which C3 did not recognize as a non-disclosure option. Page-side code proved clicking the label advances the flow.
- CVS Application Questions were filled correctly. Page-side code clicking Save and Continue advanced it, so the bug is likely runner advancement/reporting around pages that are visibly valid but still marked manual-review.
- Pfizer date filling works on a clean rerun with unchanged C3 code. The bad manual attempt corrupted the Workday split date widget, but the clean existing C3 path filled `5`, `20`, `2026` and advanced to Application Questions 2 of 2.
- Pfizer still emits noisy commit warnings because C3 expects zero-padded date parts like `05`, while Workday normalizes month/day inputs to `5` and `20`.
- RTX is blocked by an email verification gate. That should be classified as auth verification required, not treated as a fill bug.
- The first batch harness was noisy because PowerShell surfaced native stderr as `NativeCommandError`, making long-running jobs and interim stuck states harder to interpret.

## Principles

- Do not replace C3 date filling yet. The clean Pfizer rerun showed the existing UI route can fill and advance.
- Fix the smallest proven failures first: option matching, commit verification, runner retry/advance semantics, and harness observability.
- Keep final submit disabled in live smoke runs.
- Preserve p Chrome lanes and off-main-monitor launch validation.

## Changes To Make

### 1. Add GM neutral disclosure alias coverage

Files:

- `executioner/src/shared/v2/field-catalog.js`
- Existing C3 field/option tests, likely `tests/test_component3_stage1.py`

Bug:

For checkbox fields with `answerType: "non_disclosure"`, `option-matcher.js` intentionally refuses to pick a fallback option unless `neutralOption()` finds a known neutral alias. GM's option text was a valid neutral answer but was missing from the alias list.

Implementation:

- Add `I do not wish to answer` to the shared `nonDisclosureAliases`.
- Add `I do not wish to answer (United States of America)` and punctuation-tolerant coverage to the ethnicity neutral aliases.
- Add a focused test proving C3 selects a checkbox option labeled `I do not wish to answer. (United States of America)`.

Verification:

- Run the focused option-matching/component test.
- Live rerun GM until Voluntary Disclosures advances past the race/ethnicity required error.

### 2. Normalize Workday date-part commit verification

Files:

- `executioner/src/shared/v2/field-drivers.js`
- Date or Workday component tests, likely `tests/test_component3_stage1.py` or `tests/test_component3_workday_fill.py`

Bug:

`answer-resolver.js` correctly supplies `05/20/2026`, but Workday stores the month as raw `5`. `fillText()` currently verifies strict text equality, so a successful commit can be reported as `workday_commit_not_verified`.

Implementation:

- Add a small helper for date-section inputs:
  - `dateSectionMonth` and `dateSectionDay`: compare numeric value after trimming leading zeroes.
  - `dateSectionYear`: compare exact numeric string.
  - Empty, non-numeric, or malformed values remain failures.
- Use the helper only in `fillText()` commit verification for Workday date-section inputs.
- Keep the actual fill behavior unchanged.

Verification:

- Unit test: expected `05`, committed `5` passes for month.
- Unit test: expected `09`, committed `9` passes for day.
- Unit test: wrong month/day/year still fails.
- Live rerun Pfizer clean and confirm the date page advances without commit warnings for the month/day fields.

### 3. Make runner advancement explicit when fields are visibly valid

Files:

- `scripts/c3_workday_live_smoke.js`
- Existing smoke runner tests or a new focused test if there is no coverage

Bug:

CVS and Pfizer both showed a pattern where the page had no visible validation errors after fill, but the fill result still carried manual-review or best-effort warnings. The clean Pfizer run advanced, but the audit trail makes this look like a failure and the batch harness can misclassify it as stuck.

Implementation:

- After fill, always re-inspect visible errors after a short bounded wait.
- If there are no visible errors and a next/save button is enabled, allow one guarded Save/Next retry even when fill status is manual-review.
- Record this as an explicit audit event, for example `forced_next_after_no_visible_errors_manual_review`.
- Include the manual-review reasons and best-effort warnings in the audit event rather than losing them.
- Keep blocking behavior if visible required errors remain.

Verification:

- Runner test or fixture proving manual-review plus no visible errors results in a guarded next attempt.
- Live rerun CVS and confirm Application Questions advances without manual page-side Save.
- Live rerun Pfizer and confirm the date page advances cleanly.

### 4. Suppress stale Workday date validation only after real value proof

Files:

- `scripts/c3_workday_live_smoke.js`

Bug:

Workday can leave required date validation text in the DOM after the visible date segments are populated. The current suppressor is useful, but the plan should tighten it around actual date-section values and audit why the error was suppressed.

Implementation:

- Keep `suppressStaleWorkdayDateErrors()` but require month, day, and year values to be present for the same date group.
- Treat numeric month/day values with and without leading zeroes as valid.
- Emit an audit entry when stale date errors are suppressed, including the observed month/day/year values.
- Do not suppress invalid-date text or incomplete date groups.

Verification:

- Add/extend a test fixture for stale required text with complete date parts.
- Add negative fixture for incomplete date parts.
- Live Pfizer rerun: no visible date error after advancement.

### 5. Classify auth gates and non-Workday URLs clearly

Files:

- `scripts/c3_workday_live_smoke.js`
- `scripts/lib/c3_issue_registry.js` if final issue classification is centralized there

Bug:

RTX ended on an email verification gate. The audit contains the final visible error `An email has been sent to you. Please verify your account.`, but top-level `ok` is still `true`, which makes the run look verified when it was actually blocked. Qualcomm was not a Workday apply flow. These are environmental/classification outcomes, not C3 fill failures.

RTX root cause from log/mail investigation:

- The run used `scripts/c3_workday_live_smoke.js` in manual mode, not the fresh-account bootstrap path.
- `c3_workday_live_smoke.js` set `workflow.auth.skipped = true` with reason `handled_outside_live_smoke`, but the page loop still attempted auth pages as normal fill pages.
- First auth attempt filled Sign In and clicked `Sign In`; Workday returned `You may have entered the wrong email address or password or your account might be locked.`
- The runner then filled the Create Account page and clicked `Create Account`.
- Workday did create or start the account verification flow: IMAP lookup found a real message with subject `Verify your candidate account`, source `imap`, received at `2026-05-20T07:11:33.000Z`, and a Workday activation link.
- The RTX run never invoked the mail bridge during this flow. The log contains no `await_email_verification`, `email_verification`, `request_email_verification`, or bridge result event.
- After account creation, Workday showed `An email has been sent to you. Please verify your account.` The live-smoke verification regex only handled older phrases such as `verify your account before you sign in` and `request a verification email`, so this exact message was not classified early enough.
- The script then finished with `audit.ok = true` unconditionally after final inspection, even though final visible errors contained the verification message.
- IMAP itself is not the blocker: `node scripts\c3_mail_verify_bridge.js --check-auth --provider imap` succeeded against `imap.gmail.com`, and a one-shot IMAP lookup extracted the RTX verification link.

Implementation:

- Detect common auth verification text, including:
  - `An email has been sent to you. Please verify your account.`
  - `verify your account before you sign in`
  - `request a verification email`
- Return/report `auth_verification_required` as a terminal reason.
- Set the top-level status so the run is not reported as successfully verified when auth verification blocks progress.
- Include `auth_verification_required` in the final summary and audit JSON alongside the exact visible verification message.
- Do not let `c3_workday_live_smoke.js` improvise account creation without a mail bridge handoff. Choose one:
  - Preferred: for fresh/new Workday accounts, run `scripts/c3_workday_fresh_apply_smoke.js`, which calls `scripts/c3_email_verification_smoke.js` before application fill.
  - Or: teach `c3_workday_live_smoke.js` to invoke the same mail verification bridge when its auth-page loop creates an account and then sees a verification-needed state.
- Detect non-Workday application URLs before entering Workday-specific smoke logic and report `non_workday_url` or `unsupported_apply_host`.
- Make these statuses visible in summary output and audit JSON.

Verification:

- Fixture or unit test for auth gate classification.
- Fixture or command-level test for non-Workday URL classification.
- Live RTX rerun only to the verification gate, no final submit.
- Expected RTX result after fix: terminal reason `auth_verification_required`, exact visible message preserved, and no misleading top-level successful verification.

### 6. Harden the p Chrome batch launcher and logs

Files:

- Prefer a new script such as `scripts/c3_workday_parallel_batch.js`, or a small PowerShell wrapper if repo style strongly favors PowerShell.

Bug:

The first batch used PowerShell job/redirection behavior that made stderr look like errors and made interim states hard to read. It also created confusion between installed Chrome and p Chrome.

Implementation:

- Launch only the Playwright Chromium binary under `AppData\Local\ms-playwright`.
- Use the existing p Chrome profiles and ports: `9231` through `9235`.
- Validate each lane with process command-line checks before running jobs:
  - binary path contains `ms-playwright`
  - remote debugging port matches the lane
  - profile path matches `ChromeC3PlaywrightParallel`
  - extension ID is reachable
- Capture stdout and stderr to plain log files without PowerShell `NativeCommandError` wrapping.
- Write a compact batch summary JSON with per-job status, final step, final visible errors, and audit path.

Verification:

- Dry-run launcher test validates command construction.
- One-job smoke test on a known safe Workday URL.
- Full five-lane rerun after the code fixes.

## Recommended Implementation Order

1. Add tests for GM alias and date commit normalization.
2. Implement the alias additions and date-part commit helper.
3. Add runner tests/fixtures for guarded next after no visible errors and stale date suppression.
4. Implement runner audit/status changes.
5. Add auth/non-Workday classification.
6. Add or harden the batch launcher.
7. Rerun live p Chrome tests on GM, CVS, Pfizer, and RTX.
8. Inspect the RTX audit specifically and confirm top-level status no longer implies success when account verification is required.

## Verification Command Set

Run focused tests first:

```powershell
python -m pytest -q tests\test_component3_stage1.py tests\test_component3_workday_fill.py tests\test_component3_prompt.py
node --check executioner\src\shared\v2\field-catalog.js
node --check executioner\src\shared\v2\field-drivers.js
node --check scripts\c3_workday_live_smoke.js
```

Then live smoke:

```powershell
node scripts\c3_workday_live_smoke.js --mode manual --cdp-port 9231 --resume main.pdf --extension-id cbdmkibihimaedoihjhpidclolglnncc --clear-before-fill --close-other-workday-tabs --max-pages 8 --fills-per-page 1 --fill-message-timeout-ms 300000 --no-llm-answers --audit-json logs\gm_after_fix.audit.json
node scripts\c3_workday_live_smoke.js --mode manual --cdp-port 9232 --resume main.pdf --extension-id cbdmkibihimaedoihjhpidclolglnncc --clear-before-fill --close-other-workday-tabs --max-pages 8 --fills-per-page 1 --fill-message-timeout-ms 300000 --no-llm-answers --audit-json logs\cvs_after_fix.audit.json
node scripts\c3_workday_live_smoke.js --mode manual --cdp-port 9234 --resume main.pdf --extension-id cbdmkibihimaedoihjhpidclolglnncc --clear-before-fill --close-other-workday-tabs --max-pages 4 --fills-per-page 1 --fill-message-timeout-ms 300000 --no-llm-answers --audit-json logs\pfizer_after_fix.audit.json
node scripts\c3_workday_live_smoke.js --mode manual --cdp-port 9235 --resume main.pdf --extension-id cbdmkibihimaedoihjhpidclolglnncc --clear-before-fill --close-other-workday-tabs --max-pages 2 --fills-per-page 1 --fill-message-timeout-ms 300000 --no-llm-answers --audit-json logs\rtx_auth_after_fix.audit.json
```

The live commands need the specific job URL added for each target before running.

## Stop Conditions

- Do not click final Submit.
- If a page asks for email verification, stop and report `auth_verification_required`.
- If a job URL is not a Workday application flow, stop and report `unsupported_apply_host` rather than trying to force it through C3.
- If a date page still fails after normalized commit verification, capture the DOM state and only then consider a dedicated Workday split-date driver.
