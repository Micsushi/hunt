# Company/job-flow campaign

Run from `executioner` with installed dependencies (`npm ci`) and the matching
Playwright Chromium installation. This harness is separate from authenticated
live acceptance. It never loads a real applicant profile, creates an account,
queries a mailbox, sends an application, or invokes the live runner.

## Commands

```sh
npm run campaign:check
npm run campaign -- --output ../.runtime/job-flow-campaign/run-1
npm run campaign -- --output ../.runtime/job-flow-campaign/run-1 --resume
npm run campaign:live
# Optional immutable live-check report (parent directory must exist):
npm run campaign:live -- --output ../.runtime/job-flow-campaign/live.json
```

Choose a new output directory for each changed source revision. The runner owns
an exclusive `campaign.lock`; a second runner cannot reuse that directory.
After a crash with a retained lock, use a fresh directory. Never remove another
runner's lock or terminate its browser. Completed attempts remain immutable.

The campaign runs typecheck, the regression suites referenced by every matrix
rule, and three clean browser repetitions of all three baseline jobs. Browser
work is serialized. Each repetition uses a fresh Chromium process and context.
Sensitive handlers are explicit synthetic stubs; the production Workday page
walker, independent DOM observer, required-field gate, and Next navigation run
against actual browser pages. Baselines cover profile-first, resume-first, and
no-resume page orders, locale/region controls, conditional reveals, hidden Next
clones, loading shells, and a saved verified prefix after page loss. Separate
matrix suites cover auth/email transitions, popups, session ownership, selector
drift, expired postings, rollback, mirrors, and typed recovery failures.

The mock page orders are deliberate variants, not claims about the companies'
current application forms. C3 remains Workday-only. Greenhouse/Lever coverage
in the classifier regression suite proves rejection, not application completion.

## Checkpoints and diagnostics

`checkpoint.json` binds completed gates to source/fixture/document content and
each attempt directory's SHA-256. Resume rechecks both before skipping anything.
Changed source, modified/missing evidence, unknown gates, and duplicate gate IDs
fail closed. Failed gates rerun in a new attempt directory; there is no automatic
retry loop. Source is checked again before and after each gate. A changed source
requires a new campaign, not a relabelled old pass.

Every attempt retains command, exit status, stdout/stderr and an evidence digest.
Browser attempts retain synthetic-only screenshots, traces and structural
results. The resumed baseline also writes its verified application checkpoint.
No personal browser/profile is used. All browser requests are intercepted;
anything except the exact synthetic fixture GET is blocked. Review has a
disabled Submit button. The test also verifies the exact count of Next effects.

Open `trace.zip` with `npx playwright show-trace <path>` for local diagnosis.
Artifacts are synthetic but may contain absolute local tool paths. Do not commit
the runtime output. Keep only useful failed attempts and final acceptance
evidence; review retention before long soak campaigns.

## Live coverage and interpretation

`campaign:live` is an opt-in, separate read-only HTTP check of the official URLs
in the matrix. It checks every redirect before following it, bounds the chain,
time and streamed body size, and never retries an access denial, rate limit or
Retry-After response. It stores no page body, cookies, credentials or tokens.
`posting_present` means an allowlisted response contains the title marker; it
does not prove active availability, rendered application entry, or Review.
HTTP 200 with missing title is `title_mismatch`, not a pass. Access-denied
endpoints stay blocked; do not change identity or transport to bypass them.

The generated [rules/fix list](job-flow-rules.md) comes from
`fixtures/job-flow-campaign/v1.json`. Update the rule, its executable regression
test and evidence mapping together, then run `npm run campaign:rules` and
`npm run campaign:check`. Do not weaken expected outcomes to absorb failures.

The broader C3 acceptance contract remains separate. This fixture campaign
cannot replace its official-job proofs, protected live evidence, integration
gates or deployment approval. Under synthetic-only/read-only authority,
authenticated official-job journeys are intentionally not attempted.

## Adjacent C0/C1 checks

Install frontend dependencies in the isolated checkout before running Python
tests that transpile UI utilities: `npm ci --ignore-scripts` from `frontend`.
Missing TypeScript otherwise produces misleading subprocess failures. From the
repository root, run:

```sh
python -m pytest tests/test_frontend_jobs_ui.py tests/test_review_ops.py hunter/tests/test_hunter_requeue_errors.py -q
```

These check job UI contracts, review state operations and deterministic Hunter
error requeue behavior. They do not exercise a deployed database or authorize
changes to another worker's backend/security checkout.
