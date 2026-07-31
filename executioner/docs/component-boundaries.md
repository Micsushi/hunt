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
- Retry: callers may retry start and reset after a timeout. Transitions are
  never retried automatically.
- Cancellation: start cancellation stops only F2-owned server or state work.
- Idempotency: start is keyed by fixture-run ID, reset is repeatable, and a
  transition ID applies at most once.

### F3 Browser Session Adapter

**BrowserSession**

- Consumers: F5 Page Understanding, F7 Field Drivers, F8
  Verification/Navigation, F9 Orchestrator.
- Requests: BrowserStartRequest, BrowserObservationRequest,
  BrowserMutationRequest, BrowserNavigationRequest, BrowserCloseRequest.
- Results: BrowserSessionResult, BrowserObservation, BrowserOperationReceipt,
  BrowserNavigationObservation.
- Error: BrowserSessionError.
- Side effect owner: F3 alone owns browser/page lifecycle, observation,
  mutation, navigation, and cleanup.
- Retry: F3 performs no policy retry. F9 may retry only contract-declared
  retryable operations.
- Cancellation: every bounded browser operation stops at its declared safe
  boundary.
- Idempotency: duplicate page ownership is rejected, close is repeatable, and a
  mutation operation ID applies at most once.

### F4 Intake, Profile, Bootstrap, and Journey State

**JourneyIntake**

- Consumer: F9 Orchestrator.
- Request: JourneyBootstrapRequest.
- Results: JourneyInputs, JourneyBootstrapResult.
- Error: JourneyInputError.
- Side effect owner: F4 validates immutable intake before JourneyStateStore may
  persist bootstrap state.
- Retry: an identical bootstrap request may be retried. Changed inputs require
  a new request identity.
- Cancellation: cancellation before persistence leaves no journey state.
- Idempotency: an identical request returns the same journey identity.

**ProfileQuery**

- Consumers: F6 Answer Resolver, F9 Orchestrator.
- Request: ProfileQueryRequest.
- Result: ProfileAnswerResult.
- Error: ProfileQueryError.
- Side effect owner: queries are read-only. F4 alone owns profile data.
- Retry: the same read-only query may be retried.
- Cancellation: cancellation changes no profile data.
- Idempotency: the same profile revision and query return the same result.

**JourneyStateStore**

- Consumer: F9 Orchestrator.
- Requests: JourneyStateLoadRequest, JourneyStateTransitionCommand.
- Results: JourneyStateLoadResult, JourneyStateTransitionResult.
- Error: JourneyStateError.
- Side effect owner: F4 alone validates and persists durable journey state. F9
  supplies legal transition commands.
- Retry: loads are retryable. A transition retry keeps its operation ID.
- Cancellation: cancellation before commit leaves state unchanged. An
  acknowledged commit remains committed.
- Idempotency: transition operation IDs and terminal states are idempotent.

### F5 Workday Page Understanding

**PageUnderstanding**

- Consumers: F6 Answer Resolver, F8 Verification/Navigation, F9 Orchestrator.
- Request: PageUnderstandingRequest.
- Results: PageUnderstandingResult, SemanticPageSnapshot.
- Error: PageUnderstandingError.
- Side effect owner: none. F5 classifies bounded F3 observations.
- Retry: the same immutable BrowserObservation may be classified again.
- Cancellation: cancellation stops classification without mutation.
- Idempotency: the same observation produces the same semantic result.

### F6 Question, Answer, and Option Resolution

**AnswerResolver**

- Consumers: F7 Field Drivers, F9 Orchestrator.
- Request: AnswerResolutionRequest.
- Results: AnswerResolutionResult, FieldIntent.
- Error: AnswerResolutionError.
- Side effect owner: none. F6 never mutates profiles, browser state, or
  reviewed catalogs.
- Retry: resolution may be retried against the same catalog and profile
  revisions.
- Cancellation: cancellation stops resolution without mutation.
- Idempotency: the same semantic field and authoritative inputs return the same
  result.

### F7 Field Interaction Drivers

**FieldDriver**

- Consumers: F8 Field Verifier, F9 Orchestrator.
- Request: DriverRequest.
- Result: MutationReceipt.
- Error: DriverError.
- Side effect owner: F7 owns one-driver dispatch and receipt creation. F3 alone
  performs the requested browser mutation.
- Retry: F7 never retries mutation. F9 may issue a new attempt only after
  verification and policy allow it.
- Cancellation: cancellation is forwarded to F3 and never claims verification.
- Idempotency: a driver operation ID dispatches at most once. Its receipt never
  claims verification.

### F8 Independent Verification, Completion, and Navigation

**FieldVerifier**

- Consumer: F9 Orchestrator.
- Request: VerificationRequest.
- Result: VerificationResult.
- Error: VerificationError.
- Side effect owner: none. F8 owns bounded readback comparison, F3 owns browser
  reads, and F8 never calls F7.
- Retry: F8 owns only bounded verification polling. F9 owns any mutation retry.
- Cancellation: cancellation stops polling without changing browser state.
- Idempotency: verification is repeatable for the same intent, receipt, and
  observed state.

**CompletionNavigation**

- Consumer: F9 Orchestrator.
- Requests: PageCompletionRequest, NavigationReconciliationRequest.
- Results: PageCompletionResult, NavigationDecision, NavigationResult.
- Error: NavigationError.
- Side effect owner: F8 owns completion and navigation decisions. F3 owns
  navigation and F9 owns the loop.
- Retry: F8 does not retry navigation. F9 reconciles an uncertain result before
  another attempt.
- Cancellation: cancellation stops decision or reconciliation work without
  authorizing navigation.
- Idempotency: completion is pure. Reconciliation returns one result per
  navigation operation ID.

### F9 Orchestrator and MCP Facade

**JourneyControl**

- Consumer: F9 MCP Facade.
- Requests: StartJourneyCommand, CancelJourneyCommand, JourneyStatusQuery,
  JourneyResultQuery.
- Results: JourneyOperationResult, JourneyStatus, TerminalResult.
- Error: OrchestratorError.
- Side effect owner: F9 alone owns journey/page loop scheduling, operation
  ownership, retry policy, and cancellation propagation. Providers retain their
  component side effects.
- Retry: F9 applies the only bounded retries and only to errors declared
  retryable by the providing port.
- Cancellation: F9 propagates cancellation to active bounded operations before
  terminal state.
- Idempotency: start and cancel use operation IDs. Status and terminal reads are
  repeatable. Terminal state is final.

**McpJourneyApi**

- Consumer: External MCP Client.
- Request: McpRequest.
- Result: McpResponse.
- Error: McpTransportError.
- Side effect owner: the F9 MCP facade validates and forwards commands to
  JourneyControl.
- Retry: the facade performs no retry. Duplicate transport requests retain
  their request ID.
- Cancellation: only the explicit cancel operation requests cancellation.
- Idempotency: status and result reads are repeatable. Mutating requests use
  operation IDs.

### F10 Observability and Factual Failure Reporting

**EventSink**

- Consumers: F2 Fixture Runtime, F3 Browser Adapter, F4 Journey State, F5 Page
  Understanding, F6 Answer Resolver, F7 Field Drivers, F8
  Verification/Navigation, F9 Orchestrator, F11 Safety/Evidence.
- Request: EventAppendRequest.
- Results: EventAppendResult, JourneyProgress.
- Error: ObservabilityError.
- Side effect owner: F10 alone admits and appends value-free events and projects
  monotonic progress.
- Retry: an append may be retried only with the same event ID.
- Cancellation: cancellation before append leaves no event. An acknowledged
  append remains recorded.
- Idempotency: event IDs deduplicate appends. Terminal events never duplicate
  terminal progress.

**ProgressReader**

- Consumer: F9 MCP Facade.
- Request: ProgressReadRequest.
- Result: JourneyProgress.
- Error: ObservabilityError.
- Side effect owner: none. Progress reads are side-effect free.
- Retry: reads may be retried.
- Cancellation: cancellation stops only the read.
- Idempotency: a read never changes progress.

**FailureReporter**

- Consumer: F9 Orchestrator.
- Request: FailureReportRequest.
- Results: FailureReport, NotificationRecord.
- Error: FailureReportingError.
- Side effect owner: F10 owns factual report projection and bounded value-free
  notification delivery.
- Retry: notification retry is bounded and reuses the failure report ID.
- Cancellation: cancellation may stop undelivered notification work but never
  rewrites the factual report.
- Idempotency: a failure report ID produces one terminal report and at most one
  delivered notification.

### F11 Privacy, Safety, and Sanitized Evidence

**PrivacyGuard**

- Consumers: F2 Fixture Runtime, F4 Intake/Profile, F9 MCP Facade, F10
  Observability.
- Request: PrivacyAdmissionRequest.
- Result: AdmissionDecision.
- Error: PrivacyDenial.
- Side effect owner: none. Denied content is never retained.
- Retry: the same bounded payload may be checked again.
- Cancellation: cancellation stops admission without retention.
- Idempotency: the same payload and policy revision return the same decision.

**SafetyGuard**

- Consumers: F3 Browser Adapter, F7 Field Drivers, F8
  Verification/Navigation, F9 Orchestrator.
- Request: SafetyAdmissionRequest.
- Result: AdmissionDecision.
- Error: SafetyDenial.
- Side effect owner: none. Denied capabilities never reach a side-effect owner.
- Retry: the same semantic request may be checked again.
- Cancellation: cancellation stops admission without authorization.
- Idempotency: the same request and policy revision return the same decision.

**EvidenceStore**

- Consumers: F9 Orchestrator, F10 Failure Reporter.
- Requests: EvidenceAdmissionRequest, EvidenceReadRequest.
- Results: EvidenceWriteResult, EvidenceManifest.
- Error: EvidenceError.
- Side effect owner: F11 alone admits and stores bounded sanitized evidence and
  replay manifests.
- Retry: writes may be retried only with the same evidence record ID.
- Cancellation: cancellation before commit retains nothing. Denied content is
  never written.
- Idempotency: evidence record IDs deduplicate writes. Reads never mutate
  retention.

**ModelController**

- Consumer: F9 Orchestrator.
- Request: ModelSuggestionRequest.
- Result: ModelSuggestionResult.
- Error: ModelAdmissionError.
- Side effect owner: F11 owns admitted local-model invocation. Returned
  suggestions cannot mutate or choose policy.
- Retry: F9 may request another suggestion only within its retry budget and
  with a new attempt ID.
- Cancellation: cancellation stops the bounded model request.
- Idempotency: a completed attempt ID returns its recorded semantic result
  without reinvocation.

## Frozen execution rules

- F9 owns the only journey/page loop and retry policy.
- F3 owns all browser mutations and navigation. F7 dispatches field behavior.
  F8 verifies and returns completion/navigation decisions.
- F4 owns durable state validation and persistence. F9 supplies legal
  transition commands.
- F10 owns event, progress, factual failure, and notification persistence.
- F11 owns admission, evidence persistence, and bounded model invocation.
- Contract corrections go through the F1 owner. Component branches do not copy
  or edit shared contracts.
