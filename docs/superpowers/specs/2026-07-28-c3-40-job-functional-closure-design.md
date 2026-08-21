# C3 40-Job Functional Closure Design

Date: 2026-07-28

## Outcome

C3 must reliably sign in, create and verify accounts, reconcile empty or
partially completed Workday applications, fill each available job through
Review, and stop with final Submit visible but untouched. C3's diagnosis and
terminal report must independently describe enough browser truth for an agent
to identify and fix any failure.

The acceptance corpus contains one current Workday posting from each of the
same 40 companies represented in `wd_test_jobs.csv`. If a posting closes or
becomes unavailable during testing, replace it with another current posting
from the same company and record the replacement. A dead posting is not a C3
functional failure.

## Scope

Included:

- Close functional and diagnostic defects already established by the retained
  25-job and 40-job investigations.
- Refresh the 40-company corpus with current, unique, applyable postings.
- Validate email access, Workday account creation, verification, and sign-in
  before fill testing.
- Test and fix each job sequentially with browser truth collected before C3
  diagnosis is revealed.
- Reconcile fresh, correctly prefilled, and incorrectly prefilled application
  state.
- Protect prior fixes with focused, primitive-level, earlier-job, and full
  corpus regression.
- Run final regression waves with isolated parallel lane agents on one frozen
  source and runtime revision.

Excluded:

- Clicking final Submit.
- Solving a real CAPTCHA or bypassing anti-bot controls.
- Treating a closed posting, Workday outage, company maintenance page, or
  unavailable email provider as a C3 fill bug.
- Adding company-name conditionals when a generic Workday primitive can express
  the correct behavior.
- Inventing sensitive or material applicant answers.
- Expanding acceptance to non-Workday ATS products.

## Success Definition

An available corpus job passes only when all applicable conditions hold:

1. C3 reaches Review with final Submit visible and untouched.
2. Account creation, verification, or sign-in completes when the job requires
   it.
3. Every required field has a committed, policy-grounded value.
4. No known P0 or P1 bad fill remains on Review.
5. A correctly prefilled value is preserved without a destructive rewrite.
6. An incorrect C3-owned value is corrected and its committed state is proven.
7. Repeatable sections contain no C3-created duplicate rows.
8. C3's terminal state and report match independent browser truth.
9. The diagnostic packet contains enough evidence for an agent to identify the
   causal primitive without reopening the site.
10. The job passes on the same frozen revision as the rest of its regression
    wave.

An unavailable corpus job passes only as a temporary corpus state when C3
returns the correct typed external condition with direct evidence. The row must
then be replaced with another current posting from the same company before the
final 40-job acceptance wave.

## Core Invariants

### Browser truth is the independent oracle

The project is testing both application behavior and C3's diagnosis product.
The investigating agent must not see C3's diagnosis, report, failure context,
console summary, network summary, validation artifact, or inferred cause before
it seals an independent browser-truth report.

The only pre-investigation operation information exposed to that agent is:

- immutable job, lane, session, operation, and target identity;
- source and runtime revision;
- whether the operation has terminalized;
- safety state proving foreground and final Submit stayed disabled.

The agent first inspects the actual page visually and through pinned CDP or
pChrome. Only after the browser-truth report is sealed may the C3 packet be
revealed and graded.

This ordering is enforced by the testing control plane, not left to agent
memory:

- test/audit operations return an operation receipt that omits result details,
  diagnosis, inferred cause, and artifact summaries;
- failure-context, report, and diagnostic-artifact reads stay locked to the
  investigator actor until a `browser_truth.sealed` checkpoint exists;
- the seal records actor, operation, target, document generation, report path,
  report hash, and timestamp;
- `run-lane` and batch summaries do not print diagnostic content before the
  seal;
- a logged human override may unlock evidence for emergency recovery, but that
  lane becomes contaminated and cannot grade diagnosis quality;
- normal product operations keep their existing diagnostic access. This gate
  is specific to diagnosis-validation lanes.

### Fixes must not break each other

Every fix is a generic primitive change with four protection layers:

1. a failing local fixture that proves the new bug;
2. the existing focused primitive suite;
3. targeted live regression against every earlier corpus job that exercised
   the changed primitive;
4. a final complete 40-job regression on one frozen revision.

A fix does not pass because its current job advances. It passes only after the
new job and the affected earlier-job set pass. Shared-file changes remain
serialized under one fix owner. No product-code edits occur during a frozen
regression wave.

### Postings are replaceable, companies are stable

The 40 company identities and Workday tenant/site mappings are stable corpus
slots. Individual requisitions are replaceable.

When a posting stops working:

1. independently verify the posting is closed, unavailable, removed, or under
   company/Workday maintenance;
2. record the old URL, requisition, observed state, evidence, and replacement
   reason;
3. discover a new posting from the same company and expected Workday tenant;
4. require a unique requisition, populated title, `posted=true`, and
   `canApply=true` when CXS is available;
5. browser-check CXS 401/403/unknown results instead of calling them expired;
6. update the corpus manifest and canonical row;
7. restart that slot's acceptance history for the new posting.

### Runtime identity is part of evidence

Every live result records source SHA, extension build identity, extension ID,
backend revision, profile schema revision, answer-policy revision, pChrome
profile, CDP port, target ID, and artifact root. After a product-code change,
the affected runtime must be reloaded or restarted before any retest counts.

## Architecture and Roles

### Main integrator

- Owns corpus order, stage gates, product-code integration, and regression
  revision freezes.
- Assigns one fix owner for each primitive.
- Prevents overlapping shared-file edits.
- Chooses affected earlier-job regression sets from recorded primitive
  coverage.
- Performs evidence-gated browser cleanup.

### Lane investigator

- Owns one immutable job, browser target, and mutation lease.
- Does not edit product code.
- Runs the normal C3 operation.
- Performs blind browser-truth investigation before opening any C3 diagnostic
  material.
- Produces the sealed truth report and later diagnosis comparison.
- Leaves the browser open for fix-owner or verifier follow-up.

### Fix owner

- Receives a sealed causal comparison, not an unproven symptom.
- Writes the failing test first.
- Applies the minimum generic primitive fix.
- Runs focused and integration tests.
- Does not mutate the investigator's preserved lane.

### Verification investigator

- Uses a fresh profile, lane, session, and target after the runtime reload.
- Repeats the browser-first and diagnosis-second protocol.
- Verifies both behavior and diagnostic sufficiency.
- Must not rely on the fix owner's claimed expected result.

### Parallel regression agents

- Each owns one immutable job and one browser session.
- May run concurrently only on a frozen revision.
- Never edit shared product code during the wave.
- Return lane evidence to the main integrator for wave-level synthesis.

## Evidence Model

Each job attempt produces four linked records.

### 1. Operation receipt

Contains only identity, terminal lifecycle state, revision identity, and safety
proof. It contains no diagnosis or inferred cause.

### 2. Sealed browser-truth report

Created before C3 diagnostics are unlocked:

- visible page and current step;
- final URL and document/frame generation;
- screenshot inspection result;
- required field and validation state;
- active element;
- popup/listbox ownership;
- selected pills and backing state;
- user-like probe and result;
- deeper CDP inspection;
- expected C3 path;
- actual observed path;
- divergence point;
- browser-derived root cause or `root_cause_unknown`;
- ruled-out explanations;
- next one-variable probe when unresolved;
- report hash and seal timestamp.

### 3. C3 diagnostic packet

The existing bounded, redacted terminal report, diagnosis, events, action
receipts, validation, field, DOM, console, network, and watchdog artifacts.

### 4. Comparison report

Grades:

- `exact`: cause and evidence match browser truth.
- `sufficient_partial`: wording is incomplete, but evidence is enough to find
  the cause.
- `insufficient`: necessary evidence is missing.
- `misleading`: the packet points toward the wrong cause.
- `contradictory`: packet artifacts disagree with authoritative browser state.
- `stale`: report used an older page or action generation.

The comparison separately records:

- functional behavior grade;
- diagnosis correctness grade;
- diagnostic sufficiency grade;
- report coherence grade;
- missing or excess evidence;
- whether packet-only diagnosis would let a new agent choose the correct next
  test or fix.

## Stage 1: Close Known Defects

### Entry

- Retained 25-job and 40-job evidence is accessible.
- Current source and test baseline pass.
- No live regression wave is active.

### Defect inventory

Reconcile retained findings into primitive-owned rows:

- Workday sign-in and create-account action selection.
- Valid `click_filter` submit proxies.
- Signup, signin, verification, and application-state stabilization.
- Visible credential rejection and account-lock stop behavior.
- False CAPTCHA classification.
- Review-ready result normalization.
- Progress-aware watchdog and late-result reconciliation.
- Maintenance and unavailable-posting detection.
- Page semantic detection and stable readiness.
- Disabled Next and unverified-required-field blocking.
- Source, phone, dropdown, degree, and selected-pill persistence.
- Skills search, option ownership, timing, and commit proof.
- Required checkbox and disclosure commit.
- Work Experience and Education repeatable-row reconciliation.
- Footer disabled with no visible validation.
- Correct answer routing and refusal of unsupported sensitive answers.
- Coherent terminal artifact generations and sufficient diagnostic reporting.
- Concurrent lane/ledger registration and immutable ownership.

### Per-defect flow

1. Select one retained proving lane and its browser truth.
2. Reproduce with current code when the posting remains available.
3. Replace only a dead posting, using the same-company replacement protocol.
4. Write expected path, actual path, divergence, cause, and ruled-out causes.
5. Write a failing fixture or integration test.
6. Change one generic primitive.
7. Run focused tests and the affected shared C3 suites.
8. Reload or restart the changed runtime.
9. Run a fresh live verification.
10. Run affected earlier-job regression.
11. Accept the fix only if no earlier job regresses.

### Exit

- Every retained P0/P1 finding is fixed with fresh proof or typed as an
  external/account blocker.
- No item is closed from diagnosis quality alone.
- The blind-browser evidence gate exists before Stage 3 testing.
- The prefill reconciliation contract has local fixture coverage.

## Stage 2: Refresh the 40-Company Corpus

### Discovery

For every canonical company slot:

1. Parse company, country, Workday host, tenant, and site from the old row.
2. Query current CXS listing and detail endpoints.
3. Select one recent unique posting from the same company and expected tenant.
4. Prefer the same country when candidates exist.
5. Require a populated title and applyable/posted signals.
6. Verify the exact public posting and application entry in a browser.
7. Record unavailable candidates rather than silently skipping them.

### Corpus manifest

The manifest records:

- stable company slot ID;
- company and country;
- old and new requisition;
- old and new URL;
- Workday host, tenant, and site;
- discovery timestamp;
- CXS status and response classification;
- browser verification result;
- replacement history;
- current availability status.

### Auth preflight

Before fill testing:

1. Verify configured email inbox access.
2. Verify retrieval of a current message without exposing message bodies or
   credentials in artifacts.
3. Verify one fresh Workday account creation with a controlled alias.
4. Verify one email-link activation.
5. Verify one existing-account sign-in.
6. Detect invalid password, locked account, stale verification, or provider
   outage.
7. Record only value-free account state and capability results.
8. Block the affected lane before fill diagnosis if required credentials or
   inbox access are unavailable.

The global email preflight proves inbox capability. Each job attempt separately
proves its tenant route can create a new account, resume a verified account, or
sign in with the intended account state before C3 fill behavior is blamed.

### Exit

- Exactly 40 stable company slots have unique current jobs.
- All rows pass CXS or bounded browser availability verification.
- Email, new-account, verification, and existing-account capabilities pass.
- The CSV and manifest agree.

## Stage 3: Sequential Test, Diagnose, Fix, and Regress

Jobs run in stable corpus order. Job N remains the active functional target
until it passes or is replaced/externally blocked.

### Attempt flow

1. Launch a fresh isolated pChrome profile with the frozen current revision.
2. Register exact target and immutable lane/session ownership.
3. Confirm auth capability for the tenant/account route.
4. Run normal `c3.page_walk` with foreground and final Submit disabled.
5. Expose only the operation receipt to the lane investigator.
6. Create and seal the blind browser-truth report.
7. Unlock the C3 diagnostic packet.
8. Create the comparison report.
9. Classify the outcome as functional bug, diagnostic bug, both, external
   condition, or pass.
10. Preserve the lane and hand the causal report to the fix owner.
11. Add a failing test, patch one primitive, test, and reload runtime.
12. Verify in a fresh lane.
13. Run the affected earlier-job regression set.
14. Repeat until the job and regressions pass.

### Probe order

1. Visual screenshot and visible page state.
2. User-like click, typing, or keyboard probe without OS focus.
3. Pinned CDP inspection of active element, ownership, committed state, and
   validation.
4. One-variable discriminating probe.
5. C3 diagnostics only after the browser-truth seal.

Each mutating probe tests a new hypothesis. Repeated mutations without new
evidence are prohibited.

### Prefill reconciliation behavior

For each field, compute a normalized comparison between committed UI state and
the authoritative desired answer:

- empty plus authoritative answer: fill and verify;
- semantically equal: record `already_correct`, do not mutate;
- different plus authoritative non-sensitive C3-owned answer: replace and
  verify;
- different plus sensitive, material, or uncertain answer: preserve and emit
  `prefill_conflict_needs_review`;
- unsupported committed value: preserve unless the field is required and the
  answer policy provides a safe authoritative replacement.

Primitive rules:

- Text: compare normalized committed value, not placeholder or display text.
- Select/listbox: compare backing value or selected pill.
- Radio/checkbox: compare exact owned group state and mutual-exclusion policy.
- Phone/date: compare normalized semantic value and wrapper state.
- Skills/multiselect: compare selected item identities, add missing items, and
  avoid removing user-owned extras.
- Repeatables: match rows by stable normalized keys, update owned mismatches,
  add missing rows, and avoid duplicate creation.
- Files: preserve when artifact identity can be proven; replace only when the
  explicit upload policy authorizes it.

### State coverage

- Every corpus job: fresh-state run.
- Every corpus job: matching-prefill resumed run.
- Wrong-prefill correction: every unique field primitive, every unique Workday
  configuration encountered, and every job that previously failed correction.
- Any newly observed UI configuration expands the wrong-prefill matrix before
  its job can close.

A matching-prefill run starts from a saved mid-application state, not from an
already completed Review page. It must contain at least one committed
C3-grounded value on each page already traversed. The rerun starts from the
normal job/apply entry and proves that C3 detects and preserves those values
while continuing.

A wrong-prefill run uses a controlled, separately logged setup action before
the C3 operation. It seeds a known mismatch for the targeted primitive without
reading or changing the later C3 diagnosis. The seed record contains structural
field identity and expected comparison class, but no sensitive value.

### Exit

- All 40 current slots pass sequential acceptance.
- Each accepted fix has earlier-job regression proof.
- Each job has a browser-truth report and C3 comparison.
- No unresolved P0/P1 functional or diagnosis issue remains.

## Stage 4: Frozen Full Regression

### Wave rules

- Freeze source SHA, extension build, backend revision, profile schema, answer
  policy, and corpus manifest.
- Run multiple isolated agents up to the current agent and browser capacity.
- One agent owns one immutable lane and one mutation lease.
- No product-code edits occur during a wave.
- Every lane uses browser truth first and C3 diagnosis second.
- A posting that dies during a wave is replaced from the same company, the
  manifest is revised, and the wave restarts on a newly frozen corpus.
- If no current posting exists for that company, the slot is
  `blocked_no_current_posting`; other evidence work may continue, but final
  40-job acceptance cannot pass until that company has a verified replacement.

### Failure handling

1. Complete or safely terminalize the current wave.
2. Group failures by primitive and shared cause.
3. Assign one fix owner per primitive.
4. Add regression fixtures and patch shared code serially.
5. Run focused and full automated gates.
6. Reload all affected runtimes.
7. Target-retest failed jobs and affected earlier jobs.
8. Freeze a new revision.
9. Restart full regression from job 1.

### Final gate

One frozen revision must pass:

- 40/40 current company slots through Review or correct typed external
  termination followed by same-company replacement;
- matching-prefill resumed runs for all 40;
- the complete wrong-prefill primitive/configuration matrix;
- exact or sufficient diagnostic packets with no misleading, contradictory, or
  stale report;
- focused C3 tests, full Hunt tests, extension syntax/build checks, and
  applicable runtime smokes;
- foreground and final Submit safety;
- independent review of stage acceptance and artifacts.

## Regression Impact Map

Every primitive fix updates a durable mapping from primitive to proving jobs.
At minimum:

- auth changes rerun all observed signup, signin, verification, existing
  account, and credential-rejection routes;
- page-state/readiness changes rerun all Review, maintenance, unavailable,
  loading, and application-step proofs;
- popup/listbox changes rerun Source, phone, degree, Skills, and question
  dropdown jobs;
- repeatable changes rerun every Work Experience, Education, Skills, website,
  and social-profile job;
- answer-routing changes rerun every affected prompt family and Review audit;
- watchdog/reporting changes rerun successful, failed, slow-render, late-result,
  and cancellation lanes.

The map grows when a new job exposes a distinct configuration. It never shrinks
merely because a posting is replaced; the local fixture preserves the retired
configuration.

## Safety and Privacy

- `allow_foreground=false` and `allow_submit=false` are mandatory.
- No agent may bring pChrome to the active desktop without explicit owner
  direction.
- Credentials, verification links, applicant answers, input values, and email
  bodies never enter reports or durable artifacts.
- Browser and diagnostic artifacts remain bounded and redacted.
- Agents do not close preserved lanes.
- Main-agent cleanup requires ownership, inactivity, terminal evidence, no
  preserve request, and a closure receipt.
- One mutating actor owns a session at a time.

## Required Documentation Changes

The implementation must update the current protocol where it conflicts with
this design:

- `docs/C3_AGENT_COMMAND_LEDGER.md`: replace “failure context is the first
  diagnostic read” with the operation-receipt, sealed-browser-truth, then
  diagnosis sequence for test/audit lanes, including the access-control
  checkpoint and contaminated-lane rule.
- `docs/C3_PRIMITIVE_DEBUGGING.md`: make the sealed blind report and
  cross-job regression mandatory.
- `docs/C3_LANE_AGENT.md`: prohibit diagnostic access before the browser-truth
  seal and add prefill-state reporting.
- `docs/C3_PARALLEL_BATCH.md`: add frozen-wave and no-code-change rules,
  same-company posting replacement, and regression restart semantics.
- `docs/C3_TESTING_METHODS.md`: add auth capability preflight, corpus manifest,
  runtime identity, and state-variant commands.

## Completion Boundary

Tier 1 means the required code, fixtures, corpus tooling, protocol changes, and
reports exist.

Tier 2 means all automated gates pass and one frozen revision completes the
full browser-based Stage 4 acceptance without a known P0/P1 blocker.

Tier 3 is the owner's optional manual review of selected Review pages,
diagnostic reports, and prefill correction behavior. Final Submit remains
outside every tier.
