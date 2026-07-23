# C3 25-Lane Review Remediation

Date: 2026-07-22

## Goal

Explain what stopped each of the 25 sequential C3 test lanes and what must change for each lane to reach the Workday Review page while preserving the existing safety rule: C3 may detect final Submit, but must not activate it.

## Evidence and counting

- Twenty-lane report: `C:\Users\sushi\Documents\hunt-logs\c3-last20-sequential-acceptance-20260722a\sequential-20-results.md`
- Next-five report: `C:\Users\sushi\Documents\hunt-logs\c3-next5-identification-20260722a\next5-results.md`
- The evidence contains 25 test lanes and 20 unique postings. Five of the first 20 lanes were deliberate repeat regressions.
- The next-five planner could not prove availability for People Inc. `JR15306`, UBC `JR24622`, or BDO `JR5464` because their preflight requests returned HTTP 403. Those three postings were not tested and are not included below. Three verified-live Sun Life postings replaced them.
- All 25 lanes ran sequentially with `allow_foreground=false` and `allow_submit=false`. None hard-stalled, focused the user's screen, or activated final Submit.

## Outcome summary

| Failure class | Lanes | Unique postings | Review outcome | What actually needs fixing |
|---|---:|---:|---|---|
| Workday CAPTCHA/authentication gate | 22 | 18 | Did not pass Sign In | Add a safe gate-clearance and resume path; C3 cannot legitimately bypass an external CAPTCHA. |
| Adobe Source widget commit failure | 2 | 1 | Blocked before Review | Make hierarchical Source selection commit a real leaf and prove selected state before advancing. |
| Bird post-terminal reporting/finalization defect | 1 | 1 | Review reached | Application flow already passed; make the runner return the authoritative completed/Review result promptly. |

The detection plane identified 22 CAPTCHA failures strongly and completely. Detection is not the remaining problem for those lanes. The remaining problem is orchestration after a legitimate external gate.

## Per-lane findings and route to Review

| # | Actual tested posting | Observed issue | Exact failing boundary | Required route to Review |
|---:|---|---|---|---|
| 1 | AMA — Insurance Advisor (`JR102421-1`) | External CAPTCHA gate | `button[type='submit'][data-automation-id='signInSubmitButton']` | Clear CAPTCHA through an approved human/session path, then resume the same pinned application target. |
| 2 | Bird Construction (`JR-8532`) | Runner/report defect after success | Ledger completed at `final_submit_visible`; resumed report said `fill_failed/browser_execution_completed` | No form fix. Return `review_ready` immediately from authoritative completed state and bound post-terminal finalization. |
| 3 | Finning (`R-2026-2351`) | External CAPTCHA gate | Exact `signInSubmitButton`; earlier isolated-lane resume prerequisite was already corrected | Clear gate, confirm authenticated application state, then resume page walk with the seeded resume. |
| 4 | Workday (`JR-0104569`) | External CAPTCHA gate | Exact `signInSubmitButton` | Approved gate clearance plus same-target resume. |
| 5 | Adobe (`R169103`) | Source option did not commit | Required `input#source--source` stayed `0 items selected`; validation blocked Next | Traverse the active Source popup to a truthful leaf, activate its real React/trusted target, and require selected-pill/backing-value proof. |
| 6 | AMA Edmonton (`JR102420-1`) | External CAPTCHA gate | Exact `signInSubmitButton` | Approved gate clearance plus same-target resume. |
| 7 | UBC (`JR23860`) | External CAPTCHA gate | Exact `signInSubmitButton` | Approved gate clearance plus same-target resume. |
| 8 | SNDL (`R6164`) | External CAPTCHA gate | Exact `signInSubmitButton`; credential provenance was captured correctly | Clear gate without rewriting credentials, verify auth transition, then resume. |
| 9 | Shell (`R187261`) | External CAPTCHA gate after prior auth fixes passed | Exact `signInSubmitButton`; email gateway, credential form, and cycle detection worked | Clear gate and resume. Do not reopen the already-fixed gateway/state logic unless new evidence differs. |
| 10 | Orion Steel (`R7559`) | External CAPTCHA gate after runtime fix passed | Exact `signInSubmitButton`; page no longer stopped at an empty Workday root | Clear gate and resume. Do not classify this as runtime readiness or missing Next. |
| 11 | People Inc. (`JR15429`) | External CAPTCHA gate | Exact `signInSubmitButton`; credential provenance retained | Approved gate clearance plus same-target resume. |
| 12 | Workday ML Ops (`JR-0105395`) | External CAPTCHA gate | Exact `signInSubmitButton` | Approved gate clearance plus same-target resume. |
| 13 | NVIDIA (`JR1999599`) | External CAPTCHA gate | Exact `signInSubmitButton` | Approved gate clearance plus same-target resume. |
| 14 | CVS Health (`R0862807`) | External CAPTCHA gate after email-gateway fix passed | Exact `signInSubmitButton`; stable email gateway and credential preparation worked | Clear gate and resume. Preserve the corrected `SignInWithEmailButton` eligibility. |
| 15 | Capital One (`R243024-1`) | External CAPTCHA gate | Exact `signInSubmitButton` | Approved gate clearance plus same-target resume. |
| 16 | AMA repeat (`JR102421-1`) | Same external CAPTCHA gate; diagnosis stable | Exact `signInSubmitButton` | Same fix as lane 1; one reusable gate-resume implementation covers both. |
| 17 | Finning repeat (`R-2026-2351`) | Same external CAPTCHA gate; diagnosis stable | Exact `signInSubmitButton` | Same fix as lane 3. |
| 18 | Adobe repeat (`R169103`) | Same Source commit failure reproduced | `input#source--source` stayed `0 items selected` | Same functional Source fix as lane 5; repeat lane is the regression acceptance target. |
| 19 | SNDL repeat (`R6164`) | Same external CAPTCHA gate; diagnosis stable | Exact `signInSubmitButton` | Same fix as lane 8. |
| 20 | Shell repeat (`R187261`) | Same external CAPTCHA gate; prior auth fixes remained stable | Exact `signInSubmitButton` | Same fix as lane 9. |
| 21 | Sun Life — Engineering Manager (`JR00122038`) | External CAPTCHA gate | Exact `signInSubmitButton`; strong complete packet | Approved gate clearance plus same-target resume. |
| 22 | Alberta Motor Association — Insurance Advisor Level 1 (`JR102422-1`) | External CAPTCHA gate | Exact `signInSubmitButton`; strong complete packet | Approved gate clearance plus same-target resume. |
| 23 | Sun Life — Business & Systems Consultant (`JR00126052`) | External CAPTCHA gate | Exact `signInSubmitButton`; strong complete packet | Approved gate clearance plus same-target resume. |
| 24 | Sun Life — Security Platform Engineer - EDR, Proxy (`JR00125115`) | External CAPTCHA gate | Exact `signInSubmitButton`; strong complete packet | Approved gate clearance plus same-target resume. |
| 25 | Sun Life — Client Relationship Manager (`JR00126217-1`) | External CAPTCHA gate | Exact `signInSubmitButton`; strong complete packet | Approved gate clearance plus same-target resume. |

## Remediation A: CAPTCHA gate clearance and resumable lanes

This is the highest-leverage change because it covers 22 of 25 lanes. It must not be implemented as a CAPTCHA bypass or blind click loop.

### Root cause

Workday exposed the credential form but kept the exact Sign In submit boundary behind a CAPTCHA/noCaptcha gate. C3 correctly rejected the CAPTCHA wrapper and click-filter containers as unsafe controls. With foreground activation forbidden and no approved challenge solver or human takeover in the lane, there was no valid autonomous transition to the application pages.

### Required design

1. Replace terminal `failed` for a proven CAPTCHA with a durable `awaiting_captcha_clearance` blocked state. The state must retain lane, session, target, operation lineage, credential-preparation proof, and gate evidence without retaining credentials.
2. Release the mutation lease while blocked. Permit only a recorded human override or approved CAPTCHA integration to interact with the isolated lane.
3. Run each browser inside a separate virtual display, VM, or remote desktop session. If Workday requires an active page, foregrounding occurs only inside that isolated display and never takes over the user's desktop.
4. Prefer tenant-scoped persistent authenticated profiles. Preflight should report whether the session is already authenticated, challenged, expired, or missing; valid sessions avoid repeated challenge creation.
5. Complete the existing C4 escalation chain: C3 reports CAPTCHA type plus approved solver-extension presence/status; C4 notifies the operator when automatic clearance is unavailable; the human action is appended to the ledger.
6. Watch for an objective state change: CAPTCHA surface disappears, Sign In becomes actionable or navigation occurs, and the application/auth state changes. Retry only after that evidence changes; never repeatedly click the blocked button.
7. After clearance, create a fresh bounded operation linked to the blocked operation, reclaim the lane lease, revalidate the exact browser target, and resume `c3.page_walk` from the observed page. Do not restart from the stale CSV URL if the live application target already advanced.
8. Preserve `allow_submit=false`. Success is Review visible with final Submit detected but untouched.

### What can and cannot be autonomous

- Fully unattended completion is possible when a tenant-scoped authenticated session remains valid or an approved challenge integration legitimately clears the gate.
- If the site requires a new interactive CAPTCHA, C3 cannot guarantee unattended Review without external clearance. The correct behavior is immediate typed escalation and resumable continuation, not bypass, guessing, or a false stall.

### Acceptance criteria

- A proven CAPTCHA becomes `awaiting_captcha_clearance` within one monitor interval.
- The packet still names `signInSubmitButton` and the exposing CAPTCHA surface.
- No lease remains held during human takeover.
- Clearing the challenge resumes the same target without duplicate account creation or credential loss.
- Every resumed representative lane reaches Review or returns a new exact field-level cause.

## Remediation B: Adobe `source--source` functional commit

### Root cause

The active Workday Source popup opened, but C3 did not produce a committed selected item. The field remained `0 items selected`; required-field validation then blocked Next. The repeat lane reproduced the same boundary. The standard terminal diagnosis now has regression coverage for correlating validation to `input#source--source`, but the real Adobe option commit still needs live proof.

### Required implementation

1. Bind option collection to the popup owned by `source--source`; reject detached, hidden, stale, or unrelated listboxes.
2. Treat category rows and selectable leaf rows differently. Traverse the configured truthful category, wait for the popup generation/options to change, then select a leaf.
3. Activate the semantic leaf target used by Workday—such as `promptLeafNode`, its owning option/radio, or the React handler target—using the existing trusted-input bridge when DOM click does not commit.
4. Keep the popup open until commit proof exists. Do not convert a click acknowledgement into success.
5. Require at least one authoritative proof: a non-placeholder `selectedItem` pill, matching backing value/selected ID, or matching selected/checked state, with required validation cleared. `0 items selected` is always failure evidence.
6. If the requested source is absent, choose only a configured truthful fallback that is actually exposed. Otherwise pause for manual review; do not invent how the applicant found the job.
7. On failure, emit `workday_commit_not_verified` with the exact control, attempted category/leaf, click method, popup generation, pre/post selected count, validation message, and bounded option identities.

### Tests and live proof

- Keep the existing hierarchical, flat-category, safe-leaf, React-click, selected-pill, backing-value, and validation-clear fixtures.
- Add a sanitized Adobe-shaped fixture matching the retained popup hierarchy and event ownership from the failed artifact.
- Re-run Adobe twice sequentially. Both runs must leave `source--source` committed, advance every page, and stop at Review.

## Remediation C: Bird terminal classification and runner finalization

### Root cause

Bird already reached Review page 7 after six pages. The ledger operation completed with `stoppedReason=final_submit_visible`. The defect was outside page filling: the outer runner exceeded its wait after terminal completion, and `resume-report` incorrectly reduced the completed Review result to `fill_failed/browser_execution_completed`.

### Required implementation

1. Give authoritative operation state precedence over a generic terminal reason. `state=completed` plus Review/final-submit evidence must classify as `review_ready`.
2. End operation polling immediately after the first authoritative terminal state.
3. Bound lane-finalization and late-artifact refresh separately from the browser deadline. A reporting delay must never become an operation stall.
4. Make lane finish idempotent. On a terminal conflict, read the existing terminal lane record and return it instead of retrying page work.
5. For completed Review operations, artifacts are optional; do not wait for a failure packet that is not required.

The current branch contains the classifier precedence and bounded terminal refresh logic with unit coverage. A fresh Bird live run is still required before calling the runner defect live-fixed.

### Acceptance criteria

- Bird reaches `final_submit_visible` with `submit_activated=false`.
- Lane report returns `review_ready`, not `fill_failed`.
- Report finalization completes within 10 seconds of authoritative operation terminalization.
- Re-running `resume-report` returns the same terminal identity and classification without browser mutation.

## Already-corrected issues that should not be reopened blindly

Earlier tests in this thread exposed reusable problems that were corrected before the final 25-lane accounting:

- signup-to-signin continuation stopped too early;
- stable `SignInWithEmailButton` was rejected after UI-state drift;
- an empty Workday root was misclassified as missing Next instead of runtime-not-ready;
- isolated lanes could start without a verified default resume;
- credential-preparation provenance was dropped from terminal evidence;
- validation messages could lose their associated field identity.

The final runs proved the relevant Shell, CVS, Orion, Finning, SNDL, and failure-context paths no longer stopped at those old boundaries. Reopen them only if a new run returns evidence that differs from the final packets.

## Recommended implementation order

1. **CAPTCHA blocked-state and same-target resume:** unlocks a path forward for 22 lanes.
2. **Isolated virtual-display execution and C4 clearance handoff:** allows required page activation without controlling the user's screen.
3. **Adobe Source live commit fix:** resolves the only reproduced field-level blocker.
4. **Bird live terminal-finalization acceptance:** confirms the already-coded reporting correction.
5. **Sequential acceptance:** run the 20 unique postings one at a time. Repeats remain targeted regressions for AMA, Finning, Adobe, SNDL, and Shell.

## Definition of done

For every available posting:

- C3 reaches Workday Review and reports `review_ready`;
- final Submit is visible but never activated;
- no browser controls the user's desktop;
- every external gate is either cleared through an approved path or immediately escalated with a resumable lane;
- every field failure names the exact causal control and commit/validation evidence;
- no operation stall is confused with post-terminal reporting delay;
- a second report read is idempotent and returns the same terminal identity.
