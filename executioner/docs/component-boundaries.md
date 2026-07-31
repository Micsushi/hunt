# C3 v3 Stage 1 component boundaries

This document is the human view of the declarative matrix in
`src/contracts/ownership.ts`. F1 owns the matrix and all contracts. F2 through
F11 own only the source listed below. A component may import F1 contracts, but
never a peer implementation. Only composition may connect real providers.

## Source and data ownership

| Feature | Component | Source ownership | Cross-component data ownership |
| --- | --- | --- | --- |
| F2 | Controlled Fixture Runtime | `fixtures/workday/s1/**`<br>`src/testing/fixture-server.ts`<br>`src/testing/fixture-state.ts` | FixtureManifest, FixturePageId, FixtureSemanticHash, FixtureRunState |
| F3 | Browser Session Adapter | `src/browser/**` | BrowserSessionId, BrowserPageId, BrowserTargetToken, BrowserObservation, BrowserOperationReceipt |
| F4 | Intake, Profile, Bootstrap, and Journey State | `src/intake/**`<br>`src/profile/**`<br>`src/journey/**` | JobIntake, ResumeSelection, JourneyInputs, JourneyId, ApplicantProfile, ProfileAnswerProvenance, DurableJourneyState |
| F5 | Workday Page Understanding | `src/ats/**`<br>`src/form/discovery/**`<br>`src/form/ui/**`<br>`src/form/semantic-snapshot.ts` | PageIdentity, FieldObservation, SemanticPageSnapshot, UiBehaviorId |
| F6 | Question, Answer, and Option Resolution | `src/form/questions/**`<br>`src/form/answers/**`<br>`src/form/options/**` | QuestionId, OptionId, AnswerProvenance, FieldIntent |
| F7 | Field Interaction Drivers | `src/interaction/drivers/**` | DriverBehaviorId, MutationReceipt |
| F8 | Independent Verification, Completion, and Navigation | `src/interaction/verification/**`<br>`src/interaction/completion/**`<br>`src/interaction/navigation/**` | VerificationResult, PageCompletionResult, NavigationDecision, NavigationResult |
| F9 | Orchestrator and MCP Facade | `src/control/orchestrator/**`<br>`src/control/mcp/**` | OperationId, JourneyStatus, TerminalResult, McpRequest, McpResponse |
| F10 | Observability and Factual Failure Reporting | `src/observability/**` | EventEnvelope, JourneyProgress, FailureContext, FailureReport, NotificationRecord |
| F11 | Privacy, Safety, and Sanitized Evidence | `src/safety/**`<br>`src/evidence/**`<br>`src/control/model/**` | AdmissionDecision, RedactionCode, EvidenceManifest, EvidenceRecord, ModelSuggestion |

These assignments are disjoint. Data named in the final column has one owner.
Credentials, raw page values, and Submit capability are not shared data.

## Port boundaries

### F2 Controlled Fixture Runtime

**FixtureRuntime**

- Consumer: F12/F13 composition.
- Requests: FixtureStartRequest, FixtureTransitionRequest,
  FixtureResetRequest, FixtureFaultRequest.
- Results: FixtureStartResult, FixtureTransitionResult, FixtureResetResult.
- Error: FixtureRuntimeError.
- Side effect owner: F2 owns fixture-server lifecycle, fixture transition
  state, reset, and fault activation.
- Retry: Callers may retry start and reset after a timeout; transitions are
  never retried automatically.
- Cancellation: Start accepts cancellation and stops only F2-owned server or
  state work.
- Idempotency: Start is keyed by fixture-run ID, reset is repeatable, and a
  transition ID applies at most once.

### F3 Browser Session Adapter

**BrowserSession**

- Consumers: F7 Field Drivers, F8 Verification/Navigation, F9 Orchestrator.
- Requests: BrowserStartRequest, BrowserObservationRequest,
  BrowserMutationRequest, BrowserNavigationRequest, BrowserCloseRequest.
- Results: BrowserSessionResult, BrowserObservation, BrowserOperationReceipt,
  BrowserNavigationObservation.
- Error: BrowserSessionError.
- Side effect owner: F3 alone owns browser/page lifecycle, observation,
  mutation, navigation, and cleanup.
- Retry: F3 performs no policy retry; F9 may retry only contract-declared
  retryable operations.
- Cancellation: Every bounded browser operation accepts cancellation and stops
  at its declared safe boundary.
- Idempotency: Duplicate page ownership is rejected, close is repeatable, and
  a mutation operation ID applies at most once.

### F4 Intake, Profile, Bootstrap, and Journey State

**JourneyIntake**

- Consumer: F9 Orchestrator.
- Request: JourneyBootstrapRequest.
- Results: JourneyInputs, JourneyBootstrapResult.
- Error: JourneyInputError.
- Side effect owner: F4 validates immutable intake before the JourneyStateStore
  may persist bootstrap state.
- Retry: A caller may retry an identical bootstrap request; changed inputs
  require a new request identity.
- Cancellation: Cancellation before persistence leaves no journey state.
- Idempotency: An identical bootstrap request returns the same journey
  identity.

**ProfileQuery**

- Consumer: F6 Answer Resolver.
- Request: ProfileQueryRequest.
- Result: ProfileAnswerResult.
- Error: ProfileQueryError.
- Side effect owner: Profile queries are read-only; F4 alone owns profile data.
- Retry: Read-only queries may be retried with the same request.
- Cancellation: Cancellation may stop a query without changing profile data.
- Idempotency: The same profile revision and query return the same result.

**JourneyStateStore**

- Consumer: F9 Orchestrator.
- Requests: JourneyStateLoadRequest, JourneyStateTransitionCommand.
- Results: JourneyStateLoadResult, JourneyStateTransitionResult.
- Error: JourneyStateError.
- Side effect owner: F4 alone validates and persists durable journey state; F9
  supplies legal transition commands.
- Retry: Loads are retryable; transition retries require the same operation ID.
- Cancellation: Cancellation before commit leaves state unchanged; an
  acknowledged commit remains committed.
- Idempotency: Transition operation IDs and terminal states are idempotent.

### F5 Workday Page Understanding

**PageUnderstanding**

- Consumer: F9 Orchestrator.
- Request: PageUnderstandingRequest.
- Results: PageUnderstandingResult, SemanticPageSnapshot.
- Error: PageUnderstandingError.
- Side effect owner: F5 is read-only and owns only semantic classification of
  bounded F3 observations.
- Retry: The same immutable browser observation may be classified again.
- Cancellation: Cancellation stops classification without mutation.
- Idempotency: The same observation produces the same semantic result.

### F6 Question, Answer, and Option Resolution

**AnswerResolver**

- Consumer: F9 Orchestrator.
- Request: AnswerResolutionRequest.
- Results: AnswerResolutionResult, FieldIntent.
- Error: AnswerResolutionError.
- Side effect owner: F6 is read-only and never mutates profiles, browser state,
  or reviewed catalogs.
- Retry: Resolution may be retried against the same catalog and profile
  revisions.
- Cancellation: Cancellation stops resolution without mutation.
- Idempotency: The same semantic field and authoritative inputs return the same
  result.

### F7 Field Interaction Drivers

**FieldDriver**

- Consumer: F9 Orchestrator.
- Request: DriverRequest.
- Result: MutationReceipt.
- Error: DriverError.
- Side effect owner: F7 owns one-driver dispatch and receipt creation; F3 alone
  performs the requested browser mutation.
- Retry: F7 never retries mutation; F9 may issue a new attempt only after
  verification and policy allow it.
- Cancellation: Cancellation is forwarded to F3 and returns without claiming
  verification.
- Idempotency: A driver operation ID dispatches at most once and its receipt
  never claims verification.

### F8 Independent Verification, Completion, and Navigation

**FieldVerifier**

- Consumer: F9 Orchestrator.
- Request: VerificationRequest.
- Result: VerificationResult.
- Error: VerificationError.
- Side effect owner: F8 owns bounded readback comparison; F3 owns browser reads
  and F8 never calls F7.
- Retry: F8 owns only bounded verification polling; F9 owns any mutation retry.
- Cancellation: Cancellation stops polling without changing browser state.
- Idempotency: Verification is repeatable for the same intent, receipt, and
  observed state.

**CompletionNavigation**

- Consumer: F9 Orchestrator.
- Requests: PageCompletionRequest, NavigationReconciliationRequest.
- Results: PageCompletionResult, NavigationDecision, NavigationResult.
- Error: NavigationError.
- Side effect owner: F8 owns completion and navigation decisions; F3 owns
  navigation and F9 owns the loop.
- Retry: F8 does not retry navigation; F9 reconciles an uncertain result before
  another attempt.
- Cancellation: Cancellation stops decision or reconciliation work without
  authorizing navigation.
- Idempotency: Completion is pure and reconciliation returns one result per
  navigation operation ID.

### F9 Orchestrator and MCP Facade

**JourneyControl**

- Consumer: F9 MCP Facade.
- Requests: StartJourneyCommand, CancelJourneyCommand, JourneyStatusQuery,
  JourneyResultQuery.
- Results: JourneyOperationResult, JourneyStatus, TerminalResult.
- Error: OrchestratorError.
- Side effect owner: F9 alone owns journey/page loop scheduling, operation
  ownership, retry policy, and cancellation propagation.
- Retry: F9 applies the only bounded retries and only to errors declared
  retryable by the providing port.
- Cancellation: F9 owns cancellation and propagates it to active bounded
  operations before terminal state.
- Idempotency: Start and cancel are keyed by operation ID; status and terminal
  reads are repeatable; terminal state is final.

**McpJourneyApi**

- Consumer: External MCP Client.
- Request: McpRequest.
- Result: McpResponse.
- Error: McpTransportError.
- Side effect owner: The F9 MCP facade only validates and forwards commands to
  JourneyControl.
- Retry: The facade performs no retry; duplicate transport requests retain
  their request ID.
- Cancellation: Only the explicit cancel operation requests journey
  cancellation.
- Idempotency: Status and result reads are repeatable; mutating requests use
  operation IDs.

### F10 Observability and Factual Failure Reporting

**EventSink**

- Consumers: F2 Fixture Runtime, F3 Browser Adapter, F4 Journey State,
  F5 Page Understanding, F6 Answer Resolver, F7 Field Drivers, F8
  Verification/Navigation, F9 Orchestrator, F11 Safety/Evidence.
- Request: EventAppendRequest.
- Results: EventAppendResult, JourneyProgress.
- Error: ObservabilityError.
- Side effect owner: F10 alone admits and appends value-free events and projects
  monotonic progress.
- Retry: An append may be retried only with the same event ID.
- Cancellation: Cancellation before append leaves no event; an acknowledged
  append remains recorded.
- Idempotency: Event IDs deduplicate appends and terminal events never duplicate
  terminal progress.

**ProgressReader**

- Consumer: F9 MCP Facade.
- Request: ProgressReadRequest.
- Result: JourneyProgress.
- Error: ObservabilityError.
- Side effect owner: Progress reads are side-effect free.
- Retry: Reads may be retried.
- Cancellation: Cancellation stops only the read.
- Idempotency: A read never changes progress.

**FailureReporter**

- Consumer: F9 Orchestrator.
- Request: FailureReportRequest.
- Results: FailureReport, NotificationRecord.
- Error: FailureReportingError.
- Side effect owner: F10 owns factual report projection and bounded value-free
  notification delivery.
- Retry: Notification retry is bounded and reuses the failure report ID.
- Cancellation: Cancellation may stop undelivered notification work but never
  rewrites the factual report.
- Idempotency: A failure report ID produces one terminal report and at most one
  delivered notification.

### F11 Privacy, Safety, and Sanitized Evidence

**PrivacyGuard**

- Consumers: F2 Fixture Runtime, F4 Intake/Profile, F9 MCP Facade, F10
  Observability.
- Request: PrivacyAdmissionRequest.
- Result: AdmissionDecision.
- Error: PrivacyDenial.
- Side effect owner: F11 privacy admission is pure and denied content is never
  retained.
- Retry: The same bounded payload may be checked again.
- Cancellation: Cancellation stops admission without retention.
- Idempotency: The same payload and policy revision return the same decision.

**SafetyGuard**

- Consumers: F3 Browser Adapter, F7 Field Drivers, F8
  Verification/Navigation, F9 Orchestrator.
- Request: SafetyAdmissionRequest.
- Result: AdmissionDecision.
- Error: SafetyDenial.
- Side effect owner: F11 safety admission is pure; denied capabilities never
  reach a side-effect owner.
- Retry: The same semantic request may be checked again.
- Cancellation: Cancellation stops admission without authorization.
- Idempotency: The same request and policy revision return the same decision.

**EvidenceStore**

- Consumers: F9 Orchestrator, F10 Failure Reporter.
- Requests: EvidenceAdmissionRequest, EvidenceReadRequest.
- Results: EvidenceWriteResult, EvidenceManifest.
- Error: EvidenceError.
- Side effect owner: F11 alone admits and stores bounded sanitized evidence and
  replay manifests.
- Retry: Writes may be retried only with the same evidence record ID.
- Cancellation: Cancellation before commit retains nothing; denied content is
  never written.
- Idempotency: Evidence record IDs deduplicate writes and reads never mutate
  retention.

**ModelController**

- Consumer: F9 Orchestrator.
- Request: ModelSuggestionRequest.
- Result: ModelSuggestionResult.
- Error: ModelAdmissionError.
- Side effect owner: F11 owns admitted local-model invocation; returned
  suggestions cannot mutate or choose policy.
- Retry: F9 may request another suggestion only within its retry budget and
  with a new attempt ID.
- Cancellation: Cancellation stops the bounded model request.
- Idempotency: A completed attempt ID returns its recorded semantic result
  without reinvocation.

## Frozen execution rules

- F9 owns the only journey/page loop and retry policy.
- F9 passes F3-owned BrowserObservation to PageUnderstanding, F5-owned
  FieldObservation to AnswerResolver, F6-owned FieldIntent to FieldDriver, and
  F7-owned MutationReceipt to FieldVerifier. These are data contracts, not
  direct peer-port dependencies.
- F3 owns all browser mutations and navigation. F7 dispatches field behavior.
  F8 verifies and returns completion/navigation decisions.
- F4 owns durable state validation and persistence. F9 supplies legal
  transition commands.
- F10 owns event, progress, factual failure, and notification persistence.
- F11 owns admission, evidence persistence, and bounded model invocation.
- PrivacyGuard and SafetyGuard return `AdmissionDecision` only for admission;
  denials use their declared stable port-error channel.
- Every in-process port method requires an `AbortSignal`. Cancellation returns
  the shared non-retryable `operation_cancelled` result error.
- Contract corrections go through the F1 owner. Component branches do not copy
  or edit shared contracts.
