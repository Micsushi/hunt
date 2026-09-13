# S2 Single Real Workday Journey — requirement reference

These are preserved portable scope and acceptance requirements from the original stage plans. They do not activate work, record acceptance, grant browser/account access, or authorize integration or release. Existing contracts and tests remain executable authority; deviations need explicit reconciliation. Final Submit stays forbidden. Task identifiers are traceability labels, not an active task board.


## s2-f0-live-boundary-contract-delta

### Observable outcome

One offline-reviewed contract revision closes persistent browser ownership,
outside-repo secret handling, privileged credential mutation, bounded mailbox
access, single-use verification navigation, live recovery checkpoints, and
sanitized evidence before any S2 adapter handles real values.

### Scope

S1-to-S2 delta/threat matrix, exact target identity, persistent browser
lifecycle, SecretStore handles, privileged credential mutation, MailboxProvider,
VerificationArtifact handles, recovery/evidence boundaries, fakes, conformance,
walking skeletons, revision manifest, and change protocol.

### Non-goals

Real credentials, Gmail calls, account mutation, live Workday navigation,
selectors, provider implementation, and S3 corpus behavior.

### Acceptance

- Exactly two privileged SecretStore consumers exist: account
  `CredentialMutationAdapter` for typed account fields and
  `PrivilegedGmailAuthExecutor` for authenticated Gmail calls. Generic drivers,
  mailbox policy, and F9 cannot resolve plaintext.
- Gmail can inspect a bounded message internally but returns only `provider`,
  received-time bucket, expiry, candidate count, and a journey-scoped single-use
  opaque verification handle. Subject, sender/recipient values, Gmail message/
  thread IDs, headers, URL/token, and body cannot cross the provider boundary.
- A privileged verification navigator resolves the link only after host,
  tenant, recipient, time, and replay policy pass.
- Browser profiles, secrets, configuration, and live evidence remain outside
  the repository with explicit retention/deletion ownership.
- Exact target identity omits query, fragment, and token material.
- Every new port has fakes, conformance, negative/replay/cancel/restart cases,
  and two offline walking skeletons.

### Verification

Tier 2: live-contract, security, fake-provider, conformance, and walking-skeleton
suites with no secrets or real network access, plus quality and one broad
independent review with no P0/P1. Apply findings, then run focused rechecks only.


## S2-F0-T1 — Freeze the live threat, authority, and lifecycle matrix
- Outcome: every live value, capability, side effect, storage root, and cleanup
  action has one owner and a least-authority consumer.
- Scope: persistent browser/profile, target identity, SecretStore, credential
  typing, privileged Gmail authentication/query, verification artifact/navigation, checkpoints, evidence,
  agents/operators, retention, deletion, crash cleanup, factual outcomes,
  stable errors, terminal status, wire versions, fault ownership, layered
  classification, sanitized unknown candidates, and review/promotion authority.
- Out of scope: TypeScript shapes and provider implementation.
- Acceptance: only `CredentialMutationAdapter` and
  `PrivilegedGmailAuthExecutor` may resolve scoped plaintext; generic driver,
  mailbox policy, and F9 never see it; component/review agents
  receive sanitized fixtures only; raw pages/messages/tokens are not persisted
  by default; outside-repo roots and deletion owners are explicit.
- Acceptance: the owner-approved storage policy and every factual/error row
  match the S2 reconciliation ledger; no observed live fact is converted into
  an unrelated error.
- Acceptance: ATS family, page type, UI behavior, question type, canonical
  answer type/provenance, and visible-option mapping have separate owners.
  Unknowns stop and produce only sanitized candidate evidence; no live process
  mutates or reloads selectors, catalogs, aliases, applicant facts, or answers.
- Verify: `npm --prefix executioner test -- tests/live/contracts/authority-matrix.test.ts`.
- Relevant files: `executioner/docs/s2-live-boundaries.md`,
  `executioner/tests/live/contracts/authority-matrix.test.ts`.

## S2-F0-T2 — Define minimal live ports, schemas, fakes, and conformance
- Outcome: persistent browser, SecretStore, privileged credential mutation,
  `PrivilegedGmailAuthExecutor`, MailboxProvider, VerificationArtifact, recovery, and evidence have closed
  versioned contracts and deterministic fakes.
- Scope: exact parsing, opaque/scoped handles, errors/retryability, cancellation,
  replay, restart/reattach, cleanup, target canonicalization, independent live
  schema versions, and the explicit common terminal/error/event wire revisions.
- Out of scope: Gmail/DPAPI/Playwright implementation and real values.
- Acceptance: wrong scope/host/tenant/time/journey/replay fails closed; query and
  fragment/token material cannot enter target identity or evidence; every port
  has a registered conformance runner.
- Verify: `npm --prefix executioner test -- tests/live/contracts`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/src/contracts/live/**`,
  `executioner/src/testing/live/**`, `executioner/tests/live/contracts/**`.

## S2-F0-T3 — Prove offline persistent-browser and secure-account skeletons
- Outcome: two fake-provider flows prove the new ports compose without exposing
  real values or granting a second loop owner.
- Scope: launch/reattach/reconcile/cleanup skeleton; secret handle -> privileged
  credential mutation -> account state -> mailbox handle -> privileged verified
  navigation skeleton; negative/cancel/replay/restart cases.
- Out of scope: real browser, DPAPI, Gmail, or Workday.
- Acceptance: F9 coordinates but never resolves plaintext or raw link; generic
  drivers/mailbox policy remain value-blind; privileged Gmail executor contains
  OAuth plaintext only for one call and returns no secret; one handle cannot
  cross journey or replay; restart
  recovers only explicitly persisted safe state.
- Acceptance: one offline scenario stops at each classifier layer, emits the
  exact sanitized unknown candidate, and proves zero runtime selector/catalog/
  alias/fact/answer mutation or reload.
- Verify: `npm --prefix executioner test -- tests/live/walking-skeleton`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/tests/live/walking-skeleton/**`.

## S2-F0-T4 — Accept and freeze the S2 contract manifest
- Outcome: one exact S2 contract revision and manifest becomes the only base for
  S2-F1/F2 adapter work.
- Scope: clean install, contracts, fakes, conformance, skeletons, security,
  ancestry, versions, change protocol, and one broad independent review.
- Out of scope: live proof, merge, push, and adapter implementation.
- Acceptance: zero required skips; no P0/P1; manifest records accepted S1 base,
  Git tree OIDs for `executioner/src/contracts/live`,
  `executioner/src/testing/live`, and `executioner/tests/live/contracts`, plus
  serialized versions and allowed target adapters.
- Verify: `npm --prefix executioner ci`;
  `npm --prefix executioner test -- tests/live/contracts tests/live/walking-skeleton tests/security`;
  `npm --prefix executioner run quality`.
- Relevant files: `executioner/docs/s2-contract-freeze.md`, S2 contract manifest.


## s2-f1-real-session-account-access

### Observable outcome

C3 starts an isolated real browser at one exact approved Workday job, confirms
site and posting identity, and reaches the correct existing-account,
create-account, or verification state.

### Scope

Real-run preflight, persistent browser adapter, exact-target policy, live
Workday detection, account-state classification, frozen Windows DPAPI
SecretStore, and account-entry handlers.

### Non-goals

Mailbox verification completion, application fields, CAPTCHA bypass, and Submit.

### Acceptance

- Wrong host, job, tenant, or posting stops before credentials or mutation.
- Browser ownership and exact page identity survive redirects and new tabs.
- Existing/create/verification states are classified from observed UI.
- Credentials are requested only through SecretStore interfaces.
- Unsupported access controls stop with factual manual-intervention status.

### Verification

Tier 2: real-adapter contract tests, controlled redirect/tab fixtures, then an
approved live entry proof with sanitized metadata.
Tier 3: included in S2 same-revision acceptance.
Tier 4: owner confirms tenant, job, and account identity visually.


## S2-F1-T1: Define and enforce the real-run preflight
- Outcome: a real journey cannot start until exact job URL, tenant/host policy,
  account mode, profile, resume, artifact roots, owner approval, secret backend,
  and mailbox provider are valid.
- Scope: real-run config schema, allowlists, secret references, dry preflight
  report, repository-path denial, and operator runbook.
- Out of scope: launching the browser or reading secret values.
- Acceptance: missing or unsafe inputs fail before browser start; config
  selects `windows-dpapi-current-user-v1` and `gmail-api-v1`; it contains secret
  references only; artifact and evidence roots resolve outside repo.
- Verify: `npm --prefix executioner test -- tests/live/preflight`.
- Relevant files: `executioner/src/live/preflight/**`,
  `executioner/tests/live/preflight/**`, `executioner/README.md`.
- Interfaces/decisions: one explicitly approved URL and account per acceptance
  run.

## S2-F1-T2: Implement the persistent real-browser adapter
- Outcome: Browser Session Manager launches or attaches an isolated persistent
  browser, pins the exact page, handles redirects and new tabs, and owns
  cleanup.
- Scope: Playwright persistent-context adapter, profile-root policy, target
  pin, popup/tab reconciliation, timeouts, cancellation, and adapter tests.
- Out of scope: Workday classification and credentials.
- Acceptance: foreign windows or tabs are never adopted; target mismatch fails
  closed; cleanup never closes unowned browsers; restart can re-identify owned
  state.
- Verify: `npm --prefix executioner test -- tests/browser/live-adapter`.
- Relevant files: `executioner/src/browser/playwright-live/**`,
  `executioner/tests/browser/live-adapter/**`.
- Interfaces/decisions: foreground focus is not a general capability; browser
  profile paths are runtime-only.

## S2-F1-T3: Verify exact Workday posting and account state
- Outcome: live ATS and page detection confirm tenant and posting identity and
  classify sign-in, create-account, verification, application, unavailable, or
  access-control state.
- Scope: bounded live observations, posting identity contract, redirect
  reconciliation, independent ATS-family classification, Workday page/account-
  state classification, and sanitized structural evidence.
- Out of scope: account mutation and mailbox use.
- Acceptance: wrong or dead posting is distinct from C3 failure; ambiguous
  identity stops; non-Workday is reported unsupported; no raw page text is
  retained; every state and unknown layer has a stable factual result.
- Verify: controlled live-shape fixtures plus
  `npm --prefix executioner test -- tests/ats/workday/live-entry`.
- Relevant files: `executioner/src/ats/workday/live/**`,
  `executioner/tests/ats/workday/live-entry/**`.
- Interfaces/decisions: exact target identity is rechecked after every redirect.

## S2-F1-T4: Implement the frozen Windows SecretStore
- Outcome: account and Gmail OAuth credentials are created and read only
  through opaque scoped handles backed by Windows DPAPI CurrentUser encryption.
- Scope: `windows-dpapi-current-user-v1` adapter implementing the frozen S2-F0
  SecretStore contract,
  ciphertext and metadata roots outside repo, lifecycle, rotation, delete,
  handle scoping, redaction markers, and misuse tests.
- Out of scope: mailbox search, account-page mutation, other operating systems,
  and plaintext fallback.
- Acceptance: only the frozen `CredentialMutationAdapter` and
  `PrivilegedGmailAuthExecutor` consumers can resolve scoped plaintext; expired,
  wrong-provider, wrong-consumer, wrong-journey, or wrong-scope handles fail;
  ciphertext cannot be decrypted by a different Windows user;
  serialization and privacy scans expose no secret values.
- Verify: `npm --prefix executioner test -- tests/secrets`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/src/secrets/**`,
  `executioner/tests/secrets/**`.
- Interfaces/decisions: the adapter choice is frozen for S2. Replacing it
  requires a plan change and owner approval.

## S2-F1-T5: Reach the correct account-access boundary
- Outcome: the approved real journey reaches the expected sign-in,
  create-account, verification, or already-authenticated application state.
- Scope: account-entry page handlers, semantic intents, verified mutations
  using secret handles, state reconciliation, and bounded failure results.
- Out of scope: fetching verification mail and application fields.
- Acceptance: credentials never appear in logs, events, or evidence; field
  commits are independently verified without value retention; unsupported
  access control stops safely.
- Verify: `npm --prefix executioner test -- tests/account/entry`; then
  `npm --prefix executioner run live:s2 -- --config <owner-inputs>
  --stop-after account_access --evidence-root <outside-repo-root>`. Pass when
  `acceptance.json` records `checkpoint=account_access`, the exact approved
  tenant and posting, independently verified account fields,
  `submitActivated=false`, and `privacyScan=pass`.
- Relevant files: `executioner/src/account/entry/**`,
  `executioner/tests/account/entry/**`.
- Interfaces/decisions: components receive opaque secret handles; only the
  privileged credential-mutation adapter resolves and types plaintext. Generic
  drivers and F9 never resolve it.


## s2-f2-mailbox-verification-credentials

### Observable outcome

C3 creates or accesses the isolated Workday account and completes standard email
verification through configured SecretStore and MailboxProvider adapters without
placing secrets or messages in profile, events, fixtures, or evidence.

### Scope

Gmail API adapter, verification-message policy, privileged verification
navigation, account lifecycle, timeout/retry, and privacy against the S2-F0
MailboxProvider and opaque VerificationArtifact contracts.

### Non-goals

CAPTCHA/MFA bypass, arbitrary mailbox search, and application-field completion.

### Acceptance

- Secrets are write-only to ordinary components and redacted from all outputs.
- Mail search is bounded by recipient, sender policy, time, tenant, and journey.
- Verification links pass host/token safety validation before navigation.
- Used verification artifacts cannot be replayed into another journey.
- Timeout and provider failure produce distinct factual retryable states.

### Verification

Tier 2: fake-provider contracts, privacy/host/time-boundary tests, and one real
standard verification proof.
Tier 3: included in S2 acceptance.
Tier 4: owner confirms the expected account becomes verified.


## S2-F2-T1: Implement bounded mailbox policy against the frozen contract
- Outcome: mailbox query/consume policy implements S2-F0 and returns exactly
  provider enum, received-time bucket, expiry, candidate count, and opaque handle.
- Scope: bounded query policy, safe metadata, opaque VerificationArtifactHandle,
  clock control, timeout, cancel, consume, and contract-driven tests.
- Out of scope: real Gmail calls and arbitrary email access.
- Acceptance: query requires journey, recipient, time, sender, and tenant
  bounds; message bodies are never returned; ambiguous, expired, and used
  results are distinct.
- Verify: `npm --prefix executioner test -- tests/mailbox`.
- Relevant files: `executioner/src/mailbox/policy.ts`,
  `executioner/tests/mailbox/**`. Contracts/fakes remain S2-F0-owned.
- Interfaces/decisions: subject, sender/recipient values, Gmail message/thread
  IDs, headers, raw URL/token, body, and OAuth bytes never cross this boundary.

## S2-F2-T2: Implement the frozen Gmail API adapter
- Outcome: the approved Gmail test mailbox finds one expected Workday
  verification message and returns safe metadata plus one opaque, journey-
  scoped, single-use `VerificationArtifactHandle`.
- Scope: `gmail-api-v1` adapter using `PrivilegedGmailAuthExecutor`, OAuth through scoped SecretStore handles, bounded
  polling, sender, recipient and time filtering, provider errors, and
  fake-server tests.
- Out of scope: other mailbox providers, generalized inbox tools, unrelated
  messages, and CAPTCHA or MFA.
- Acceptance: adapter cannot enumerate beyond query bounds; no forbidden mailbox
  field crosses the provider boundary or enters logs/evidence; auth, rate, and
  network failures have stable retryability. OAuth plaintext exists only inside
  one privileged executor call and is never returned, logged, persisted, placed
  in errors/evidence, or visible to ordinary components. Wrong provider/
  consumer/scope/journey handles fail with zero secret bytes emitted. Only the
  privileged navigator resolves the verification handle after policy admission.
- Verify: `npm --prefix executioner test -- tests/mailbox/providers/gmail`; then
  `npm --prefix executioner run live:s2 -- --config <owner-inputs>
  --stop-after mailbox_candidate --evidence-root <outside-repo-root>`. Pass
  when `acceptance.json` records `checkpoint=mailbox_candidate`,
  `provider=gmail-api-v1`, one candidate, `messageBodyRetained=false`, and
  `privacyScan=pass`.
- Relevant files: `executioner/src/mailbox/providers/gmail/**`,
  `executioner/tests/mailbox/providers/gmail/**`.
- Interfaces/decisions: Gmail API is the only S2 provider. Owner must supply
  approved mailbox and OAuth secret handles before the live slice.

## S2-F2-T3: Complete and verify the Workday account lifecycle
- Outcome: create or sign-in, mailbox verification, privileged verification-link
  navigation, and post-verification state complete as one idempotent account
  lifecycle.
- Scope: lifecycle state machine, handle safety and consume, privileged verified
  navigation, browser transition,
  retry and timeout policy, reused-account path, deterministic assembly manifest
  for accepted S2-F0/F1/F2 inputs, and live acceptance slice.
- Out of scope: application filling and challenge bypass.
- Acceptance: link host, tenant, and token policy passes before navigation;
  consumed links cannot cross journeys; verified account state is independently
  observed; timeouts and provider failures report accurately; coordinator
  records the accepted lifecycle-candidate SHA after it exists.
- Verify: `npm --prefix executioner test -- tests/account/lifecycle`; then
  `npm --prefix executioner run live:s2 -- --config <owner-inputs>
  --stop-after account_verified --evidence-root <outside-repo-root>`. Pass when
  `acceptance.json` records `checkpoint=account_verified`, independently
  observed verified state, one consumed candidate, `submitActivated=false`, and
  `privacyScan=pass`.
- Relevant files: `executioner/src/account/lifecycle/**`,
  `executioner/tests/account/lifecycle/**`,
  `executioner/docs/s2-integration-manifest.json`.
- Interfaces/decisions: account state owns opaque verification handles, not
  ApplicantProfile. Only the privileged navigator resolves a raw link after
  host/tenant/recipient/time/replay admission.
- Interfaces/decisions: build T3 from accepted F1-T5 lane head plus accepted
  F2-T2 lane head using `git merge --no-ff --no-edit`. F2-T2 already contains
  F2-T1; earlier task SHAs are evidence, not duplicate integration inputs.
  Conflicts return to owners. The accepted T3 SHA is the sole S2-F3 base.


## s2-f3-real-application-completion

### Observable outcome

On the approved real Workday application, C3 uploads the selected resume,
answers all authoritative profile/application questions, handles required
repeatable controls, and advances toward Review with independent verification.

### Scope

Resume upload, Workday profile/application page handlers, real UI driver
variants, questionnaire/narrative/option mapping, repeatables, dates, and
required-field reconciliation.

### Non-goals

Broad corpus variants, invented answers, and Submit.

### Acceptance

- The exact selected resume is uploaded and independently identified.
- Every answered field traces to profile, job, resume, approved catalog, or
  narrative template.
- Unknown facts stop rather than receive fallback values.
- Repeatable sections contain no C3-created duplicate or empty rows.
- Page completion and navigation remain verification-gated.

### Verification

Tier 2: live-shape fixtures for each observed primitive plus one approved real
application walk to the last pre-Review page.
Tier 3: included in S2 acceptance.
Tier 4: owner samples committed values and selected resume.


## S2-F3-T1 — Upload and independently identify the selected resume
- Outcome: the exact selected resume artifact is uploaded on the real Workday
  page and independently confirmed by opaque artifact identity, size/type, and
  browser structural state.
- Scope: upload page handler, file-intent contract, file driver live variant,
  verifier, replace-existing policy, and live-shape fixture.
- Out of scope: parsing resume content and other form fields.
- Acceptance: wrong/missing artifact fails before upload; upload consumes the
  same immutable verified handle without reopening a path; source mutation
  either cannot alter captured bytes or yields `artifact_changed` before browser
  side effect; duplicate uploads are avoided;
  verifier does not trust driver success; filename, path, content, and digest
  never enter events or evidence.
- Verify: `npm --prefix executioner test -- tests/ats/workday/resume`; then the frozen
  live command with `--stop-after resume_verified`. Pass when
  `acceptance.json` records an opaque artifact ID, safe size/type, independent
  structural verification, and no filename/path/content/digest.
- Relevant files: `executioner/src/ats/workday/application/resume/**`,
  `executioner/tests/ats/workday/resume/**`.
- Interfaces/decisions: Resume Intake supplies immutable selected file identity.

## S2-F3-T2 — Complete real profile and contact pages
- Outcome: Workday profile/contact pages fill authoritative identity, address,
  phone, experience, education, skills, and date controls without duplicates.
- Scope: observed page-handler/driver variants, repeatable-row reconciliation,
  date/phone/search-select controls, verification, and proving fixtures.
- Out of scope: questionnaire semantics and unsupported corpus variants.
- Acceptance: every value has provenance; empty/duplicate rows are removed only
  when C3 owns them; committed visible state verifies; missing facts stop. Page
  type, UI behavior/variant, question type, canonical answer type/provenance,
  and option mapping remain independent classifications.
- Verify: `npm --prefix executioner test -- tests/ats/workday/profile`; then the
  frozen live command with `--stop-after profile_verified`. Pass when
  `acceptance.json` lists every required profile field as verified or one exact
  `profile_answer_missing` stop and reports zero C3-owned duplicate rows.
- Relevant files: `executioner/src/ats/workday/application/profile/**`,
  `executioner/tests/ats/workday/profile/**`.
- Interfaces/decisions: production selector/behavior changes require a sanitized fixture.

## S2-F3-T3 — Complete real questionnaire and narrative pages
- Outcome: required application questions resolve through canonical answer and
  option mapping, eligible paragraphs use the configured template, and all commits verify.
- Scope: observed questionnaire pages, fixed-choice mapping, consent/legal/
  authorization policy, narrative provider, active-listbox behavior, and fixtures.
- Out of scope: model-authored personal claims and automatic catalog mutation.
- Acceptance: protected categories never use placeholders; ambiguity/missing data
  stop with stable codes; selected visible options and narratives independently
  verify. Every new observed behavior begins as sanitized candidate evidence
  and a failing offline fixture; no live catalog or answer mutation is allowed.
- Verify: `npm --prefix executioner test -- tests/ats/workday/questions`; then the
  frozen live command with `--stop-after questionnaire_verified`. Pass when
  `acceptance.json` records provenance and independent verification for every
  committed answer and zero placeholders in protected categories.
- Relevant files: `executioner/src/ats/workday/application/questions/**`,
  `executioner/tests/ats/workday/questions/**`.
- Interfaces/decisions: the S1 catalog boundary remains unchanged; additions need provenance.

## S2-F3-T4 — Reach the final pre-Review state with all pages reconciled
- Outcome: the real application completes resume, profile, repeatable, and
  questionnaire pages and reaches the last legal transition before Review.
- Scope: live page-walk integration, required-field reconciliation, affected-page
  rerun, bounded retries, progress accuracy, and sanitized page outcome report.
- Out of scope: Review terminal acceptance and broad corpus variants.
- Acceptance: no page advances with unverified required fields; no duplicate rows;
  progress matches browser truth; failure packet identifies the exact owning
  classifier/primitive and sanitized unknown layer.
- Verify: `npm --prefix executioner test -- tests/integration/s2-application-walk`; then the
  frozen live command with `--stop-after pre_review`. Pass when
  `acceptance.json` records `checkpoint=pre_review`, all prior page checks
  verified, `submitActivated=false`, and `privacyScan=pass`.
- Relevant files: `executioner/src/ats/workday/application/page-walk.ts`,
  `executioner/tests/integration/s2-application-walk/**`.
- Interfaces/decisions: orchestration policies remain in the central orchestrator.


## s2-f4-recovery-review-stop-evidence

### Observable outcome

The real journey survives bounded recoverable interruptions, reconciles browser
truth with journey state, reaches Review, proves Submit remained untouched, and
produces a sanitized same-revision acceptance packet.

### Scope

Recovery/resume policy, stale-state reconciliation, navigation safety, Review
and Submit detection, evidence capture/sanitization, and S2 acceptance runner.

### Non-goals

Unbounded retry, arbitrary direct browser recovery, corpus scale, and Submit.

### Acceptance

- Recovery resumes only after exact target and state reconciliation.
- Retry budgets are explicit and terminal states are idempotent.
- Review is verified independently; Submit has no callable action.
- Evidence is bounded, useful, and contains no raw secret/personal values.
- One same-revision run passes all S1/S2 tests and real acceptance.

### Verification

Tier 2: recovery fault matrix, Review/Submit guard tests, privacy scan, and the
approved real acceptance run.
Tier 3: owner rerun from `main` plus full Hunt CI.
Tier 4: owner visually validates Review and evidence summary.


## S2-F4-T1 — Reconcile and recover bounded real-browser interruptions
- Outcome: recoverable reload, stale handle, transient network, popup, and
  interrupted-process states reconcile against exact browser truth before resuming.
- Scope: recovery classifier, retry budgets, state rehydration, target/page
  reconciliation, terminal idempotence, and fault matrix.
- Out of scope: arbitrary direct browser repair and challenge bypass.
- Acceptance: recovery cannot adopt wrong target or skip verification; retries
  are bounded; nonrecoverable/ambiguous states stop with stable codes.
- Verify: `npm --prefix executioner test -- tests/journey/recovery`.
- Relevant files: `executioner/src/journey/recovery/**`,
  `executioner/tests/journey/recovery/**`.
- Interfaces/decisions: browser truth wins over stale projection; reconciliation is recorded.

## S2-F4-T2 — Prove Review and make Submit unreachable
- Outcome: Review Stopper independently confirms Review, records structural
  Submit presence, and terminates with no callable or hidden Submit path.
- Scope: real Review signatures, false-positive fixtures, command/capability
  audit, final state transition, and denial tests.
- Out of scope: final submission and approval workflow.
- Acceptance: Review requires page and completion evidence; lookalike pages fail;
  MCP, drivers, navigator, and model controller expose no Submit operation.
- Verify: `npm --prefix executioner test -- tests/interaction/review`;
  `npm --prefix executioner test -- tests/security/no-submit`.
- Relevant files: `executioner/src/interaction/review/**`,
  `executioner/tests/interaction/review/**`.
- Interfaces/decisions: Submit presence may be observed structurally but never targeted.

## S2-F4-T3 — Produce a bounded privacy-safe real evidence packet
- Outcome: acceptance evidence records revision/config IDs, structural milestones,
  verification summaries, errors, and Review proof without personal or secret content.
- Scope: evidence schema, admission/sanitization, byte/count limits, privacy scan,
  artifact manifest, retention/delete policy, and independent browser-truth summary.
- Out of scope: screenshots/raw DOM by default and long-term personal archives.
- Acceptance: packet is useful without raw values; forbidden-token corpus is
  rejected; missing evidence is stated; manifest hashes every admitted artifact.
  Unknown-candidate evidence records layer, accepted schema/revision IDs,
  bounded structural traits/counts, and review lineage only. It contains no
  URL, selector, target token, applicant/readback value, credential, raw DOM, or
  automatically approved variant ID.
- Verify: `npm --prefix executioner test -- tests/evidence/live`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/src/evidence/live/**`,
  `executioner/tests/evidence/live/**`.
- Interfaces/decisions: browser-truth summary is sealed before diagnostic comparison.

## S2-F4-T4 — Pass the same-revision S2 real acceptance gate
- Outcome: one command runs all S1/S2 tests and the approved real journey from job
  URL through verified Review, producing a sanitized acceptance manifest.
- Scope: acceptance CLI, preflight, immutable revision/config capture, cleanup,
  result reconciliation, runbook, and failure stop conditions.
- Out of scope: corpus concurrency and Submit.
- Acceptance: exact revision and inputs are recorded; Review passes; Submit
  untouched; all focused suites/quality/privacy pass; rerun instructions are complete.
- Verify: `npm --prefix executioner test -- tests/acceptance/s2`;
  `npm --prefix executioner test -- tests/security/privacy`;
  `npm --prefix executioner run quality`;
  `npm --prefix executioner run live:s2 -- --config <owner-inputs> --stop-after review --evidence-root <outside-repo-root>`;
  `python ci.py c3`. Tier 3 additionally runs `python ci.py all` from `main`.
- Relevant files: `executioner/scripts/run-s2-acceptance.ts`,
  `executioner/tests/acceptance/s2/**`, `executioner/README.md`.
- Interfaces/decisions: live invocation requires explicit owner approval and supplied secrets.
