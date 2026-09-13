# S3 Workday Corpus Closure — requirement reference

These are preserved portable scope and acceptance requirements from the original stage plans. They do not activate work, record acceptance, grant browser/account access, or authorize integration or release. Existing contracts and tests remain executable authority; deviations need explicit reconciliation. Final Submit stays forbidden. Task identifiers are traceability labels, not an active task board.


## s3-f1-corpus-fixture-intake

### Observable outcome

A frozen, privacy-safe 40-job Workday manifest maps every available job and
observed variant to sanitized fixtures, ownership, and deterministic baseline
results.

### Scope

Corpus manifest, availability/replacement rules, fixture capture/sanitization,
variant taxonomy, job-to-primitive mapping, baseline runner, and report schema.

### Non-goals

Fixing variants, changing production behavior, and non-Workday jobs.

### Acceptance

- Exactly 40 corpus slots have stable identity and explicit availability state.
- Replacement rules preserve tenant/page/variant intent.
- No fixture contains applicant values, credentials, tokens, or unsafe page text.
- Every observed primitive has a stable variant ID and affected-job mapping.
- Baseline results are reproducible and do not misclassify site state as C3 failure.

### Verification

Tier 2: manifest schema, privacy scan, fixture replay, and deterministic baseline.
Tier 3: owner approves frozen manifest and source records.
Tier 4: owner spot-checks replacements and variant labels.


## S3-F1-T1 — Freeze the 40-job corpus manifest and replacement rules
- Outcome: exactly 40 stable corpus slots record source, tenant, variant intent,
  availability, approved replacement, account mode, and privacy-safe ownership metadata.
- Scope: manifest schema/tooling, source reconciliation, unavailable/dead-posting
  policy, replacement equivalence, immutable IDs, and owner approval record.
- Out of scope: running/fixing jobs and storing credentials.
- Acceptance: no duplicate slot/job; every replacement states why it preserves
  intent; unavailable is distinct from product failure; manifest is hashable/frozen.
- Verify: `npm --prefix executioner run corpus:validate`.
- Relevant files: `executioner/corpus/workday-40/manifest.json`,
  `executioner/src/corpus/manifest/**`, `executioner/tests/corpus/manifest/**`.
- Interfaces/decisions: corpus URLs/account references live in approved runtime
  inputs if sensitive; committed manifest contains safe stable references.

## S3-F1-T2 — Capture and sanitize corpus fixtures
- Outcome: every observed page/control/question variant has a minimal sanitized
  fixture whose provenance points to corpus slots and capture revision.
- Scope: bounded capture tool, structural minimization, sanitization, fixture
  manifest, secret/personal token scan, and replay validation.
- Out of scope: production fixes and raw full-page archives.
- Acceptance: forbidden data cannot be admitted; fixtures replay offline; each
  fixture states proving slots/variant; identical input normalizes deterministically.
- Verify: `npm --prefix executioner run corpus:fixtures:validate`;
  `npm --prefix executioner test -- tests/security/privacy`.
- Relevant files: `executioner/fixtures/workday/corpus/**`,
  `executioner/src/corpus/capture/**`, `executioner/tests/corpus/fixtures/**`.
- Interfaces/decisions: capture is read-only and only on explicitly approved pages.

## S3-F1-T3 — Build the variant taxonomy and impact map
- Outcome: stable page/UI/question/answer/option variant IDs map fixtures,
  primitives, production modules, and affected corpus slots.
- Scope: taxonomy schema, mapping generator, ownership/status fields,
  dependency/impact queries, and consistency tests.
- Out of scope: deciding fixes and automatically merging similar variants.
- Acceptance: every fixture has at least one variant; every variant has one owner
  category and affected-job set; mappings contain no cycles or orphan IDs.
- Verify: `npm --prefix executioner run corpus:map:validate`.
- Relevant files: `executioner/corpus/workday-40/variants.json`,
  `executioner/src/corpus/impact-map/**`,
  `executioner/tests/corpus/impact-map/**`.
- Interfaces/decisions: variant IDs describe reusable primitives, never employer names.

## S3-F1-T4 — Record the deterministic corpus baseline
- Outcome: a bounded runner records each slot's current outcome and owning
  variant/failure without changing production behavior.
- Scope: sequential runner, preflight/cleanup, outcome schema, site-state
  classification, resumable manifest, immutable reports, and reproducibility check.
- Out of scope: fixes, broad parallelism, and Submit.
- Acceptance: every available slot has one outcome; dead/access/missing-data
  states are distinct; rerun does not overwrite prior report; affected mappings attach.
- Verify: `npm --prefix executioner run corpus:baseline`; validate report twice
  against unchanged manifest/revision.
- Relevant files: `executioner/src/corpus/runner/**`,
  `executioner/tests/corpus/runner/**`, runtime acceptance root outside repo.
- Interfaces/decisions: run sequentially first; concurrency requires a later proven need.

## S3-F1-T5 — Freeze corpus-driven contract impact
- Outcome: actual sanitized corpus evidence determines whether runtime contracts,
  fixture schemas, variant manifests, or accepted terminal codes must change
  before any closure lane begins.
- Scope: compare taxonomy/baseline to accepted S1/S2 contracts; enumerate page,
  control, question, option, error, event, evidence, and recovery impacts;
  classify each as no change, fixture/manifest delta, implementation gap, or
  owning-stage contract reopen; freeze allowed terminal codes; mark every F2/F3
  candidate task `activated@<impactSHA>` or `not-activated@<impactSHA>`; update
  their exact dependency sets before closure.
- Out of scope: implementing variants, silently changing core ports, and
  accepting unsupported controls/questions as policy stops.
- Acceptance: every activated F2/F3 task maps to a proving fixture and corpus
  slot; candidate tasks without evidence are retired or remain provisional; any
  core change reopens S1-F1 or S2-F0 and reruns affected earlier-stage
  conformance/acceptance before S3 continues; valid result may be no contract
  delta.
- Verify: `npm --prefix executioner run corpus:impact:validate`;
  `npm --prefix executioner test -- tests/corpus/contract-impact`.
- Relevant files: `executioner/corpus/workday-40/contract-impact.json`,
  `executioner/tests/corpus/contract-impact/**`, vault
  `features/s3-f2-page-ui-behavior-closure/tasks.md` and
  `features/s3-f3-question-answer-option-closure/tasks.md`.
- Interfaces/decisions: unsupported page/control/question/option is an
  implementation gap unless an explicitly frozen external/policy stop applies.


## s3-f2-page-ui-behavior-closure

### Observable outcome

Every corpus Workday page type and UI behavior is either supported by a proving
fixture and verified driver or stops with the correct stable unsupported reason.

### Scope

Page-handler variants, UI-type variants, behavior drivers, independent
verification, fixture-first remediation, and affected-job regression selection.

### Non-goals

Question semantics, catalog mutation, employer-only branches, and other ATSs.

### Acceptance

- Each behavior change begins with a failing sanitized fixture.
- Page handlers contain no employer-specific branch without fixture proof.
- Drivers and verifiers remain separate across all variants.
- Every changed primitive reruns all mapped fixtures/jobs.
- Unknown UI behavior stops safely with structural diagnostics.

### Verification

Tier 2: page/UI fixture matrix and mapped affected-job reruns.
Tier 3: included in frozen corpus acceptance.
Tier 4: owner samples each page/control family in browser.


## S3-F2-T1: Freeze page and UI variant ownership
- Outcome: every frozen page or UI failure maps to one stable variant ID, one
  proving fixture, one task below, one owner role, and affected corpus slots.
- Scope: dedupe, ownership, fixture paths, impact map, and task mapping.
- Out of scope: production behavior changes.
- Acceptance: `page-ui-variants.json` has no unowned row; any new primitive
  requires a new task entry before this gate can close.
- Verify: `npm --prefix executioner run corpus:page-ui:plan`.
- Relevant files: `executioner/corpus/workday-40/page-ui-variants.json`,
  `executioner/tests/corpus/page-ui-plan/**`.
- Interfaces/decisions: JSON work items cannot substitute for task entries.

## S3-F2-T2: Close auth action and transition variants
- Outcome: `WD-PAGE-AUTH-ACTION-V1` selects sign-in or create-account actions
  and stabilizes sign-in, verification, and application transitions.
- Scope: account-form commit controls, visible credential rejection, lock state, false
  CAPTCHA classification, and transition readiness.
- Out of scope: mailbox retrieval and credential storage.
- Acceptance: fixture `wd-page-auth-action-v1` fails before the fix and all
  mapped auth corpus slots reach the correct next state or typed stop.
- Interfaces/decisions: HTML `type=submit` for account access does not authorize
  or expose final-application Submit, which remains structurally absent.
- Verify: `npm --prefix executioner run corpus:variant -- WD-PAGE-AUTH-ACTION-V1`.
- Relevant files: `executioner/tests/fixtures/workday/variants/wd-page-auth-action-v1/**`,
  `executioner/src/ats/workday/pages/auth/**`.
- Interfaces/decisions: no tenant or employer branch.

## S3-F2-T3: Close unavailable and maintenance page variants
- Outcome: `WD-PAGE-EXTERNAL-STATE-V1` distinguishes closed posting,
  maintenance, access control, and loading from product failure.
- Scope: stable page signatures, bounded evidence, retryability, and posting
  identity.
- Out of scope: corpus replacement policy.
- Acceptance: each external state has a proving fixture and mapped jobs return
  the exact typed state without raw page text.
- Verify: `npm --prefix executioner run corpus:variant -- WD-PAGE-EXTERNAL-STATE-V1`.
- Relevant files: `executioner/tests/fixtures/workday/variants/wd-page-external-state-v1/**`,
  `executioner/src/ats/workday/pages/external-state/**`.
- Interfaces/decisions: unknown state remains unknown, never inferred.

## S3-F2-T4: Close readiness, Review, and navigation variants
- Outcome: `WD-PAGE-READINESS-V1` handles stable readiness, disabled Next,
  visible validation, Review normalization, and final Submit detection.
- Scope: completion checker, navigator approval, validation clearing, and
  Review stopper.
- Out of scope: field mutation implementations.
- Acceptance: no fixture advances with an unverified required field and final
  Submit remains unreachable.
- Verify: `npm --prefix executioner run corpus:variant -- WD-PAGE-READINESS-V1`.
- Relevant files: `executioner/tests/fixtures/workday/variants/wd-page-readiness-v1/**`,
  `executioner/src/ats/workday/pages/navigation/**`.
- Interfaces/decisions: only Page Completion Checker approves navigation.

## S3-F2-T5: Close Source search-select and listbox variants
- Outcome: `WD-UI-SOURCE-SELECT-V1` commits Source through search, leaf, and
  active-listbox configurations.
- Scope: popup ownership, leaf selection, backing state, and independent
  readback.
- Out of scope: Source question meaning.
- Acceptance: the fixture precedes the fix; ambiguous options are not clicked;
  every mapped Source slot independently verifies.
- Verify: `npm --prefix executioner run corpus:variant -- WD-UI-SOURCE-SELECT-V1`.
- Relevant files: `executioner/tests/fixtures/workday/variants/wd-ui-source-select-v1/**`,
  `executioner/src/interaction/drivers/workday/search-select/**`.
- Interfaces/decisions: option semantics remain in S3-F3.

## S3-F2-T6: Close dropdown and hierarchical-select variants
- Outcome: `WD-UI-SELECT-V1` commits standard, hierarchical, degree,
  disclosure, and criminal-history select controls.
- Scope: option ownership, expansion, selection, backing value, and readback.
- Out of scope: deciding which answer is correct.
- Acceptance: wrong and ambiguous commits fail; all fixture configurations and
  mapped jobs verify the selected visible option.
- Verify: `npm --prefix executioner run corpus:variant -- WD-UI-SELECT-V1`.
- Relevant files: `executioner/tests/fixtures/workday/variants/wd-ui-select-v1/**`,
  `executioner/src/interaction/drivers/workday/select/**`.
- Interfaces/decisions: the verifier does not call driver success state.

## S3-F2-T7: Close text, phone, and composite-date variants
- Outcome: `WD-UI-SCALAR-COMPOSITE-V1` commits text, phone country/number, and
  composite date controls.
- Scope: wrapper ownership, normalization, blur/commit behavior, and readback.
- Out of scope: applicant-answer selection.
- Acceptance: name, phone, section date, and Self Identify date fixtures pass
  without destructive rewrites.
- Verify: `npm --prefix executioner run corpus:variant -- WD-UI-SCALAR-COMPOSITE-V1`.
- Relevant files: `executioner/tests/fixtures/workday/variants/wd-ui-scalar-composite-v1/**`,
  `executioner/src/interaction/drivers/workday/scalar/**`.
- Interfaces/decisions: semantic equality uses normalized committed state.

## S3-F2-T8: Close Skills multiselect variants
- Outcome: `WD-UI-SKILLS-MULTISELECT-V1` adds missing skills, preserves owned
  pills, and proves exact committed identities.
- Scope: search timing, popup ownership, pill readback, duplicate prevention,
  and partial prefill.
- Out of scope: selecting desired skills from the profile.
- Acceptance: no duplicate pills; unowned extras remain; every mapped Skills
  slot passes exact independent readback.
- Verify: `npm --prefix executioner run corpus:variant -- WD-UI-SKILLS-MULTISELECT-V1`.
- Relevant files: `executioner/tests/fixtures/workday/variants/wd-ui-skills-multiselect-v1/**`,
  `executioner/src/interaction/drivers/workday/multiselect/**`.
- Interfaces/decisions: additions are identity-based, not display-text guesses.

## S3-F2-T9: Close checkbox and radio variants
- Outcome: `WD-UI-CHOICE-V1` commits required checkbox, disclosure, and
  mutually exclusive radio groups.
- Scope: label ownership, group state, disabled state, and independent readback.
- Out of scope: consent or disclosure answer policy.
- Acceptance: only the owned group changes; required state verifies; disabled
  or ambiguous controls stop.
- Verify: `npm --prefix executioner run corpus:variant -- WD-UI-CHOICE-V1`.
- Relevant files: `executioner/tests/fixtures/workday/variants/wd-ui-choice-v1/**`,
  `executioner/src/interaction/drivers/workday/choice/**`.
- Interfaces/decisions: label proximity alone is insufficient ownership proof.

## S3-F2-T10: Close Work Experience and Education repeatables
- Outcome: `WD-UI-REPEATABLE-V1` reconciles blank, partial, matching, and
  C3-owned incorrect Work Experience and Education rows.
- Scope: stable row keys, add, update, delete-empty, duplicate prevention, and
  row readback.
- Out of scope: deleting user-owned rows or choosing profile records.
- Acceptance: C3 creates no duplicate rows; unowned rows remain; owned rows
  reach normalized desired state.
- Verify: `npm --prefix executioner run corpus:variant -- WD-UI-REPEATABLE-V1`.
- Relevant files: `executioner/tests/fixtures/workday/variants/wd-ui-repeatable-v1/**`,
  `executioner/src/interaction/drivers/workday/repeatable/**`.
- Interfaces/decisions: destructive actions require C3 ownership proof.

## S3-F2-T11: Close resume upload variants
- Outcome: `WD-UI-RESUME-UPLOAD-V1` uploads, preserves, or replaces a resume
  according to immutable artifact identity and policy.
- Scope: empty, matching, wrong-owned, and ambiguous existing-file states.
- Out of scope: parsing resume content.
- Acceptance: matching file is preserved; replacement requires explicit
  ownership and policy; content never enters evidence.
- Verify: `npm --prefix executioner run corpus:variant -- WD-UI-RESUME-UPLOAD-V1`.
- Relevant files: `executioner/tests/fixtures/workday/variants/wd-ui-resume-upload-v1/**`,
  `executioner/src/interaction/drivers/workday/file/**`.
- Interfaces/decisions: filename alone is not sufficient identity.

## S3-F2-T12: Close cross-control prefill reconciliation
- Outcome: `WD-UI-PREFILL-RECONCILE-V1` preserves matching values, corrects
  C3-owned mismatches, and stops on sensitive or uncertain conflicts.
- Scope: scalar, select, choice, multiselect, repeatable, and file decision
  matrix.
- Out of scope: behavior already owned by T5 through T11.
- Acceptance: every primitive has empty, matching, owned-wrong, and
  unowned-conflict coverage; no progress-first fallback exists.
- Verify: `npm --prefix executioner run corpus:variant -- WD-UI-PREFILL-RECONCILE-V1`.
- Relevant files: `executioner/tests/fixtures/workday/variants/wd-ui-prefill-reconcile-v1/**`,
  `executioner/src/journey/reconciliation/**`.
- Interfaces/decisions: conflict policy runs before mutation.

## S3-F2-T13: Pass the frozen page and UI matrix
- Outcome: all frozen page and UI tasks pass together and mapped corpus slots
  reach the next owning boundary.
- Scope: matrix runner, impact-map validation, S1/S2 regressions, result
  reconciliation, and unresolved-variant gate.
- Out of scope: semantic failures and full-corpus freeze.
- Acceptance: zero unowned page or UI failure; every changed primitive and
  affected slot ran on one revision.
- Verify: `npm --prefix executioner run corpus:page-ui:accept`.
- Relevant files: `executioner/tests/acceptance/s3-page-ui/**`, runtime reports
  outside repo.
- Interfaces/decisions: unsupported policy and implementation defect remain
  distinct.


## s3-f3-question-answer-option-closure

### Observable outcome

Every corpus question resolves to an authoritative canonical answer and verified
site option, or stops with the correct missing/unsupported policy result.

### Scope

V2 catalog data migration, canonical IDs, approved aliases, normalization,
question classification, answer policy, option mapping, narrative template, and
suggestion review workflow.

### Non-goals

Automatic fuzzy/model catalog mutation, invented applicant facts, and bespoke
employer answer code.

### Acceptance

- Migrated data has provenance and no v2 runtime dependency.
- Exact/alias/normalized matches are deterministic and explainable.
- Fuzzy/model suggestions require explicit catalog review.
- Protected categories never receive placeholder answers.
- Option mapping independently verifies the selected visible value.

### Verification

Tier 2: catalog provenance/schema tests, question/answer/option golden matrix,
policy negatives, and mapped affected-job reruns.
Tier 3: included in frozen corpus acceptance.
Tier 4: owner reviews ambiguous suggestions and protected-category stops.


## S3-F3-T1: Migrate reviewed v2 catalog knowledge
- Outcome: reviewed non-personal v2 question taxonomy, aliases, option mappings,
  and approved narrative templates become provenance-tagged v3 catalog data.
- Scope: deterministic admission from both preserved sources, normalization,
  dedupe, privacy scan, review queue, and schema validation.
- Out of scope: applicant values, profiles, resumes, URLs, employer branches,
  credentials/tokens, copying algorithms, and approving ambiguous entries.
- Acceptance: every entry names source revision or snapshot hash; privacy scan
  passes before any catalog write; conflicts remain unapproved; dependency scan
  finds no v2 runtime import.
- Verify: `npm --prefix executioner run catalog:migrate -- --sources
  <baseline-worktree>,<latest-snapshot>`; `npm --prefix executioner run
  catalog:validate`;
  `npm --prefix executioner test -- tests/security/privacy`;
  `npm --prefix executioner test -- tests/architecture/no-v2-imports`.
- Relevant files: `executioner/catalogs/workday/**`,
  `executioner/src/catalog/migration/**`, `executioner/tests/catalog/**`.
- Interfaces/decisions: backup sources are tool inputs only.

## S3-F3-T2: Close identity and contact question variants
- Outcome: `WD-QA-IDENTITY-CONTACT-V1` maps name, address, email, and phone
  prompts to authoritative profile facts.
- Scope: canonical IDs, aliases, normalization, provenance, and missing facts.
- Out of scope: UI mutation.
- Acceptance: each corpus prompt has one deterministic meaning and answer or
  `profile_answer_missing`.
- Verify: `npm --prefix executioner run corpus:semantic -- WD-QA-IDENTITY-CONTACT-V1`.
- Relevant files: `executioner/tests/fixtures/workday/semantics/wd-qa-identity-contact-v1.json`,
  `executioner/src/form/questions/identity-contact/**`.
- Interfaces/decisions: no inferred personal facts.

## S3-F3-T3: Close work and education question variants
- Outcome: `WD-QA-WORK-EDUCATION-V1` maps experience, education, degree, skills,
  website, and social-profile prompts to authoritative records.
- Scope: record selection, aliases, date policy, provenance, and missing data.
- Out of scope: repeatable-row interaction.
- Acceptance: every answer references one profile record; ambiguous record
  selection stops.
- Verify: `npm --prefix executioner run corpus:semantic -- WD-QA-WORK-EDUCATION-V1`.
- Relevant files: `executioner/tests/fixtures/workday/semantics/wd-qa-work-education-v1.json`,
  `executioner/src/form/answers/work-education/**`.
- Interfaces/decisions: catalog aliases cannot alter profile data.

## S3-F3-T4: Close Source and referral question variants
- Outcome: `WD-QA-SOURCE-REFERRAL-V1` distinguishes discovery source,
  employee referral, referral identity, and follow-up prompts.
- Scope: canonical meanings, conditional follow-ups, authoritative source, and
  missing referral data.
- Out of scope: listbox behavior.
- Acceptance: Source never supplies a referral identity; unavailable referral
  facts stop rather than use holding text.
- Verify: `npm --prefix executioner run corpus:semantic -- WD-QA-SOURCE-REFERRAL-V1`.
- Relevant files: `executioner/tests/fixtures/workday/semantics/wd-qa-source-referral-v1.json`,
  `executioner/src/form/questions/source-referral/**`.
- Interfaces/decisions: follow-ups inherit the parent canonical ID.

## S3-F3-T5: Close authorization, sponsorship, and prior-worker variants
- Outcome: `WD-QA-WORK-AUTH-V1` resolves work authorization, sponsorship, and
  prior employment only from approved applicant facts.
- Scope: canonical meanings, legal-policy guard, yes/no options, provenance,
  and missing facts.
- Out of scope: inventing eligibility or interpreting law.
- Acceptance: no default yes or no; missing facts stop; every answer retains
  fact provenance.
- Verify: `npm --prefix executioner run corpus:semantic -- WD-QA-WORK-AUTH-V1`.
- Relevant files: `executioner/tests/fixtures/workday/semantics/wd-qa-work-auth-v1.json`,
  `executioner/src/form/answers/work-authorization/**`.
- Interfaces/decisions: policy cannot be weakened by the model.

## S3-F3-T6: Close salary, legal, consent, and disclosure variants
- Outcome: `WD-QA-MATERIAL-DISCLOSURE-V1` handles salary, consent, criminal
  history, and disclosure prompts without placeholders.
- Scope: prompt separation, profile provenance, explicit-consent policy,
  refusal states, and exact options.
- Out of scope: legal advice and automatic consent.
- Acceptance: every material answer is explicit and sourced; missing or
  unapproved consent stops.
- Verify: `npm --prefix executioner run corpus:semantic -- WD-QA-MATERIAL-DISCLOSURE-V1`.
- Relevant files: `executioner/tests/fixtures/workday/semantics/wd-qa-material-disclosure-v1.json`,
  `executioner/src/form/answers/material-disclosure/**`.
- Interfaces/decisions: silence is never consent.

## S3-F3-T7: Close EEO and Self Identify variants
- Outcome: `WD-QA-EEO-SELF-ID-V1` resolves voluntary disability, veteran,
  demographic, and Self Identify date prompts under explicit profile policy.
- Scope: canonical meanings, decline options, exact dates, provenance, and
  missing-data stops.
- Out of scope: inferring protected attributes.
- Acceptance: only approved facts or approved decline choices are returned;
  dates remain separate from status choices.
- Verify: `npm --prefix executioner run corpus:semantic -- WD-QA-EEO-SELF-ID-V1`.
- Relevant files: `executioner/tests/fixtures/workday/semantics/wd-qa-eeo-self-id-v1.json`,
  `executioner/src/form/answers/eeo/**`.
- Interfaces/decisions: voluntary status does not permit invention.

## S3-F3-T8: Close eligible narrative variants
- Outcome: `WD-QA-NARRATIVE-V1` uses the one approved S1-S3 template only for
  eligible paragraph prompts.
- Scope: eligibility, template version, provenance, length, and disallowed
  personal or legal claims.
- Out of scope: model-authored narratives.
- Acceptance: ineligible prompts never receive the template; output is stable
  and versioned.
- Verify: `npm --prefix executioner run corpus:semantic -- WD-QA-NARRATIVE-V1`.
- Relevant files: `executioner/tests/fixtures/workday/semantics/wd-qa-narrative-v1.json`,
  `executioner/src/form/narrative/**`.
- Interfaces/decisions: one configurable sentence through S3.

## S3-F3-T9: Close exact and approved-alias option mapping
- Outcome: `WD-OPTION-EXACT-ALIAS-V1` maps canonical answers to one visible
  option through exact, normalized, or approved-alias matches.
- Scope: normalization, approved aliases, explanation, and no-match.
- Out of scope: fuzzy automatic selection and UI interaction.
- Acceptance: match precedence is deterministic; conflicting aliases fail
  validation; no-match never clicks.
- Verify: `npm --prefix executioner run corpus:semantic -- WD-OPTION-EXACT-ALIAS-V1`.
- Relevant files: `executioner/tests/fixtures/workday/semantics/wd-option-exact-alias-v1.json`,
  `executioner/src/form/options/exact-alias/**`.
- Interfaces/decisions: aliases are reviewed catalog data.

## S3-F3-T10: Close hierarchy, multiselect, and ambiguity mapping
- Outcome: `WD-OPTION-COMPLEX-V1` resolves hierarchical paths and multiselect
  identities while keeping fuzzy or model rankings suggestion-only.
- Scope: parent and leaf identity, sets, duplicate labels, ambiguity, and
  suggestion reports.
- Out of scope: automatic catalog mutation.
- Acceptance: ambiguous or parent-only matches do not click; selected sets are
  exact and explainable.
- Verify: `npm --prefix executioner run corpus:semantic -- WD-OPTION-COMPLEX-V1`.
- Relevant files: `executioner/tests/fixtures/workday/semantics/wd-option-complex-v1.json`,
  `executioner/src/form/options/complex/**`.
- Interfaces/decisions: website option IDs remain site-specific.

## S3-F3-T11: Close unknown and missing-answer policy
- Outcome: `WD-QA-MISSING-UNKNOWN-V1` returns stable missing, unsupported, or
  ambiguous results for every unresolved corpus prompt.
- Scope: negative matrix, stop codes, retryability, and operator explanation.
- Out of scope: fallback text or progress-driven answers.
- Acceptance: no unresolved prompt reaches mutation; protected and ordinary
  missing facts remain distinct and accurate.
- Verify: `npm --prefix executioner run corpus:semantic -- WD-QA-MISSING-UNKNOWN-V1`.
- Relevant files: `executioner/tests/fixtures/workday/semantics/wd-qa-missing-unknown-v1.json`,
  `executioner/src/form/answers/policy/**`.
- Interfaces/decisions: unknown means stop, not best guess.

## S3-F3-T12: Pass the frozen semantic matrix
- Outcome: all frozen semantic tasks pass together and mapped corpus slots
  progress without wrong answers, invented facts, or option ambiguity.
- Scope: matrix runner, policy negatives, impact-map validation, S1/S2
  regressions, and unresolved-semantic gate.
- Out of scope: page/UI failures and full-corpus freeze.
- Acceptance: zero unowned semantic failure; every variant and affected slot
  ran on one revision; all protected-category negatives pass.
- Verify: `npm --prefix executioner run corpus:semantics:accept`.
- Relevant files: `executioner/tests/acceptance/s3-semantics/**`, runtime reports
  outside repo.
- Interfaces/decisions: missing-data outcomes count only when the profile lacks
  the fact.


## s3-f4-frozen-corpus-acceptance

### Observable outcome

One immutable revision and manifest run the full fixture suite and 40-job corpus,
producing reproducible accepted outcomes, privacy-safe evidence, and a releasable
C3 v3 package without submitting applications.

### Scope

Freeze controls, full runner, outcome reconciliation, privacy/security/recovery
audit, quality/package commands, release documentation, and owner-test backlog.

### Non-goals

Submit, non-Workday expansion, C4, and unattended production deployment.

### Acceptance

- Revision, manifest, configuration, and fixture set are immutable during run.
- All jobs have accepted Review or policy-valid terminal outcomes.
- Reports agree with independent browser truth.
- Full Hunt CI, C3 quality, fixture matrix, corpus run, and package verification pass.
- Release artifacts exclude secrets, evidence, profiles, and test accounts.

### Verification

Tier 2: frozen acceptance command and full quality/security/privacy gates.
Tier 3: owner promotion from `main` and reproducible package proof.
Tier 4: owner samples every variant family and approves release readiness.


## S3-F4-T1 — Freeze revision, manifests, fixtures, and acceptance configuration
- Outcome: one immutable acceptance bundle pins commit/tree, package lock,
  40-job manifest hash, variant map, fixtures, approved runtime config, and account references.
- Scope: freeze command, dirty-tree refusal, hash manifest, config validation,
  run ID, change lock, and thaw/restart rules.
- Out of scope: executing jobs and storing secret values.
- Acceptance: any source/manifest/fixture/config drift stops the run; bundle is
  reproducible and privacy-safe; restart uses the same frozen identities.
- Verify: `npm --prefix executioner run corpus:freeze`;
  `npm --prefix executioner test -- tests/corpus/freeze`.
- Relevant files: `executioner/src/corpus/freeze/**`,
  `executioner/tests/corpus/freeze/**`, runtime frozen bundle outside repo.
- Interfaces/decisions: fixes require a new freeze/run; never patch during a frozen run.

## S3-F4-T2 — Run and reconcile the frozen fixture and 40-job acceptance
- Outcome: the frozen runner executes all fixtures then every available corpus
  slot, records Review/policy-valid outcomes, and compares terminal reports with browser truth.
- Scope: sequential acceptance runner, resume/retry rules, sealed browser-truth
  summary, diagnostic comparison, outcome ledger, and deterministic final report.
- Out of scope: code changes during run, Submit, and non-Workday jobs.
- Acceptance: every slot has one accepted outcome; report/browser truth agree;
  failures map to owned primitive/policy; no frozen input changes.
- Verify: `npm --prefix executioner run corpus:accept -- --frozen <bundle>`.
- Relevant files: `executioner/src/corpus/acceptance/**`,
  `executioner/tests/corpus/acceptance/**`, runtime evidence outside repo.
- Interfaces/decisions: browser-truth summary is sealed before C3 diagnostics are read.

## S3-F4-T3 — Pass privacy, safety, recovery, and regression audits
- Outcome: independent audit commands prove no secret/personal leakage, Submit
  exposure, false verification, unbounded retry, stale recovery, or earlier-stage regression.
- Scope: artifact scan, capability graph audit, event/evidence schema scan,
  retry/recovery matrix, module-size report, full S1-S3 tests, and issue gate.
- Out of scope: subjective release promotion.
- Acceptance: zero P0/P1; every P2 has an explicit accepted disposition and
  regression-impact record; all prior suites pass; every near-500-line module
  has reviewed disposition; exceptions are explicit blockers, not waivers.
- Verify: `npm --prefix executioner run audit`;
  `npm --prefix executioner test -- tests/security tests/corpus/recovery`;
  `npm --prefix executioner run quality`; `python ci.py all`.
- Relevant files: `executioner/scripts/audit-*.ts`,
  `executioner/tests/security/**`, audit report outside repo.
- Interfaces/decisions: any privacy/Submit/false-verification finding invalidates the run.

## S3-F4-T4 — Produce the releasable package and owner-test handoff
- Outcome: reproducible C3 v3 package, public runbook, compatibility/status docs,
  acceptance summary, and explicit Tier 4 owner-test backlog are ready for promotion.
- Scope: build/package command, artifact allowlist/SBOM/checksum, install/start
  instructions, stage result summary, known limits, rollback to backup reference,
  and owner-test checklist.
- Out of scope: deployment, final Submit, other ATSs, and C4.
- Acceptance: package excludes profiles/secrets/evidence/test accounts; clean
  install exposes only approved MCP tools; docs match commands and known limits;
  Tier 4 checks are separate and unchecked.
- Verify: `npm --prefix executioner ci`;
  `npm --prefix executioner pack --dry-run`;
  `npm --prefix executioner run package:verify`; `python ci.py all`.
- Relevant files: `executioner/package.json`, `executioner/README.md`,
  `executioner/scripts/package.ts`, release output outside repo.
- Interfaces/decisions: Tier 3 publication requires explicit owner promotion from `main`.
