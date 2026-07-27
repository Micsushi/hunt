# C3 Evidence-First Terminal Reporting Implementation

## 1. Regression contracts

- Extend workflow-detection tests for maintenance, missing jobs, explicit
  credential rejection, blank loading shells, application pages, Review, and
  direct CAPTCHA evidence.
- Extend auth-transition tests so same-page credential alerts stop immediately,
  unknown never authenticates, and cycles cannot mask site alerts.
- Extend classifier tests for top-level and nested page-walk results.
- Extend failure-context tests for unfiltered visible facts, source conflicts,
  evidence completeness, and `unclassified_failure`.
- Extend watchdog tests so fresh semantic progress prevents cancellation.
- Add concurrent ledger writer tests.
- Extend Workday Source tests with explicit commit/non-commit evidence.

## 2. Browser truth collection

- Return an explicit page kind instead of defaulting to `job_fill`.
- Capture all bounded visible alerts and messages without keyword filtering.
- Add maintenance, unavailable-job, and direct CAPTCHA structural observations.
- Rank all-frame observations by direct evidence and useful page structure.
- Retain stable before/after observation samples for auth transitions.

## 3. Auth and page-walk behavior

- Evaluate direct rejection evidence before loop detection or retries.
- Stop retrying unchanged credentials after an explicit rejection.
- Require positive, stable destination evidence before authentication success.
- Preserve ambiguous transitions as `unclassified_failure` with samples.

## 4. Terminal packet and classification

- Normalize top-level and nested page-walk results.
- Preserve observed facts separately from C3 labels and inferred hints.
- Reconcile runner, operation, extension, watchdog, and artifact facts.
- Include capture completeness and conflicts in the lane report.
- Do not fetch failure-only context before classifying a successful Review.

## 5. Reliability

- Treat heartbeat and semantic progress as independent liveness signals.
- Add bounded Windows-safe retries and cross-process serialization for
  `active.json`.
- Require committed DOM evidence for Workday popup success.

## 6. Verification

- Run focused JavaScript/browser-fixture and Python control-plane tests.
- Run the complete affected C3 suite.
- Reload/restart the changed runtime from the current checkout.
- Rerun the exact 25 lanes with isolated, non-foreground p Chrome sessions.
- Compare packet-only diagnosis against independent browser truth and document
  every mismatch or missing fact.
