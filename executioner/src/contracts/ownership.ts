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
          "FixtureResetRequest",
          "FixtureFaultRequest",
        ],
        results: ["FixtureStartResult", "FixtureResetResult"],
        errors: ["FixtureRuntimeError"],
        sideEffect:
          "F2 owns fixture-server lifecycle, reset, and fault activation.",
        retry: "Callers may retry start and reset after a timeout.",
        cancellation:
          "Start accepts cancellation and stops only F2-owned server or state work.",
        idempotency:
          "Start is keyed by fixture-run ID and reset is repeatable.",
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
          "F3 performs no policy retry; browser_timeout is legal only when F3 proves no browser side effect began; once an effect may have begun, F3 returns browser_effect_uncertain and invalidates the session.",
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
      "FactualTerminalOutcome",
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
        idempotency: "`requestId` is the sole caller idempotency key.",
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
          "F10 alone admits and appends value-free events and projects monotonic progress; F5 page-understanding, F6 answer-resolution, and F8 verification terminal facts project blocked without entering failure reporting.",
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
    ],
    dataOwnership: [
      "AdmissionDecision",
      "RedactionCode",
      "EvidenceManifest",
      "EvidenceRecord",
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
    ],
  },
] as const satisfies readonly ComponentBoundary[];

// Product integration is separate from the frozen F2-F11 component matrix.
// These exact assembly edges do not grant other product modules peer access.
export const productBoundary = {
  sourceOwners: {
    authentication: [
      "extension/workday-account.js",
      "src/product/account-journal.ts",
      "src/product/account-state.ts",
      "src/product/account-storage.ts",
      "src/product/workday-sign-in.ts",
    ],
    field_recognition: ["extension/question-context.js"],
    answer_matching: [
      "src/product/matching-backlog.ts",
      "src/product/page-matching.ts",
      "src/product/profile-field.ts",
      "src/product/sources.ts",
    ],
    browser_interaction: [
      "extension/generic-fill.js",
      "extension/page-viewport.js",
      "extension/shared-choice-widget.js",
      "src/product/extension-bridge.ts",
    ],
    uploads: [
      "extension/jobvite-resume.js",
      "src/product/client-resume.ts",
      "src/product/greenhouse-resume.ts",
      "src/product/workable-resume.ts",
    ],
    workflow: [
      "extension/background.js",
      "extension/page-actions.js",
      "extension/popup.js",
      "extension/website-handoff.js",
      "src/product/engine.ts",
      "src/product/generic-application.ts",
      "src/product/handoff.ts",
      "src/product/hosted-application.ts",
      "src/product/mcp.ts",
      "src/product/queue.ts",
      "src/product/server.ts",
      "src/product/smartrecruiters-target.ts",
      "src/product/target.ts",
    ],
  },
  sourceImports: {
    // The worker dispatches account commands and owns viewport cleanup.
    "extension/background.js": [
      "extension/page-viewport.js",
      "extension/workday-account.js",
    ],
    // Only the declaration uses the service's page-plan types.
    "extension/generic-fill.d.ts": ["src/product/page-matching.ts"],
    // Current-page actions compose the browser-only control, upload and account helpers.
    "extension/page-actions.js": [
      "extension/generic-fill.js",
      "extension/jobvite-resume.js",
      "extension/page-viewport.js",
      "extension/question-context.js",
      "extension/shared-choice-widget.js",
      "extension/workday-account.js",
    ],
    // Profile answers reuse the questionnaire's consent classifier and fallback policy.
    "src/ats/workday/application/profile/handler.ts": [
      "src/ats/workday/application/questions/protected.ts",
      "src/form/answers/testing-policy.ts",
    ],
    // Both profile readers share the extension's DOM ownership and field-context rules.
    "src/ats/workday/application/profile/multi-select-readback.ts": ["extension/shared-choice-widget.js"],
    "src/ats/workday/application/profile/playwright-page.ts": [
      "extension/question-context.js",
      "extension/shared-choice-widget.js",
    ],
    // The Workday observer shares the page classifier used during extension account entry.
    "src/ats/workday/page-observation.ts": ["extension/workday-account.js"],
    // The browser adapter annotates field context before returning observations.
    "src/browser/adapter.ts": ["extension/question-context.js"],
    // Browser runtime and structural catalog use the same Workday page observation.
    "src/browser/playwright-live/private/workday-application-runtime.ts": ["src/ats/workday/page-observation.ts"],
    "src/browser/playwright-live/private/workday-structural-catalog.ts": ["src/ats/workday/page-observation.ts"],
    // Account lifecycle and storage reuse private atomic writes, IMAP failure types and DPAPI.
    "src/product/account-journal.ts": [
      "src/ats/workday/page-observation.ts",
      "src/composition/private/s2-application-source-preparation.ts",
    ],
    "src/product/account-state.ts": [
      "src/composition/private/s2-application-source-preparation.ts",
      "src/mailbox/providers/gmail/private/imap-client.ts",
    ],
    "src/product/account-storage.ts": [
      "src/composition/private/s2-application-source-preparation.ts",
      "src/secrets/windows-dpapi/bridge.ts",
      "src/secrets/windows-dpapi/record.ts",
    ],
    // Each uploader binds to the active target and reports the workflow's pause or upload receipt.
    "src/product/client-resume.ts": [
      "src/product/engine.ts",
      "src/product/target.ts",
    ],
    // The current engine assembles the Workday browser, preparation, account and review ports.
    "src/product/engine.ts": [
      "src/ats/workday/application/page-walk-contract.ts",
      "src/ats/workday/application/page-walk.ts",
      "src/ats/workday/application/playwright-page.ts",
      "src/ats/workday/page-observation.ts",
      "src/browser/playwright-live/private/application-page-types.ts",
      "src/browser/playwright-live/private/playwright-account-page.ts",
      "src/browser/playwright-live/private/playwright-posting-navigation.ts",
      "src/browser/playwright-live/private/workday-application-runtime.ts",
      "src/browser/playwright-live/private/workday-structural-catalog.ts",
      "src/interaction/review/index.ts",
      "src/product/account-journal.ts",
      "src/product/sources.ts",
    ],
    // The bridge validates the selected job target and dispatches Workday sign-in.
    "src/product/extension-bridge.ts": [
      "src/product/smartrecruiters-target.ts",
      "src/product/target.ts",
      "src/product/workday-sign-in.ts",
    ],
    // Generic fill composes browser helpers with the profile and page-answer matcher.
    "src/product/generic-application.ts": [
      "extension/generic-fill.js",
      "extension/jobvite-resume.js",
      "extension/question-context.js",
      "extension/shared-choice-widget.js",
      "src/product/page-matching.ts",
      "src/product/sources.ts",
      "src/profile/application-profile.ts",
    ],
    "src/product/greenhouse-resume.ts": [
      "src/product/engine.ts",
      "src/product/target.ts",
    ],
    // Hosted fill combines profile/question resolution, consent classification and ATS-specific uploads.
    "src/product/hosted-application.ts": [
      "extension/question-context.js",
      "src/ats/workday/application/questions/protected.ts",
      "src/composition/private/s2-derived-profile-country.ts",
      "src/form/answers/resolver.ts",
      "src/form/questions/catalog.ts",
      "src/form/questions/normalize.ts",
      "src/product/client-resume.ts",
      "src/product/greenhouse-resume.ts",
      "src/product/matching-backlog.ts",
      "src/product/profile-field.ts",
      "src/product/sources.ts",
      "src/product/workable-resume.ts",
    ],
    // Candidate ranking and page matching reuse catalog normalization, answer resolution and persistence.
    "src/product/matching-backlog.ts": [
      "src/composition/private/s2-application-source-preparation.ts",
      "src/form/options/mapper.ts",
      "src/form/questions/catalog.ts",
      "src/form/questions/matching.ts",
      "src/form/questions/normalize.ts",
    ],
    "src/product/page-matching.ts": [
      "src/form/answers/resolver.ts",
      "src/form/questions/catalog.ts",
      "src/form/questions/normalize.ts",
    ],
    // Queue preparation owns binding inputs, authentication, browser attachment and viewport recovery.
    "src/product/queue.ts": [
      "extension/page-viewport.js",
      "src/composition/private/s2-application-source-preparation.ts",
      "src/product/account-journal.ts",
      "src/product/extension-bridge.ts",
      "src/product/sources.ts",
      "src/product/workday-sign-in.ts",
    ],
    // The local server composes the authenticated account, matching and browser APIs.
    "src/product/server.ts": [
      "src/composition/private/s2-application-source-preparation.ts",
      "src/form/questions/catalog.ts",
      "src/mailbox/providers/gmail/private/imap-client.ts",
      "src/product/account-state.ts",
      "src/product/account-storage.ts",
      "src/product/extension-bridge.ts",
      "src/product/matching-backlog.ts",
      "src/product/page-matching.ts",
      "src/product/sources.ts",
      "src/product/workday-sign-in.ts",
    ],
    // The source adapter builds the profile, questionnaire and resume inputs and records learning.
    "src/product/sources.ts": [
      "src/ats/workday/application/profile/catalog.ts",
      "src/ats/workday/application/profile/types.ts",
      "src/ats/workday/application/questions/index.ts",
      "src/ats/workday/application/resume/index.ts",
      "src/composition/private/s2-application-owner-source.ts",
      "src/form/answers/testing-policy.ts",
      "src/form/questions/catalog.ts",
      "src/live/evidence/question-answer-learning.ts",
      "src/profile/application-profile.ts",
    ],
    "src/product/workable-resume.ts": [
      "src/product/engine.ts",
      "src/product/target.ts",
    ],
    // Sign-in uses the common Workday observer and the workflow's account and pause types.
    "src/product/workday-sign-in.ts": [
      "src/ats/workday/page-observation.ts",
      "src/product/engine.ts",
    ],
  },
  // Stage 1 still needs only Playwright; only this transport may import ws.
  runtimeDependencies: { ws: ["src/product/extension-bridge.ts"] },
} as const;
