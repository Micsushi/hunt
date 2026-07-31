export type ComponentFeature =
  | "F2"
  | "F3"
  | "F4"
  | "F5"
  | "F6"
  | "F7"
  | "F8"
  | "F9"
  | "F10"
  | "F11";

export interface PortBoundary {
  readonly name: string;
  readonly consumers: readonly string[];
  readonly requests: readonly string[];
  readonly results: readonly string[];
  readonly errors: readonly string[];
  readonly sideEffect: string;
  readonly retry: string;
  readonly cancellation: string;
  readonly idempotency: string;
}

export interface ComponentBoundary {
  readonly feature: ComponentFeature;
  readonly component: string;
  readonly sourceOwnership: readonly string[];
  readonly dataOwnership: readonly string[];
  readonly ports: readonly PortBoundary[];
}

export const componentBoundaries = [
  {
    feature: "F2",
    component: "Controlled Fixture Runtime",
    sourceOwnership: [
      "fixtures/workday/s1/**",
      "src/testing/fixture-server.ts",
      "src/testing/fixture-state.ts",
    ],
    dataOwnership: [
      "FixtureManifest",
      "FixturePageId",
      "FixtureSemanticHash",
      "FixtureRunState",
    ],
    ports: [
      {
        name: "FixtureRuntime",
        consumers: ["F12/F13 composition"],
        requests: [
          "FixtureStartRequest",
          "FixtureTransitionRequest",
          "FixtureResetRequest",
          "FixtureFaultRequest",
        ],
        results: [
          "FixtureStartResult",
          "FixtureTransitionResult",
          "FixtureResetResult",
        ],
        errors: ["FixtureRuntimeError"],
        sideEffect:
          "F2 owns fixture-server lifecycle, fixture transition state, reset, and fault activation.",
        retry:
          "Callers may retry start and reset after a timeout; transitions are never retried automatically.",
        cancellation:
          "Start accepts cancellation and stops only F2-owned server or state work.",
        idempotency:
          "Start is keyed by fixture-run ID, reset is repeatable, and a transition ID applies at most once.",
      },
    ],
  },
  {
    feature: "F3",
    component: "Browser Session Adapter",
    sourceOwnership: ["src/browser/**"],
    dataOwnership: [
      "BrowserSessionId",
      "BrowserPageId",
      "BrowserTargetToken",
      "BrowserObservation",
      "BrowserOperationReceipt",
    ],
    ports: [
      {
        name: "BrowserSession",
        consumers: [
          "F7 Field Drivers",
          "F8 Verification/Navigation",
          "F9 Orchestrator",
        ],
        requests: [
          "BrowserStartRequest",
          "BrowserObservationRequest",
          "BrowserMutationRequest",
          "BrowserNavigationRequest",
          "BrowserCloseRequest",
        ],
        results: [
          "BrowserSessionResult",
          "BrowserObservation",
          "BrowserOperationReceipt",
          "BrowserNavigationObservation",
        ],
        errors: ["BrowserSessionError"],
        sideEffect:
          "F3 alone owns browser/page lifecycle, observation, mutation, navigation, and cleanup.",
        retry:
          "F3 performs no policy retry; F9 may retry only contract-declared retryable operations.",
        cancellation:
          "Every bounded browser operation accepts cancellation and stops at its declared safe boundary.",
        idempotency:
          "Duplicate page ownership is rejected, close is repeatable, and a mutation operation ID applies at most once.",
      },
    ],
  },
  {
    feature: "F4",
    component: "Intake, Profile, Bootstrap, and Journey State",
    sourceOwnership: ["src/intake/**", "src/profile/**", "src/journey/**"],
    dataOwnership: [
      "JobIntake",
      "ResumeSelection",
      "JourneyInputs",
      "JourneyId",
      "ApplicantProfile",
      "ProfileAnswerProvenance",
      "DurableJourneyState",
    ],
    ports: [
      {
        name: "JourneyIntake",
        consumers: ["F9 Orchestrator"],
        requests: ["JourneyBootstrapRequest"],
        results: ["JourneyInputs", "JourneyBootstrapResult"],
        errors: ["JourneyInputError"],
        sideEffect:
          "F4 validates immutable intake before the JourneyStateStore may persist bootstrap state.",
        retry:
          "A caller may retry an identical bootstrap request; changed inputs require a new request identity.",
        cancellation:
          "Cancellation before persistence leaves no journey state.",
        idempotency:
          "An identical bootstrap request returns the same journey identity.",
      },
      {
        name: "ProfileQuery",
        consumers: ["F6 Answer Resolver"],
        requests: ["ProfileQueryRequest"],
        results: ["ProfileAnswerResult"],
        errors: ["ProfileQueryError"],
        sideEffect: "Profile queries are read-only; F4 alone owns profile data.",
        retry: "Read-only queries may be retried with the same request.",
        cancellation: "Cancellation may stop a query without changing profile data.",
        idempotency: "The same profile revision and query return the same result.",
      },
      {
        name: "JourneyStateStore",
        consumers: ["F9 Orchestrator"],
        requests: [
          "JourneyStateLoadRequest",
          "JourneyStateTransitionCommand",
        ],
        results: [
          "JourneyStateLoadResult",
          "JourneyStateTransitionResult",
        ],
        errors: ["JourneyStateError"],
        sideEffect:
          "F4 alone validates and persists durable journey state; F9 supplies legal transition commands.",
        retry:
          "Loads are retryable; transition retries require the same operation ID.",
        cancellation:
          "Cancellation before commit leaves state unchanged; an acknowledged commit remains committed.",
        idempotency:
          "Transition operation IDs and terminal states are idempotent.",
      },
    ],
  },
  {
    feature: "F5",
    component: "Workday Page Understanding",
    sourceOwnership: [
      "src/ats/**",
      "src/form/discovery/**",
      "src/form/ui/**",
      "src/form/semantic-snapshot.ts",
    ],
    dataOwnership: [
      "PageIdentity",
      "FieldObservation",
      "SemanticPageSnapshot",
      "UiBehaviorId",
    ],
    ports: [
      {
        name: "PageUnderstanding",
        consumers: ["F9 Orchestrator"],
        requests: ["PageUnderstandingRequest"],
        results: ["PageUnderstandingResult", "SemanticPageSnapshot"],
        errors: ["PageUnderstandingError"],
        sideEffect:
          "F5 is read-only and owns only semantic classification of bounded F3 observations.",
        retry: "The same immutable browser observation may be classified again.",
        cancellation: "Cancellation stops classification without mutation.",
        idempotency: "The same observation produces the same semantic result.",
      },
    ],
  },
  {
    feature: "F6",
    component: "Question, Answer, and Option Resolution",
    sourceOwnership: [
      "src/form/questions/**",
      "src/form/answers/**",
      "src/form/options/**",
    ],
    dataOwnership: [
      "QuestionId",
      "OptionId",
      "AnswerProvenance",
      "FieldIntent",
    ],
    ports: [
      {
        name: "AnswerResolver",
        consumers: ["F9 Orchestrator"],
        requests: ["AnswerResolutionRequest"],
        results: ["AnswerResolutionResult", "FieldIntent"],
        errors: ["AnswerResolutionError"],
        sideEffect:
          "F6 is read-only and never mutates profiles, browser state, or reviewed catalogs.",
        retry: "Resolution may be retried against the same catalog and profile revisions.",
        cancellation: "Cancellation stops resolution without mutation.",
        idempotency: "The same semantic field and authoritative inputs return the same result.",
      },
    ],
  },
  {
    feature: "F7",
    component: "Field Interaction Drivers",
    sourceOwnership: ["src/interaction/drivers/**"],
    dataOwnership: ["DriverBehaviorId", "MutationReceipt"],
    ports: [
      {
        name: "FieldDriver",
        consumers: ["F9 Orchestrator"],
        requests: ["DriverRequest"],
        results: ["MutationReceipt"],
        errors: ["DriverError"],
        sideEffect:
          "F7 owns one-driver dispatch and receipt creation; F3 alone performs the requested browser mutation.",
        retry:
          "F7 never retries mutation; F9 may issue a new attempt only after verification and policy allow it.",
        cancellation:
          "Cancellation is forwarded to F3 and returns without claiming verification.",
        idempotency:
          "A driver operation ID dispatches at most once and its receipt never claims verification.",
      },
    ],
  },
  {
    feature: "F8",
    component: "Independent Verification, Completion, and Navigation",
    sourceOwnership: [
      "src/interaction/verification/**",
      "src/interaction/completion/**",
      "src/interaction/navigation/**",
    ],
    dataOwnership: [
      "VerificationResult",
      "PageCompletionResult",
      "NavigationDecision",
      "NavigationResult",
    ],
    ports: [
      {
        name: "FieldVerifier",
        consumers: ["F9 Orchestrator"],
        requests: ["VerificationRequest"],
        results: ["VerificationResult"],
        errors: ["VerificationError"],
        sideEffect:
          "F8 owns bounded readback comparison; F3 owns browser reads and F8 never calls F7.",
        retry:
          "F8 owns only bounded verification polling; F9 owns any mutation retry.",
        cancellation: "Cancellation stops polling without changing browser state.",
        idempotency:
          "Verification is repeatable for the same intent, receipt, and observed state.",
      },
      {
        name: "CompletionNavigation",
        consumers: ["F9 Orchestrator"],
        requests: [
          "PageCompletionRequest",
          "NavigationReconciliationRequest",
        ],
        results: [
          "PageCompletionResult",
          "NavigationDecision",
          "NavigationResult",
        ],
        errors: ["NavigationError"],
        sideEffect:
          "F8 owns completion and navigation decisions; F3 owns navigation and F9 owns the loop.",
        retry:
          "F8 does not retry navigation; F9 reconciles an uncertain result before another attempt.",
        cancellation:
          "Cancellation stops decision or reconciliation work without authorizing navigation.",
        idempotency:
          "Completion is pure and reconciliation returns one result per navigation operation ID.",
      },
    ],
  },
  {
    feature: "F9",
    component: "Orchestrator and MCP Facade",
    sourceOwnership: ["src/control/orchestrator/**", "src/control/mcp/**"],
    dataOwnership: [
      "OperationId",
      "JourneyStatus",
      "TerminalResult",
      "McpRequest",
      "McpResponse",
    ],
    ports: [
      {
        name: "JourneyControl",
        consumers: ["F9 MCP Facade"],
        requests: [
          "StartJourneyCommand",
          "CancelJourneyCommand",
          "JourneyStatusQuery",
          "JourneyResultQuery",
        ],
        results: [
          "JourneyOperationResult",
          "JourneyStatus",
          "TerminalResult",
        ],
        errors: ["OrchestratorError"],
        sideEffect:
          "F9 alone owns journey/page loop scheduling, operation ownership, retry policy, and cancellation propagation.",
        retry:
          "F9 applies the only bounded retries and only to errors declared retryable by the providing port.",
        cancellation:
          "F9 owns cancellation and propagates it to active bounded operations before terminal state.",
        idempotency:
          "Start and cancel are keyed by operation ID; status and terminal reads are repeatable; terminal state is final.",
      },
      {
        name: "McpJourneyApi",
        consumers: ["External MCP Client"],
        requests: ["McpRequest"],
        results: ["McpResponse"],
        errors: ["McpTransportError"],
        sideEffect:
          "The F9 MCP facade only validates and forwards commands to JourneyControl.",
        retry:
          "The facade performs no retry; duplicate transport requests retain their request ID.",
        cancellation:
          "Only the explicit cancel operation requests journey cancellation.",
        idempotency:
          "Status and result reads are repeatable; mutating requests use operation IDs.",
      },
    ],
  },
  {
    feature: "F10",
    component: "Observability and Factual Failure Reporting",
    sourceOwnership: ["src/observability/**"],
    dataOwnership: [
      "EventEnvelope",
      "JourneyProgress",
      "FailureContext",
      "FailureReport",
      "NotificationRecord",
    ],
    ports: [
      {
        name: "EventSink",
        consumers: [
          "F2 Fixture Runtime",
          "F3 Browser Adapter",
          "F4 Journey State",
          "F5 Page Understanding",
          "F6 Answer Resolver",
          "F7 Field Drivers",
          "F8 Verification/Navigation",
          "F9 Orchestrator",
          "F11 Safety/Evidence",
        ],
        requests: ["EventAppendRequest"],
        results: ["EventAppendResult", "JourneyProgress"],
        errors: ["ObservabilityError"],
        sideEffect:
          "F10 alone admits and appends value-free events and projects monotonic progress.",
        retry: "An append may be retried only with the same event ID.",
        cancellation:
          "Cancellation before append leaves no event; an acknowledged append remains recorded.",
        idempotency:
          "Event IDs deduplicate appends and terminal events never duplicate terminal progress.",
      },
      {
        name: "ProgressReader",
        consumers: ["F9 MCP Facade"],
        requests: ["ProgressReadRequest"],
        results: ["JourneyProgress"],
        errors: ["ObservabilityError"],
        sideEffect: "Progress reads are side-effect free.",
        retry: "Reads may be retried.",
        cancellation: "Cancellation stops only the read.",
        idempotency: "A read never changes progress.",
      },
      {
        name: "FailureReporter",
        consumers: ["F9 Orchestrator"],
        requests: ["FailureReportRequest"],
        results: ["FailureReport", "NotificationRecord"],
        errors: ["FailureReportingError"],
        sideEffect:
          "F10 owns factual report projection and bounded value-free notification delivery.",
        retry:
          "Notification retry is bounded and reuses the failure report ID.",
        cancellation:
          "Cancellation may stop undelivered notification work but never rewrites the factual report.",
        idempotency:
          "A failure report ID produces one terminal report and at most one delivered notification.",
      },
    ],
  },
  {
    feature: "F11",
    component: "Privacy, Safety, and Sanitized Evidence",
    sourceOwnership: [
      "src/safety/**",
      "src/evidence/**",
      "src/control/model/**",
    ],
    dataOwnership: [
      "AdmissionDecision",
      "RedactionCode",
      "EvidenceManifest",
      "EvidenceRecord",
      "ModelSuggestion",
    ],
    ports: [
      {
        name: "PrivacyGuard",
        consumers: [
          "F2 Fixture Runtime",
          "F4 Intake/Profile",
          "F9 MCP Facade",
          "F10 Observability",
        ],
        requests: ["PrivacyAdmissionRequest"],
        results: ["AdmissionDecision"],
        errors: ["PrivacyDenial"],
        sideEffect:
          "F11 privacy admission is pure and denied content is never retained.",
        retry: "The same bounded payload may be checked again.",
        cancellation: "Cancellation stops admission without retention.",
        idempotency: "The same payload and policy revision return the same decision.",
      },
      {
        name: "SafetyGuard",
        consumers: [
          "F3 Browser Adapter",
          "F7 Field Drivers",
          "F8 Verification/Navigation",
          "F9 Orchestrator",
        ],
        requests: ["SafetyAdmissionRequest"],
        results: ["AdmissionDecision"],
        errors: ["SafetyDenial"],
        sideEffect:
          "F11 safety admission is pure; denied capabilities never reach a side-effect owner.",
        retry: "The same semantic request may be checked again.",
        cancellation: "Cancellation stops admission without authorization.",
        idempotency: "The same request and policy revision return the same decision.",
      },
      {
        name: "EvidenceStore",
        consumers: ["F9 Orchestrator", "F10 Failure Reporter"],
        requests: ["EvidenceAdmissionRequest", "EvidenceReadRequest"],
        results: ["EvidenceWriteResult", "EvidenceManifest"],
        errors: ["EvidenceError"],
        sideEffect:
          "F11 alone admits and stores bounded sanitized evidence and replay manifests.",
        retry: "Writes may be retried only with the same evidence record ID.",
        cancellation:
          "Cancellation before commit retains nothing; denied content is never written.",
        idempotency:
          "Evidence record IDs deduplicate writes and reads never mutate retention.",
      },
      {
        name: "ModelController",
        consumers: ["F9 Orchestrator"],
        requests: ["ModelSuggestionRequest"],
        results: ["ModelSuggestionResult"],
        errors: ["ModelAdmissionError"],
        sideEffect:
          "F11 owns admitted local-model invocation; returned suggestions cannot mutate or choose policy.",
        retry:
          "F9 may request another suggestion only within its retry budget and with a new attempt ID.",
        cancellation: "Cancellation stops the bounded model request.",
        idempotency:
          "A completed attempt ID returns its recorded semantic result without reinvocation.",
      },
    ],
  },
] as const satisfies readonly ComponentBoundary[];
