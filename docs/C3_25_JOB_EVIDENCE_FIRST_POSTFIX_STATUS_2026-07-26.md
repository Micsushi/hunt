# C3 25-job evidence-first post-fix status — 2026-07-26

## Bottom line

C3's reporting is materially more trustworthy than the original 25-job
baseline. It now distinguishes a directly proven site diagnosis from an
observation, preserves the exact action boundary, and retains enough
same-generation page evidence to explain many failures without reopening the
site.

This is not a claim that all 25 applications now autofill successfully.
Final submissions remain disabled, several real autofill issues are still open,
and not all 25 jobs have been rerun on the final code revision.

## Evidence

- Strict post-fix evidence root:
  `C:\Users\sushi\Documents\hunt-logs\c3-25-evidence-first-postfix-20260726c`
- Pre-fix 15-job baseline:
  `C:\Users\sushi\Documents\hunt-logs\c3-15-strict-audit-20260726a`
- Each strict lane was assessed in this order:
  C3 output only, independent pinned-browser inspection, then comparison.
- C3's diagnosis was never accepted as browser truth.
- No actual CAPTCHA was observed in these audits.
- Final Submit and foreground focus remained disabled.

## Latest strict reruns

| Job | Latest result | What was established |
|---|---|---|
| 2 | Exact | Reached Review 6/6; Submit visible but not clicked. |
| 3 | Partial | Correctly kept root cause unknown; older packet omitted credential completeness/action receipt. The shared boundary path was fixed and live-verified later on job 22. |
| 4 | Partial | Correctly avoided false CAPTCHA/rejection/maintenance claims; terminal snapshot timing was insufficient to distinguish slow render from a terminal loading state. |
| 17 | Exact for behavior and diagnosability | Eight preflight samples proved no candidate probe, mutation, or click. Same-generation terminal artifact showed the later ready sign-in form. |
| 22 r5 | Partial | Boundary was truthful but harmless password metadata was redacted, samples lacked timestamps, populated state was absent, and the reason was dropped. |
| 22 r6 | Main report exact; overall partial | All requested main-report fixes passed. Independent inspection matched the coherent terminal artifact. The remaining partial grade came from the secondary artifact copy and an overly conservative live-inspection flag; both are now code-fixed and tested. |
| 23 | Partial | Correct auth stage, but the failed-click packet did not normalize which candidate was selected. Candidate/action/post-action boundary support is now code-fixed and tested, not live-rerun on this job. |
| 24 | Exact | Direct visible Workday credential/account rejection; no CAPTCHA, maintenance, or unavailable job. |
| 25 | Exact evidence contract | Precisely reported a preflight stop before fields were observable and the later same-document ready form; underlying render-delay cause remained unknown. |

## Implemented reporting contract

- Known diagnoses are asserted only with direct proof: explicit credential
  rejection, maintenance/site unavailable, job unavailable, or structural
  CAPTCHA evidence.
- Otherwise C3 reports an unknown failure plus retained facts; it does not
  invent a root cause.
- Auth boundaries now retain:
  - pre-action auth/page state and sanitized URL identity;
  - document generation and frame;
  - email/password control counts;
  - separate visible and populated booleans without credential values;
  - bounded timestamped stabilization samples;
  - candidate probe, attempted, clicked, and reason receipt;
  - selected candidate identity for failed clicks;
  - post-action detection for dispatched auth actions.
- Failure artifacts retain a coherent page/field generation sidecar, terminal
  event tail, health, validation, DOM, console/network summaries, and explicit
  partial-capture errors.
- Artifact copies now preserve value-free password metadata while continuing to
  redact actual passwords, and their bounded structural depth includes the
  nested auth sample packet.
- A coherent authoritative terminal snapshot plus an action receipt removes
  the need for live inspection even when the underlying mechanism remains
  unknown. The report still labels the root cause and mechanism as unknown.
- Slow or partial Workday auth forms are sampled before mutation. C3 records
  that no candidate probe/click occurred when readiness blocks the action.

## Verification

- Final focused Python regression: **363 passed, 1 skipped**.
- JavaScript syntax check for the extension background worker: passed.
- `git diff --check`: passed except expected Windows line-ending warnings.
- Latest live job-22 r6 report:
  `lane-22-r6-c3-report.json` in the evidence root.
- Latest strict comparison:
  `lane-22-r6-comparison.md` in the evidence root.
- Cleanup receipt for older documented profiles:
  `closure-receipt-before-final-validation.md` in the evidence root.

## Still open

1. The final artifact-copy/candidate/live-inspection changes are code-tested but
   have not received another live rerun after job 22 r6.
2. Job 23 should be rerun to live-verify exact failed-click candidate identity.
3. The real job-18 Source dropdown `no_matching_option` autofill defect remains.
4. Dropdown commit problems (Source, phone code, skills) and page-readiness
   behavior still need end-to-end autofill fixes; this reporting work makes
   them diagnosable but does not itself repair every interaction.
5. A full 25-job post-final-revision audit is still required before claiming
   universal self-sufficient reporting or successful application completion.
