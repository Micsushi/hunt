# S1 Controlled Workday Journey — requirement reference

These are preserved portable scope and acceptance requirements from the original stage plans. They do not activate work, record acceptance, grant browser/account access, or authorize integration or release. Existing contracts and tests remain executable authority; deviations need explicit reconciliation. Final Submit stays forbidden. Task identifiers are traceability labels, not an active task board.


## s1-f1-contract-kernel-test-kit

### Observable outcome

Every Stage 1 component has a closed executable port, shared fake, and stateful
conformance proof sufficient for selective independent recovery and the two
required vertical slices. Serialized boundaries are versioned; in-process
ports are pinned by the accepted F1 component-base revision.

### Scope

Strict-TypeScript package baseline, boundary matrix, serialized contracts,
in-process ports, stable errors, dependency rules, shared fakes, conformance
helpers, source ownership, and contract-version policy.

### Non-goals

Component implementation, real Workday behavior, and F12/F13 acceptance.
Compile-and-contract walking skeletons are in scope only to prove the boundaries.

### Acceptance

- Every F2-F11 provider and consumer is named.
- Inputs, outputs, errors, side effects, cancellation, retry, and idempotency
  are closed and tested.
- Serialized boundaries have JSON Schema; internal ports remain plain
  TypeScript.
- Each component can run consumer tests without a peer implementation.
- Forbidden implementation imports are tested.

### Verification

Tier 2: contract, compatibility, fake, conformance, and import-boundary suites
plus `npm --prefix executioner run quality`.
Tier 3: included in F12/F13.
Tier 4: owner reviews the frozen boundary matrix.


## S1-F1-T1 — Establish the minimal v3 package and dependency rule
- Outcome: an independently installable strict-TypeScript `executioner`
  package with tests, quality commands, and enforced dependency direction.
- Scope: package manifest, TypeScript/test configuration, one parameterized
  `npm test -- <path>` command, `quality`, source folders, import-boundary rule,
  and architecture decision record.
- Out of scope: component ports, component behavior, browser launch, and new
  dependencies not required by the baseline.
- Acceptance: clean install works; tests compile; component folders may import
  contracts but not peer implementations; C3 v2 imports fail the boundary test.
- Verify: `npm --prefix executioner ci`;
  `npm --prefix executioner test -- tests/architecture`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/package.json`, `executioner/tsconfig.json`,
  `executioner/src/contracts/**`, `executioner/src/testing/contracts/**`,
  `executioner/tests/architecture/**`.
- Interfaces/decisions: one local package; native Node/TypeScript and installed
  dependencies first.

## S1-F1-T2 — Freeze the component boundary and ownership matrix
- Outcome: one reviewed matrix names every F2-F11 provider, consumer, owned
  side effect, request/result/error shape, and source directory.
- Scope: browser, intake/profile/state, understanding, answering, driver,
  verifier/navigation, orchestrator/MCP, observability, and safety/evidence
  boundaries.
- Out of scope: implementations and F12 connection behavior.
- Acceptance: no component implementation dependency remains; every cross-
  component datum has one owner; retry/cancel/idempotency semantics are explicit.
- Verify: `npm --prefix executioner test -- tests/contracts/boundary-matrix.test.ts`.
- Relevant files: `executioner/docs/component-boundaries.md`,
  `executioner/src/contracts/ownership.ts`,
  `executioner/tests/contracts/boundary-matrix.test.ts`.
- Interfaces/decisions: component branches change only owned files; contract
  changes require the F1 owner.

## S1-F1-T3 — Implement versioned types, serialized schemas, and stable errors
- Outcome: TypeScript ports and JSON-compatible serialized contracts cover job,
  resume, profile, journey, browser, page, field, event, error, evidence, MCP,
  and terminal results.
- Scope: closed unions, runtime parsing at trust boundaries, schema exports,
  serialized-contract versions, compatibility tests, frozen-revision policy
  for in-process ports, and credential/profile separation.
- Out of scope: component logic and schema generation infrastructure.
- Acceptance: malformed and extra-key serialized payloads fail with stable
  codes; Applicant Profile cannot contain credentials; serialized versions
  reject incompatible payloads; internal ports use the frozen F1 revision.
- Verify: `npm --prefix executioner test -- tests/contracts`;
  `npm --prefix executioner test -- tests/contracts/compatibility`.
- Relevant files: `executioner/src/contracts/**`,
  `executioner/tests/contracts/**`.
- Interfaces/decisions: plain TypeScript for in-process ports; JSON Schema only
  for serialized boundaries.

## S1-F1-T4 — Publish shared fakes, conformance tests, and the frozen revision
- Outcome: each F2-F11 branch can test its provider and consumer behavior from
  the same frozen contract revision without a peer implementation.
- Scope: minimal fakes, contract fixtures, provider conformance helpers,
  consumer harnesses, frozen revision record, and contract-change procedure.
- Out of scope: realistic component simulations and connection tests.
- Acceptance: one deliberate provider violation fails conformance; every fake
  supports only declared S1 behavior; contract freeze and ownership are recorded.
- Verify: `npm --prefix executioner test -- tests/contracts/conformance`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/src/testing/contracts/**`,
  `executioner/tests/contracts/conformance/**`,
  `executioner/docs/contract-freeze.md`.
- Interfaces/decisions: fakes are contract examples, not alternate business
  implementations.

## S1-F1-T5 — Freeze the executable flow and owner decisions
- Outcome: one reviewed data/control-flow matrix proves every required fixture
  field and control step has exactly one producer, consumer, side-effect owner,
  verifier, event owner, and failure owner.
- Scope: MCP start; fixture start/reset/close; intake/resume/profile; browser
  observation; page/field meaning; answer source; mutation; readback;
  navigation; journey state; events; failure; privacy/evidence; terminal result.
- Out of scope: component implementation and production Workday behavior.
- Acceptance: the F2-F8 field-flow matrix has no unsupported required cell; the
  F9/F4/F10/F11 control slice has no dead or duplicate port; every proposed
  contract delta is classified as requirement, owner decision, or rejected
  prototype invention.
- Verify: `npm --prefix executioner test -- tests/contracts/flow-matrix.test.ts`;
  `npm --prefix executioner test -- tests/architecture`;
  `git for-each-ref --format='%(refname) %(objectname)' refs/codex/snapshots`;
  for each prototype run
  `if ((git show -s --format=%P <prototype-sha>) -ne 'd95e845e61bcf0a030b3b07c6d6261e3d95c1fad') { throw 'wrong prototype parent' }`.
- Relevant files: `executioner/docs/component-boundaries.md`,
  `executioner/docs/s1-field-flow.md`, `executioner/src/contracts/ownership.ts`,
  `executioner/src/testing/contracts/field-flow-cases.ts`,
  `executioner/tests/contracts/flow-matrix.test.ts`, vault `recovery-plan.md`.
- Interfaces/decisions: F9 emits provider-attributed events; F10 validates and
  stores; ModelController is deferred; fixture navigation is browser-driven;
  the acceptance harness owns provider-fault injection.

## S1-F1-T6 — Amend lifecycle, identity, failure, and admission contracts
- Outcome: R2 types express every required structural control, resume proof,
  dependency failure, operation lifecycle, and trust-boundary rule without
  arbitrary strings or false remapping.
- Scope: textarea/date/group/checked-state observation and mutation; resolved
  resume artifact/hash; bounded well-formed IDs; closed nested provider errors;
  code-to-owner/retryability table; duplicate/replay/cancel/uncertain-mutation/
  terminal rules; immutable exact-shape admission; serialized version changes
  only where wire shape changes.
- Out of scope: driver/browser/store implementations and S2 credentials.
- Acceptance: same MCP `requestId` plus same request returns recorded result;
  same `requestId` plus changed request fails closed; cancelled/uncertain mutation invalidates the
  session; malformed ProfileQuery and unavailable persistence are representable;
  no `PortError<string>` or unbounded delimiter key remains in the public model.
- Verify: `npm --prefix executioner test -- tests/contracts`;
  `npm --prefix executioner test -- tests/contracts/compatibility`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/src/contracts/**`,
  `executioner/src/testing/contracts/**`, `executioner/tests/contracts/**`,
  `executioner/docs/contract-freeze.md`.
- Interfaces/decisions: crash/process-restart recovery is deferred to S2 unless
  an explicit persisted-result read port is approved here.

## S1-F1-T7 — Repair fakes, conformance, and compatibility probes
- Outcome: shared stateful scenarios prove the R2 contract matrix and two real-
  provider walking skeletons compile and execute at contract level.
- Scope: public scenario helpers; provider factory/cleanup; every declared
  negative/error; duplicate same/changed input; replay; cancel and post-cancel
  state; concurrent ownership; immutable admission; no-skip/no-empty enforcement;
  F2-F8 and MCP-F9-F4/F10/F11 compatibility probes.
- Out of scope: component feature acceptance and complete journey behavior.
- Acceptance: one deliberate violation per invariant fails; prototypes cannot
  force a contract change; minimum throwaway R2-conformant spike providers make
  both skeletons pass; every prototype outcome is classified.
- Verify: `npm --prefix executioner test -- tests/contracts/conformance`;
  `npm --prefix executioner test -- tests/contracts/compatibility-probes`;
  `npm --prefix executioner test -- tests/contracts/no-skipped-conformance.test.ts`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/src/testing/contracts/**`,
  `executioner/tests/contracts/conformance/**`,
  `executioner/tests/contracts/compatibility-probes/**`, vault
  `acceptance-ledger.md`.
- Interfaces/decisions: scenario builders are public; raw dynamic request cases
  remain internal so consumers cannot mistake builders for requests.

## S1-F1-T8 — Accept and publish the R2 component baseline
- Outcome: one reviewed SHA is the only legal base for recovered F2-F11 work,
  with named Git `contractTreeOids` and serialized versions recorded separately.
- Scope: clean install; typecheck; architecture; contracts; compatibility;
  conformance; privacy; quality; prototype compatibility report; exact-base and
  ancestry check; two independent reviews.
- Out of scope: component acceptance, merge to `main`, push, and live tests.
- Acceptance: all gates pass with zero required skips; two independent reviews
  leave no P0/P1; the in-repo freeze record contains `contractTreeOids` for
  `executioner/src/contracts`, `executioner/src/testing/contracts`,
  `executioner/tests/contracts`, and `executioner/tests/security/privacy`,
  serialized versions, and expected R1/planning ancestry; after an authorized
  commit exists, the coordinator records `acceptedF1Base` and review evidence in
  the vault acceptance ledger; a deliberately wrong-base branch fails ancestry.
- Verify: `npm --prefix executioner ci`;
  `npm --prefix executioner test -- tests/architecture tests/contracts tests/security/privacy`;
  `npm --prefix executioner run quality`;
  `npm --prefix executioner test -- tests/revisions/f1-base.test.ts`.
- Relevant files: `executioner/docs/contract-freeze.md`,
  `executioner/tests/revisions/**`,
  vault `recovery-plan.md` and `acceptance-ledger.md`.
- Interfaces/decisions: component dispatch and acceptance both verify exact
  ancestry from this SHA.


## s1-f10-observability-failure-reporting

### Observable outcome

Value-free provider-attributed events emitted by F9 produce monotonic progress,
durable local terminal state,
and factual component/phase/step failure coordinates without speculative cause.

### Scope

Event bus/store, allowlisted envelope, progress projection, stable event/error
codes, Error Reporter, Failure Context, notifications adapter, duplicate
terminal handling, and provider conformance.

### Non-goals

Raw DOM/screenshots, personal values, speculative cause, message brokers, and
process-crash recovery.


## S1-F10-T1 — Store value-free events and project monotonic progress
- Outcome: allowlisted provider-attributed events emitted by F9 append durably
  and project one
  monotonic journey status.
- Scope: event admission, append store, component/phase/step/source and IDs,
  progress reducer, duplicate handling, and value-leak negatives.
- Out of scope: screenshots, raw DOM/page text, and causal inference.
- Acceptance: forbidden keys fail admission; progress never regresses; duplicate
  events do not duplicate terminal state.
- Verify: `npm --prefix executioner test -- tests/observability/events`.
- Relevant files: `executioner/src/observability/events/**`,
  `executioner/src/observability/progress/**`,
  `executioner/tests/observability/events/**`.
- Interfaces/decisions: consumes frozen EventEnvelope; provides EventSink and
  ProgressReader.

## S1-F10-T2 — Build factual errors, failure context, and notifications
- Outcome: stable error observations become a factual terminal report and
  bounded notification without inventing cause.
- Scope: Error Reporter, Failure Context, stable coordinates, retryability,
  source reference, notifications adapter, and injected-error tests.
- Out of scope: investigation agent, screenshots, and root-cause guesses.
- Acceptance: report names exact observed component/phase/step/code; cause is
  absent unless supplied as verified fact; notifications contain no values.
- Verify: `npm --prefix executioner test -- tests/observability/failures`.
- Relevant files: `executioner/src/observability/errors/**`,
  `executioner/src/observability/notifications/**`,
  `executioner/tests/observability/failures/**`.
- Interfaces/decisions: observation and cause are distinct fields.

## S1-F10-T3 — Accept observability independently
- Outcome: F10 is ready to wait for orchestrator and safety connections.
- Scope: provider conformance, fake event producers, progress/error matrices,
  privacy negatives, and import-boundary checks.
- Out of scope: real F9/F11 implementations and crash/process-restart recovery.
- Acceptance: component passes with shared fake producers and no peer imports;
  all payloads remain value-free.
- Verify: `npm --prefix executioner test -- tests/acceptance/components/f10`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/acceptance/components/f10/**`.
- Interfaces/decisions: accepted branch remains frozen until F12.

## Prototype recovery obligations


## s1-f11-safety-evidence

### Observable outcome

Privacy/capability admission and the evidence store reject forbidden content or
capabilities and retain only bounded sanitized replay facts.

### Scope

Content/capability allowlists, Submit denial, evidence admission, immutable
admitted snapshots, redaction, replay manifest, size bounds, concurrent attempt
ownership, denial behavior, and provider conformance.

### Non-goals

Local model control, raw page dumps, screenshots, policy DSLs, and retaining
denied content.


## S1-F11-T1 — Enforce privacy and capability admission
- Outcome: closed guards admit only value-minimized semantic content and safe
  Stage 1 capabilities.
- Scope: payload key/value bounds, credential/token/email/raw-text denial,
  selector/policy-override denial, Submit denial, redaction codes, and adversarial
  cases.
- Out of scope: evidence persistence and model selection.
- Acceptance: forbidden content fails before retention or side effects; Submit
  has no representable capability; stable denial codes contain no rejected value.
- Verify: `npm --prefix executioner test -- tests/security/admission`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/src/safety/**`,
  `executioner/tests/security/admission/**`.
- Interfaces/decisions: provides PrivacyGuard and SafetyGuard ports.

## S1-F11-T2 — Store sanitized evidence with immutable admission
- Outcome: one immutable admitted snapshot produces a bounded replay manifest
  while concurrent or mutated attempts fail without retention.
- Scope: evidence manifest/store, size/count bounds, source coordinates,
  retention denial, immutable payload binding, concurrent attempt ownership,
  recursive exact-shape admission, and adversarial tests.
- Out of scope: screenshots, raw page dumps, training, and model choice.
- Acceptance: denied content is never stored; after admission the caller graph
  is irrelevant and later mutation cannot alter/invalidate the frozen snapshot;
  replay contains only allowlisted facts; one attempt cannot reuse another's
  admission or present a substitute graph.
- Verify: `npm --prefix executioner test -- tests/security/evidence`.
- Relevant files: `executioner/src/evidence/**`,
  `executioner/tests/security/evidence/**`.
- Interfaces/decisions: Local Model Controller is out of S1 scope and has no
  accepted caller.

## S1-F11-T3 — Accept safety and evidence independently
- Outcome: F11 is ready to wait for orchestrator and observability connections.
- Scope: provider conformance, adversarial corpus, denial non-retention,
  concurrent admission, and import-boundary checks.
- Out of scope: real F9/F10 implementations.
- Acceptance: every forbidden class fails closed; safe synthetic evidence
  round-trips; no peer implementation import exists.
- Verify: `npm --prefix executioner test -- tests/acceptance/components/f11`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/acceptance/components/f11/**`.
- Interfaces/decisions: accepted branch remains frozen until F12.

## Prototype recovery obligations


## s1-f12-component-connection-verification

### Observable outcome

Accepted component clusters satisfy their real neighboring ports as soon as
their dependencies are ready, then all exact tips pass together before F13.

### Scope

Real provider/consumer pairs, contract revision checks, boundary failure
propagation, value minimization, connection fixtures, and integration reports.

### Non-goals

Component implementation fixes, full journey acceptance, and inferred human
review verdicts.


## S1-F12-T1 — Establish revision manifests and cluster gates
- Outcome: one minimal in-repo manifest/checker rejects wrong-base,
  incompatible, skipped, dirty-candidate, or duplicate inputs before connection
  work; the coordinator separately owns human admission.
- Scope: `acceptedF1Base`, named Git `contractTreeOids`, serialized versions,
  exact component tips, candidate inputs, ancestry checks,
  clean install, typecheck, architecture, no-skip, and quality preflight.
- Out of scope: component integration and implementation changes.
- Acceptance: coordinator manually compares reviewed exact tips with the private
  vault ledger; repo tooling never reads/exports it and does not infer review.
  Deliberate wrong F1 SHA, missing evidence, version mismatch, duplicate feature,
  skipped conformance, and dirty candidate/source worktree at admission each
  fail with a stable diagnostic; valid partial cluster manifests pass.
- Verify: `npm --prefix executioner test -- tests/connections/component-manifest.test.ts`;
  `npm --prefix executioner test -- tests/revisions/f1-base.test.ts`.
- Relevant files: `executioner/tests/connections/component-revisions.json`,
  `executioner/tests/connections/component-manifest.test.ts`.
- Interfaces/decisions: one JSON manifest, native Git checks, no registry.

## S1-F12-T2 — Connect fixture, browser, and structural understanding
- Outcome: exact accepted F2/F3/F5 tips prove real browser-visible fixture state
  becomes deterministic page and field semantics.
- Scope: server lifecycle/reset, browser ownership/cleanup, textarea/date/group
  structure, option tokens, unknown/ambiguous pages, cancellation, visible fault,
  factual provider errors, and confirmation of local F12 integration authority.
- Out of scope: answer resolution, mutation, navigation, and full journey.
- Acceptance: no relevant fake remains; three resets have equal semantic hashes;
  configured fault reaches the browser boundary; source/owner codes survive.
- Verify: `npm --prefix executioner test -- tests/connections/surface`.
- Relevant files: `executioner/tests/connections/surface/**`.
- Interfaces/decisions: accepted F12-T1 tip is the base; merge exact F2/F3/F5
  tips with `git merge --no-ff --no-edit` in numeric order.

## S1-F12-T3 — Connect intake, resume, profile, and answers
- Outcome: exact accepted F4/F5/F6 tips preserve identity, provenance, field
  meaning, and closed
  missing/error/ambiguity results from inputs to semantic answer intent.
- Scope: job/profile/resume validation, verified artifact identity, malformed and
  revision-mismatch queries, persistence unavailable, protected-field denial,
  catalog/fixture alignment, and option ambiguity.
- Out of scope: browser mutation and orchestration.
- Acceptance: no credential enters profile/answer data; no missing/error result
  is thrown or generically remapped; resume bytes/hash mismatch fails closed.
- Verify: `npm --prefix executioner test -- tests/connections/answers`.
- Relevant files: `executioner/tests/connections/answers/**`.
- Interfaces/decisions: accepted F12-T1 tip is the base; merge exact F4/F5/F6
  tips with `git merge --no-ff --no-edit` in numeric order.

## S1-F12-T4 — Prove the complete field interaction slice
- Outcome: exact accepted F2-F8 tips prove every required fixture control through
  observe, understand, resolve, mutate, independent readback, completion, and
  legal navigation to Review.
- Scope: every frozen field-flow row, false success, cancellation uncertainty,
  validation reread, ambiguous/unavailable verification, illegal transition,
  deterministic reset, Review stop, and Submit absence.
- Out of scope: F9 loop and full MCP journey.
- Acceptance: every required field is independently verified; a driver never
  verifies itself; uncertain receipt or ambiguous/unavailable readback
  invalidates the session, yields `reconciliation_required`, and proves no
  further mutation/navigation; actual restart/reconciliation is tested only in
  T5/F13 with F9; no blind remutation or Submit capability exists.
- Verify: `npm --prefix executioner test -- tests/connections/interaction`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/tests/connections/interaction/**`.
- Interfaces/decisions: rebuild from accepted T1, merge exact F2-F8 tips, then
  cherry-pick only admitted F12-owned T2/T3 test commits.

## S1-F12-T5 — Connect control, state, events, failure, and evidence
- Outcome: exact accepted F4/F9/F10/F11 plus the interaction cluster prove real
  MCP control, reload, cancellation, terminal idempotence, factual reporting,
  privacy admission, and sanitized evidence.
- Scope: start/status/cancel/result; pending and completed replay; changed-input
  conflict; state save/reload; cancel/terminal race; bounded retry; one terminal
  event/result; uncertain-session invalidation; re-observe/reconcile-or-stop;
  monotonic progress; provider fault; denial/non-retention.
- Out of scope: complete multi-page F13 acceptance.
- Acceptance: no component fake remains on the named path; every retained real
  F9 collaborator is invoked; no dead port exists; fault coordinates preserve
  provider owner/code/retryability; after uncertain/cancelled mutation the old
  session rejects every call, F9 owns a fresh session, re-observes browser truth,
  then resumes without duplicate mutation or terminally stops; private values
  and Submit remain absent.
- Verify: `npm --prefix executioner test -- tests/connections/control`;
  `npm --prefix executioner test -- tests/connections/report`;
  `npm --prefix executioner test -- tests/security/privacy`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/connections/control/**`,
  `executioner/tests/connections/report/**`.
- Interfaces/decisions: F12 adds tests/wiring only; defects return to owners.

## S1-F12-T6 — Freeze the aggregate connection candidate
- Outcome: one exact SHA containing all accepted F2-F11 tips passes every
  connection and preflight gate together and becomes the sole F13 base.
- Scope: final accepted-tip assembly, test-only connection commits, refreshed
  manifest, clean install, typecheck, architecture, components, surface,
  answers, interaction, control, privacy, no-skip, quality, and report.
- Out of scope: component fixes and F13 behavior.
- Acceptance: candidate manifest matches the tested tree; no version/tip changes
  occurred after a slice passed; all suites pass from clean state; independent
  review leaves no P0/P1.
- Verify: `npm --prefix executioner ci`;
  `npm --prefix executioner test -- tests/architecture tests/acceptance/components tests/connections tests/security/privacy`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/connections/report/**`,
  `executioner/scripts/run-s1-connections.ts`.
- Interfaces/decisions: with explicit Git-integration authority, rebuild from
  F1 R2, merge accepted F2->F11 tips in stable numeric order, then cherry-pick
  admitted F12-owned T1->T5 test commits; conflicts return to owners. Candidate SHA
  is recorded in the vault ledger only after the commit exists. Any component
  change invalidates its affected slice and T6.


## s1-f13-integrated-controlled-journey

### Observable outcome

One composition root joins accepted components. One MCP request traverses all
controlled Workday pages to mock Review, emits monotonic safe progress, and
returns factual sanitized failure when the named fault is injected.

### Scope

Composition root, invocation of the real F9 loop through MCP/orchestrator,
acceptance runner, frozen seed/config, deterministic reports, three-rerun
proof, Stage 1 documentation, and full gates.

### Non-goals

New component behavior, live Workday, merge/push/deploy, C4, and Submit.


## S1-F13-T1 — Wire accepted components and invoke the F9 loop
- Outcome: one composition root wires all real ports and invokes the sole F9
  journey loop through MCP/orchestrator to traverse controlled pages.
- Scope: constructor wiring, lifecycle, MCP/orchestrator invocation, terminal
  result collection, and one acceptance-owned provider-fault wrapper.
- Out of scope: new component behavior, real websites, and Submit.
- Acceptance: no component imports peer implementations; composition owns
  wiring/tests only; no retry, reconciliation, or page-loop policy exists in
  F13; Review stops through F9.
- Verify: `npm --prefix executioner test -- tests/acceptance/s1/journey`.
- Relevant files: `executioner/src/composition/**`,
  `executioner/tests/acceptance/s1/journey/**`.
- Interfaces/decisions: component defects return to their feature owners.

## S1-F13-T2 — Prove happy path and injected failure across three reruns
- Outcome: the frozen acceptance command proves deterministic Review success
  and one exact factual injected failure across three runs of each path.
- Scope: fixed seeds/config, acceptance runner, progress/terminal report,
  acceptance-owned provider-wrapper trigger, semantic artifact comparison, and
  privacy scan.
- Out of scope: real Workday, screenshots, and model-quality evaluation.
- Acceptance: three clean happy runs match; three clean named-fault runs match;
  every required field is independently verified; exactly one terminal result
  exists per run; fault report names exact component/phase/step/code/retryability;
  events/evidence remain sanitized; Submit is unrepresentable and untouched.
- Verify: `npm --prefix executioner test -- tests/acceptance/s1`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/scripts/run-s1-acceptance.ts`,
  `executioner/tests/acceptance/s1/failure/**`.
- Interfaces/decisions: artifacts are synthetic, bounded, and gitignored.

## S1-F13-T3 — Close local Stage 1 and add C3 CI routing
- Outcome: component, connection, acceptance, privacy, and quality gates pass on
  one revision, and the existing Hunt CI router can actually invoke C3.
- Scope: clean-install aggregate command; minimal C3 routing in
  `scripts/run_component_ci.py`; router tests; `python ci.py c3`; inclusion in
  `python ci.py all`; Stage 1 result document; and S2 handoff.
- Out of scope: merge, push, deployment, live Workday, and S2 implementation.
- Acceptance: all thirteen stable feature IDs are accepted; no unreviewed
  contract drift; `python ci.py c3` runs Executioner quality; `python ci.py all`
  includes C3; local Tier 2 Stage 1 gates pass on the same SHA.
- Verify: `npm --prefix executioner ci`;
  `npm --prefix executioner test -- tests/architecture tests/acceptance/components tests/connections tests/acceptance/s1 tests/security/privacy`;
  `npm --prefix executioner run quality`;
  `python ci.py c3`; `python ci.py all`.
- Relevant files: `executioner/README.md`,
  `executioner/docs/s1-verification.md`, `scripts/run_component_ci.py`,
  existing CI router tests.
- Interfaces/decisions: this task records local Tier 2. Merge to `main`, hosted
  CI, push, deployment, and live proof occur only under explicit Tier 3
  promotion authority.


## s1-f2-controlled-fixture-runtime

### Observable outcome

Synthetic account, profile, questionnaire, and Review pages run offline with
stable fixture IDs, deterministic transitions, and exact reset behavior.

### Scope

Fixture manifest, sanitized HTML/assets, local server, transition controls,
reset, semantic hashes, fault hooks, and fixture-provider conformance.

### Non-goals

Real Workday, component-error wrapping, answer policy, orchestration, and Submit.


## S1-F2-T1 — Serve the frozen synthetic Workday fixture set
- Outcome: account, profile, questionnaire, and Review fixtures load offline
  from a versioned manifest.
- Scope: manifest parsing, static server, stable fixture/page IDs, sanitized
  assets, and provider conformance.
- Out of scope: browser ownership, page classification, and production selectors.
- Acceptance: every manifest page loads; missing/extra assets fail validation;
  no real applicant, employer, account, or URL appears.
- Verify: `npm --prefix executioner test -- tests/fixtures/server`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/fixtures/workday/s1/**`,
  `executioner/src/testing/fixture-server.ts`,
  `executioner/tests/fixtures/server/**`.
- Interfaces/decisions: implements the frozen FixtureRuntime port.

## S1-F2-T2 — Make transitions, reset, and fixture faults deterministic
- Outcome: fixtures expose legal next-page transitions, exact reset, and one
  deterministic browser-visible fixture fault for surface testing.
- Scope: transition state, reset helper, frozen seed, semantic hash, and bounded
  browser-visible fault response.
- Out of scope: orchestration retry policy and real failure simulation.
- Acceptance: three resets match; illegal transitions fail; the fixture fault is
  inert unless explicitly enabled.
- Verify: `npm --prefix executioner test -- tests/fixtures/state`.
- Relevant files: `executioner/src/testing/fixture-state.ts`,
  `executioner/tests/fixtures/state/**`.
- Interfaces/decisions: fixture state is owned only by F2. F13 alone owns the
  test-only provider-error wrapper used for factual component failure.

## S1-F2-T3 — Accept the fixture component independently
- Outcome: the fixture provider is ready to wait for connection testing.
- Scope: provider conformance, malformed manifest cases, reset triple-run, and
  privacy report.
- Out of scope: Playwright and end-to-end journey acceptance.
- Acceptance: all F2 tests pass from a clean install and no peer implementation
  is imported.
- Verify: `npm --prefix executioner test -- tests/acceptance/components/f2`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/acceptance/components/f2/**`.
- Interfaces/decisions: accepted component branch remains frozen until F12.

## Prototype recovery obligations


## s1-f3-browser-session-adapter

### Observable outcome

The Playwright adapter accepts a target/start request, owns exactly one
controlled page, and provides bounded observation, mutation, navigation,
lifecycle, and cancellation operations.

### Scope

Session ownership, page identity, structural reads, bounded control targets,
mutation receipts, navigation, cleanup, and browser-port conformance.

### Non-goals

Page meaning, answer policy, mutation retry, independent verification, and Submit.


## S1-F3-T1 — Own one bounded Playwright session
- Outcome: Browser Session Adapter launches or attaches one owned controlled
  page and rejects duplicate or foreign ownership.
- Scope: target/start request, session/page IDs, lifecycle, exact ownership,
  cancellation, and synthetic target tests.
- Out of scope: page meaning, field answers, and orchestration.
- Acceptance: one journey owns one page; foreign tabs are untouched; cleanup
  closes only owned resources.
- Verify: `npm --prefix executioner test -- tests/browser/session`;
  `npm --prefix executioner test -- tests/contracts/consumers/browser`.
- Relevant files: `executioner/src/browser/session.ts`,
  `executioner/tests/browser/session/**`.
- Interfaces/decisions: consumes BrowserStartRequest; provides BrowserSession.
  F2 supplies the start target only from test composition in F12/F13.

## S1-F3-T2 — Implement bounded observations and mutations
- Outcome: the adapter returns structural observations and mutation receipts
  without leaking raw handles or exposing Submit.
- Scope: page observation, stable target token resolution, readback, click/type/
  select/upload/navigation operations, time bounds, and stable errors.
- Out of scope: semantic field intent, driver behavior, and verification policy.
- Acceptance: stale/ambiguous tokens fail; operations affect only the owned
  page; raw Playwright handles never cross the port; Submit is unrepresentable.
- Verify: `npm --prefix executioner test -- tests/browser/operations`.
- Relevant files: `executioner/src/browser/adapter.ts`,
  `executioner/tests/browser/operations/**`.
- Interfaces/decisions: implements the frozen BrowserSession port exactly.

## S1-F3-T3 — Accept browser-port conformance independently
- Outcome: the browser adapter is ready to wait for real fixture and
  understanding connections.
- Scope: provider conformance, lifecycle faults, cancellation, operation bounds,
  and import-boundary checks.
- Out of scope: real F2/F5 implementations.
- Acceptance: shared conformance passes using the contract fixture; no peer
  implementation import exists.
- Verify: `npm --prefix executioner test -- tests/acceptance/components/f3`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/acceptance/components/f3/**`.
- Interfaces/decisions: accepted branch remains frozen until F12.

## Prototype recovery obligations


## s1-f4-intake-profile-journey-state

### Observable outcome

Validated job, selected resume, and applicant inputs create immutable intake
records, stable journey identity, provenance-aware profile queries, and
reloadable durable state without credentials or raw secrets.

### Scope

Job/Resume Intake, Applicant Profile Store, Journey Bootstrapper, durable
reducer/store, stable IDs, persistence, missing-answer results, and state
conformance. F4 records state; it does not own page decisions or the loop.

### Non-goals

Browser ownership, journey loop policy, credentials, event history, and
process-crash recovery.


## S1-F4-T1 — Validate immutable intake and profile boundaries
- Outcome: job, selected resume, and applicant profile inputs become immutable
  records with stable provenance-aware queries.
- Scope: required input validation, resume identity/hash, profile lookup,
  missing-answer result, provenance, and credential exclusion.
- Out of scope: browser launch, credentials, verification artifacts, and
  website-derived answers.
- Acceptance: incomplete input fails before side effects; resume mismatch fails
  closed; unknown fact returns `profile_answer_missing`; profile writes reject
  credentials.
- Verify: `npm --prefix executioner test -- tests/intake`;
  `npm --prefix executioner test -- tests/profile`.
- Relevant files: `executioner/src/intake/**`,
  `executioner/src/profile/**`, `executioner/tests/intake/**`.
- Interfaces/decisions: provides immutable JourneyInputs and ProfileQuery ports.

## S1-F4-T2 — Bootstrap and persist legal journey state
- Outcome: one bootstrap request creates a stable journey ID and a reducer
  persists only legal, reloadable, value-minimized durable state supplied by
  the orchestrator.
- Scope: bootstrap request/result, ID derivation, reducer, store, transition
  table, reload, terminal idempotence, and fault cases.
- Out of scope: browser ownership, orchestration loop, and event history.
- Acceptance: duplicate bootstrap is deterministic; illegal transitions fail;
  closing and reopening a store instance within the same process/run restores
  value-minimized IDs without secrets or raw answers. Process crash/restart
  recovery is explicitly unclaimed in S1.
- Verify: `npm --prefix executioner test -- tests/journey`.
- Relevant files: `executioner/src/journey/**`,
  `executioner/tests/journey/**`.
- Interfaces/decisions: F4 owns durable state validation/persistence; F9 owns
  the runtime loop and supplies legal state-transition commands.

## S1-F4-T3 — Accept intake and state independently
- Outcome: F4 is ready to wait for answer-resolution and orchestration
  connections.
- Scope: provider conformance, malformed inputs, reload faults, credential
  rejection, and import-boundary checks.
- Out of scope: real F6/F9 implementations.
- Acceptance: all F4 contracts pass against shared consumers and no peer
  implementation is imported.
- Verify: `npm --prefix executioner test -- tests/acceptance/components/f4`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/acceptance/components/f4/**`.
- Interfaces/decisions: accepted branch remains frozen until F12.

## Prototype recovery obligations


## s1-f5-workday-page-understanding

### Observable outcome

Bounded browser observations become deterministic Workday page types and
value-minimized semantic field observations without mutation.

### Scope

Workday detector, Workday page handlers, page signatures, Field Discovery,
UI Reader, UI-Type Classifier, requiredness/options/read state, stable field
identity, and semantic page snapshots.

### Non-goals

Applicant answers, browser mutation, verification, navigation policy, and
employer-specific branches.


## S1-F5-T1 — Detect Workday and select one page handler
- Outcome: bounded structural observations select one account, profile,
  questionnaire, Review, unknown, or ambiguous result.
- Scope: bounded ATS evidence, direct Workday detection, Workday signatures,
  page-type IDs, handler interface implementation, and negative cases.
- Out of scope: field discovery, answers, browser mutation, and real selectors.
- Acceptance: ambiguous evidence never selects a handler; handlers own page
  workflow only; no employer-specific condition exists.
- Verify: `npm --prefix executioner test -- tests/ats/workday/page-detection`.
- Relevant files: `executioner/src/ats/workday/detector.ts`,
  `executioner/src/ats/workday/pages/**`,
  `executioner/tests/ats/workday/page-detection/**`.
- Interfaces/decisions: consumes BrowserObservation; provides PageIdentity.

## S1-F5-T2 — Discover fields and classify S1 UI behavior
- Outcome: supported pages produce stable field identity, labels, roles,
  requiredness, options, read state, and one S1 UI behavior.
- Scope: Field Discovery, UI Reader, UI-Type Classifier, hidden/actionable
  filtering, ambiguity, and canonical semantic serialization.
- Out of scope: question meaning, answers, selectors outside the browser port,
  and mutation.
- Acceptance: every actionable fixture field has one stable UI type or explicit
  unsupported result; identical input yields identical value-minimized output.
- Verify: `npm --prefix executioner test -- tests/form/ui-classification`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/src/form/discovery/**`,
  `executioner/src/form/ui/**`,
  `executioner/src/form/semantic-snapshot.ts`,
  `executioner/tests/form/ui-classification/**`.
- Interfaces/decisions: UI behavior never encodes question meaning or answer.

## S1-F5-T3 — Accept page understanding independently
- Outcome: F5 is ready to wait for browser and interaction connections.
- Scope: provider conformance, golden snapshots from frozen contract
  observations, unknown/ambiguous cases, and import-boundary checks.
- Out of scope: real F3/F6/F7 implementations.
- Acceptance: snapshots contain no raw personal values; all F5 tests pass with
  shared fakes and no peer implementation import.
- Verify: `npm --prefix executioner test -- tests/acceptance/components/f5`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/golden/s1/understanding/**`,
  `executioner/tests/acceptance/components/f5/**`.
- Interfaces/decisions: golden changes require explicit stable reason.

## Prototype recovery obligations


## s1-f6-answer-option-resolution

### Observable outcome

Semantic field observations and authoritative profile queries produce canonical
answer/option intents or explicit missing, unsupported, and ambiguous results.

### Scope

Question catalog, normalization, approved aliases, Canonical Answer Resolver,
Option Mapper, answer provenance, protected-category policy, and the one
configured narrative template.

### Non-goals

Profile mutation, browser targets, clicks, invented facts, and catalog mutation
from fuzzy/model output.


## S1-F6-T1 — Implement minimal canonical catalogs and normalization
- Outcome: S1 question and option text normalizes to reviewed canonical IDs or
  explicit unknown/ambiguous results.
- Scope: punctuation/space/case/required-marker normalization, canonical IDs,
  approved aliases, option IDs, provenance metadata, and collision tests.
- Out of scope: fuzzy auto-accept, browser reads, and model catalog mutation.
- Acceptance: normalization is deterministic; alias collisions fail; unknown
  text never silently maps.
- Verify: `npm --prefix executioner test -- tests/form/catalogs`.
- Relevant files: `executioner/src/form/questions/**`,
  `executioner/src/form/options/catalog.ts`,
  `executioner/tests/form/catalogs/**`.
- Interfaces/decisions: catalogs carry reviewed provenance.

## S1-F6-T2 — Resolve authoritative answers and visible options
- Outcome: canonical questions query only authoritative profile data and produce
  a semantic field intent, missing result, no option match, or ambiguity.
- Scope: answer resolver, provenance, Option Mapper, protected-category denial,
  salary/legal/authorization handling, and narrative template provider.
- Out of scope: browser targets, clicks, profile mutation, and model-selected
  answers.
- Acceptance: missing fact yields `profile_answer_missing`; holding values are
  impossible for protected fields; option ambiguity stays explicit; eligible
  paragraphs use the configured template only.
- Verify: `npm --prefix executioner test -- tests/form/answer-resolution`.
- Relevant files: `executioner/src/form/answers/**`,
  `executioner/src/form/options/mapper.ts`,
  `executioner/tests/form/answer-resolution/**`.
- Interfaces/decisions: consumes ProfileQuery and FieldObservation fakes;
  provides FieldIntent.

## S1-F6-T3 — Accept answer resolution independently
- Outcome: F6 is ready to wait for real profile, understanding, and driver
  connections.
- Scope: provider conformance, catalog negatives, protected-field matrix,
  profile fake consumption, and import-boundary checks.
- Out of scope: real F4/F5/F7 implementations.
- Acceptance: all F6 cases pass without peer imports or invented applicant
  facts.
- Verify: `npm --prefix executioner test -- tests/acceptance/components/f6`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/acceptance/components/f6/**`.
- Interfaces/decisions: accepted branch remains frozen until F12.

## Prototype recovery obligations


## s1-f7-field-interaction-drivers

### Observable outcome

Semantic field intents dispatch to bounded S1 behavior drivers that mutate only
their owned field and return factual mutation receipts.

### Scope

Driver registry, target validation, text, textarea, radio/checkbox,
select/listbox, date, and file-upload drivers, cancellation, receipts, and
provider conformance.

### Non-goals

Question resolution, self-verification, navigation, retry policy, and Submit.


## S1-F7-T1 — Implement bounded driver dispatch and target validation
- Outcome: one registry dispatches a validated semantic intent to exactly one
  supported S1 behavior driver.
- Scope: driver port, behavior ID dispatch, target-token validation, unsupported/
  ambiguous outcomes, cancellation, and mutation receipt.
- Out of scope: question resolution, independent verification, navigation, and
  raw selector acceptance.
- Acceptance: invalid intent or target produces no browser call; drivers cannot
  request Submit; one intent reaches one driver.
- Verify: `npm --prefix executioner test -- tests/interaction/drivers/registry`.
- Relevant files: `executioner/src/interaction/drivers/registry.ts`,
  `executioner/src/interaction/drivers/types.ts`,
  `executioner/tests/interaction/drivers/registry/**`.
- Interfaces/decisions: consumes FieldIntent and BrowserSession fake; provides
  MutationReceipt.

## S1-F7-T2 — Implement the S1 behavior drivers
- Outcome: text, textarea, radio/checkbox, select/listbox, date, and file-upload
  intents execute through bounded browser operations.
- Scope: one driver per distinct behavior, exact operation sequence, upload
  identity, cancellation, receipts, and behavior fault tests.
- Out of scope: self-verification, page completion, retries, and real Workday
  selectors.
- Acceptance: each driver touches only its field; unsupported states fail
  closed; receipts report attempted operations without claiming verification.
- Verify: `npm --prefix executioner test -- tests/interaction/drivers/behaviors`.
- Relevant files: `executioner/src/interaction/drivers/**`,
  `executioner/tests/interaction/drivers/behaviors/**`.
- Interfaces/decisions: repeated mechanics use one shared helper only when two
  drivers need it.

## S1-F7-T3 — Accept drivers independently
- Outcome: F7 is ready to wait for real understanding, answer, browser, and
  verifier connections.
- Scope: provider conformance, browser-fake calls, false-success receipt case,
  cancellation, and import-boundary checks.
- Out of scope: real peer implementations.
- Acceptance: all S1 behaviors pass shared conformance; no driver reads its own
  committed state; no peer implementation import exists.
- Verify: `npm --prefix executioner test -- tests/acceptance/components/f7`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/acceptance/components/f7/**`.
- Interfaces/decisions: accepted branch remains frozen until F12.

## Prototype recovery obligations


## s1-f8-independent-verification-navigation

### Observable outcome

A dependency separate from every driver rereads committed state, accepts or
rejects each result, and returns page-completion/navigation decisions including
Review stop. F9 owns execution of the journey loop.

### Scope

Independent Field Verifier, readback normalization, Page Completion Checker,
Page Navigator decision/result, validation reread, allowed-transition check,
Review Stopper, and bounded verification polling.

### Non-goals

Corrective mutation, answer resolution, durable journey state, and loop/retry
ownership.


## S1-F8-T1 — Independently verify committed field state
- Outcome: browser readback plus mutation intent/receipt returns verified,
  rejected, ambiguous, or unavailable without calling a driver.
- Scope: UI-type readback strategies, normalized comparison, upload identity,
  polling bounds, value-minimized evidence, and false-success faults.
- Out of scope: corrective mutation, completion, navigation, and driver imports.
- Acceptance: injected false-success is rejected; stale/hidden state does not
  pass; verifier has no driver dependency.
- Verify: `npm --prefix executioner test -- tests/interaction/verification`.
- Relevant files: `executioner/src/interaction/verification/**`,
  `executioner/tests/interaction/verification/**`.
- Interfaces/decisions: consumes BrowserSession and MutationReceipt fakes;
  provides VerificationResult.

## S1-F8-T2 — Gate completion, navigation, and Review stop
- Outcome: accepted required-field results return approval for one legal
  navigation step; all other states block, and Review returns a terminal stop.
- Scope: completion predicate, validation reread, navigation intent/result,
  allowed transition table, transition reconciliation, and Review guard.
- Out of scope: corrective field mutation and orchestration retry policy.
- Acceptance: unverified required field blocks; transition must match allowed
  next state; Review is terminal; no Submit action or override exists.
- Verify: `npm --prefix executioner test -- tests/interaction/navigation`.
- Relevant files: `executioner/src/interaction/completion/**`,
  `executioner/src/interaction/navigation/**`,
  `executioner/tests/interaction/navigation/**`.
- Interfaces/decisions: completion consumes VerificationResult only; F8 returns
  decisions/results and never owns the page loop or durable state.

## S1-F8-T3 — Accept verification and navigation independently
- Outcome: F8 is ready to wait for real driver and browser connections.
- Scope: provider conformance, false-success, stale state, incomplete page,
  illegal transition, Review stop, and import-boundary checks.
- Out of scope: real peer implementations.
- Acceptance: all F8 tests pass with shared fakes; verifier imports no driver;
  Submit remains absent.
- Verify: `npm --prefix executioner test -- tests/acceptance/components/f8`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/acceptance/components/f8/**`.
- Interfaces/decisions: accepted branch remains frozen until F12.

## Prototype recovery obligations


## s1-f9-orchestrator-mcp-facade

### Observable outcome

The sole C3 loop owner coordinates frozen component ports, while one bounded
MCP facade exposes start, status, cancel, and result operations without raw
browser targets or Submit.

### Scope

Orchestrator state machine, the only journey/page loop, reconciliation and
retry/cancellation policy, operation ownership, terminal idempotence, MCP
schemas/stdio facade, concurrency guard, and provider conformance using
component fakes.

### Non-goals

Peer implementations, provider business logic, C4, raw browser tools, model
selection, and Submit.


## Recovery contract

## S1-F9-T1 — Implement operation ownership and deterministic replay
- Outcome: start, status, cancel, and result operations have one deterministic
  registry with stable concurrent ownership and recorded replay.
- Scope: bounded caller `requestId` idempotency key, C3-generated journey ID,
  structural request equality, one active journey,
  pending identical duplicate, completed replay, changed-input conflict,
  cancellation request state, injected clock/ID source, and persistence calls.
- Out of scope: page loop, mutation, terminal reporting, and MCP transport.
- Acceptance: identical replay returns the recorded result; changed input fails
  closed; pending-start replay cannot later change from busy to success; NUL or
  malformed strings cannot collide; no duplicate side effect occurs.
- Verify: `npm --prefix executioner test -- tests/control/orchestrator/operations`;
  `npm --prefix executioner run typecheck`.
- Relevant files: `executioner/src/control/orchestrator/operations/**`,
  `executioner/tests/control/orchestrator/operations/**`.
- Interfaces/decisions: F4 persists legal state; F9 owns operation lifecycle.

## S1-F9-T2 — Implement the sole bounded page loop
- Outcome: one explicit loop coordinates observation, understanding, answers,
  driver mutation, independent verification, completion, navigation, and Review.
- Scope: closed loop states, page/mutation budgets, one active mutation, legal
  provider order, Review terminal candidate, and factual provider error flow.
- Out of scope: generic retry, terminal event commitment, MCP, and peer logic.
- Acceptance: every call follows the frozen field-flow; no navigation precedes
  required verification; unknown/missing/ambiguous results remain factual; F9
  never calls Submit or asks a driver to verify itself.
- Verify: `npm --prefix executioner test -- tests/control/orchestrator/loop`;
  `npm --prefix executioner test -- tests/architecture`.
- Relevant files: `executioner/src/control/orchestrator/loop/**`,
  `executioner/tests/control/orchestrator/loop/**`.
- Interfaces/decisions: F9 is the sole loop/retry owner; providers own facts.

## S1-F9-T3 — Close retry, reconciliation, cancellation, and terminalization
- Outcome: provider outcomes lead to bounded retry, required reconciliation, or
  one committed terminal result/event without race-dependent behavior.
- Scope: error-code retry policy, uncertain mutation/session invalidation,
  reconcile-or-stop, cancel/complete serialization, terminal idempotence,
  provider-attributed events, journey-state commands, and factual failure.
- Out of scope: transport schemas and complete real-provider connections.
- Acceptance: ambiguous/unavailable verification cannot trigger blind remutation;
  accepted cancellation cannot race to a different terminal result; committed
  terminal wins; exactly one terminal event/result exists; three injected-clock
  runs are semantically identical.
- Verify: `npm --prefix executioner test -- tests/control/orchestrator/recovery`;
  `npm --prefix executioner test -- tests/control/orchestrator/races`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/src/control/orchestrator/recovery/**`,
  `executioner/src/control/orchestrator/terminal/**`,
  `executioner/tests/control/orchestrator/races/**`.
- Interfaces/decisions: cancelled/uncertain browser mutation invalidates the
  session; F9 reconciles or restarts before another mutation.

## S1-F9-T4 — Expose the closed MCP facade and stdio transport
- Outcome: MCP start, status, cancel, and result requests parse exactly and map
  once to the accepted operation registry.
- Scope: exact serialized parsing, method routing, stdio adapter, value-free
  results, privacy admission, transport errors, and lifecycle cleanup.
- Out of scope: HTTP, raw browser tools, selectors, policy override, Submit,
  Local Model Controller, and a second loop.
- Acceptance: extra/hidden/inherited/symbol/accessor fields fail; F9 and F11
  allowlists agree; stdio emits the exact MCP result envelope; shutdown cleans
  the session and cannot create another terminal result.
- Verify: `npm --prefix executioner test -- tests/control/mcp`;
  `npm --prefix executioner test -- tests/control/mcp/stdio-result.test.ts`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/src/control/mcp/**`,
  `executioner/tests/control/mcp/**`.
- Interfaces/decisions: MCP is transport only; it never owns state policy.

## S1-F9-T5 — Accept orchestration and MCP independently
- Outcome: F9 is frozen for real F12 control connections.
- Scope: shared-fake collaborator matrix, all operation/replay/race regressions,
  JourneyControl conformance, MCP negatives, no-skip gate, import boundary,
  module-boundary review, typecheck, privacy, quality, and independent review.
- Out of scope: real peer providers and F12 fixes inside F9.
- Acceptance: every R2 provider error is preserved; all known F9 prototype P1s
  have regressions; no required suite is skipped/empty; no module exceeds the
  boundary without an accepted split review; no P0/P1 remains.
- Verify: `npm --prefix executioner test -- tests/acceptance/components/f9`;
  `npm --prefix executioner test -- tests/contracts/no-skipped-conformance.test.ts`;
  `npm --prefix executioner test -- tests/architecture`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/acceptance/components/f9/**`.
- Interfaces/decisions: accepted branch remains frozen until F12 returns an
  owner-scoped defect.
