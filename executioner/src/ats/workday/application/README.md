# S2 application page-walk seams

`runApplicationPageWalk` composes S2-F3-T1 through T3 through
`createApplicationLaneHandlers`. Each lane still owns its implementation:

- T1 binds `handlers.resume`. Its primitive is `file_upload`.
- T2 binds `handlers.profile`. Its primitive is `profile_control`.
- T3 binds `handlers.questionnaire`. Its primitive is `question_control`.

`createImmutableApplicationLaneSources` captures one admitted resume intent,
one cloned/frozen profile plan, and one cloned/frozen questionnaire request.
The branded resume artifact is preserved by identity; no path is reopened.
Every handler receives the opaque journey ID, current browser page ID, and
one-based local attempt. It must return the same page kind and page ID plus its
exact independently verified checkpoint. A
failure supplies a stable error code plus enumerated classifier, primitive, and
unknown layer. No field value, option text, filename, path, digest, mailbox
content, selector, or credential can enter this seam.

The composition owner supplies three other adapters:

- `observer` independently reads browser truth after every independently
  verified lane result and legal transition. Handler success alone is never
  verification evidence. `PlaywrightWorkdayApplicationPage` is the real
  structural observer/navigation adapter; `createPlaywrightWorkdayResumePage`
  and `PlaywrightWorkdayProfilePage` bind the real Playwright page to T1/T2.
  T3 continues to receive independently owned `FieldDriver` and
  `FieldVerifier` ports.
- `navigation.next` exposes only a bounded set of legal semantic destinations.
  The independent observer binds the actual destination after every transition;
  no tenant-global page order is assumed. Profile-first, Resume-first, skipped
  optional pages, and repeated Questionnaire pages retain their exact observed
  sequence. There is no Submit operation. T4 calls navigation only after every
  required field verifies and the C3-owned duplicate-row count is zero.
- `progress.record` receives counts and exact checkpoint enums only. T4 records
  `resume_verified`, `profile_verified`, or `questionnaire_verified` only after
  lane and browser truth agree, and records `pre_review` only after the observed
  final transition.

`pageRetryLimit` applies to the affected page only. Retryable handler and
browser-truth failures, incomplete required fields, and owned duplicate rows
spend that shared local budget. The central orchestrator still owns outer
journey recovery, event IDs, terminalization, and persistence policy.
Questionnaire reconciliation may continue beyond that ordinary retry budget,
up to 16 total passes, only while independent browser truth shows monotonic
progress in required or verified field counts. This bounded fixed-point pass
allows chained conditional reveals while stopping immediately when a page
stalls.

Question classification first uses exact reviewed labels, then reviewed
keyword groups that ignore presentation wording such as “what is” or “select
your.” Keyword matches must resolve to one canonical question; overlapping
groups remain `question_ambiguous`. `questionAnswerGuide` publishes each
canonical question's accepted answer type, known choices, and default policy.
Tenant-specific choices are still discovered from the visible control. Generated
defaults and first-visible choices are admitted only in
`synthetic_test_non_submittable` fixture runs. Live employer flows require
`live_owner_fact` for every demographic, disability, veteran, consent, legal,
employment, authorization, and other truth-dependent declaration; an exact
privacy-decline choice remains editable guidance but is not a live fact until the
owner selects it. Synthetic answers cannot persist as applicant facts, produce
live page acceptance or Review expectation/completion, activate Submit, or cross
the production application-source binding. Missing or mismatched live answers
fail closed before mutation and are recorded as needing owner input.

`stopAfter` supports each verified lane and `pre_review` without advancing
beyond the requested browser truth. `createApplicationLaneAcceptanceCollector`
retains only the T1-T3 safe acceptance projections. The cleanup-gated
`runStage2ApplicationWalk` writes them through
`writeApplicationWalkEvidence`; an acceptance cannot be written until browser
cleanup passes.

The successful result is sealed as `application-walk-acceptance.json`: the requested
checkpoint, all prior page-check counts reconciled, `submitActivated=false`,
and `privacyScan=pass`. Failure packets contain only stable enums, counts, retry
position, and the exact owning classifier/primitive. Extra adapter properties
are dropped, and malformed enum values become `failure_context_invalid` with
fixed safe metadata.

## Production binding seam

`createStage2ApplicationWalkProductionBinding(...)` owns preflight, outside-repo
owner-source resolution, resume disposal, and privacy-scanned evidence writing.
The owner input keeps only opaque `resumeRef` and `profileRef` values. The
default file adapter reads `application-resume.pdf` and
`application-profile.json` from the admitted runtime root. The exact source
manifest binds application scope, revision, approval, journey, target, both
opaque refs, approval time, resume identity/digest/size/type, applicant profile,
profile plan, and configured narrative revision. Both files must be canonical,
single-link, bounded, stable for the full descriptor read, outside the
repository, and no newer than the accepted approval. The resolver captures the
resume once and returns only its immutable upload intent, an exact validated
profile plan, profile identity/query, and the configured narrative provider.

The injected `Stage2ApplicationWalkRuntimeBinding` has the remaining live-only
authority. It supplies the owned Playwright application page, fresh
questionnaire and active-listbox browser truth, independent driver and verifier
ports, lane acceptance collector, progress port, and cleanup. It receives no
evidence writer or evidence root. Owner storage cannot supply browser truth,
question answers, or catalog mutations. Production composition writes the
final evidence packet with the resolved sensitive-value scan.

The executable CLI recognizes all four F3 checkpoints but still fails closed
with `owner_config_invalid` until a concrete live application runtime is
injected. It never falls through to the account-access runner. Deterministic
composition tests inject a fake runtime; they are not live browser proof.
