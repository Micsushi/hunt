import type {
  AdmissionDecision,
  AnswerResolutionError,
  AnswerResolutionRequest,
  AnswerResolutionResult,
  BrowserCloseRequest,
  BrowserNavigationObservation,
  BrowserNavigationRequest,
  BrowserObservation,
  BrowserObservationRequest,
  BrowserOperationReceipt,
  BrowserMutationRequest,
  BrowserSessionError,
  BrowserSessionResult,
  BrowserStartRequest,
  CancelJourneyCommand,
  DriverError,
  DriverRequest,
  EvidenceAdmissionRequest,
  EvidenceError,
  EvidenceManifest,
  EvidenceReadRequest,
  EvidenceWriteResult,
  EventAppendRequest,
  EventAppendResult,
  FailureReport,
  FailureReportRequest,
  FailureReportingError,
  FixtureFaultRequest,
  FixtureResetRequest,
  FixtureResetResult,
  FixtureRuntimeError,
  FixtureStartRequest,
  FixtureStartResult,
  FixtureTransitionRequest,
  FixtureTransitionResult,
  JourneyBootstrapRequest,
  JourneyBootstrapResult,
  JourneyInputError,
  JourneyOperationResult,
  JourneyProgress,
  JourneyResultQuery,
  JourneyStateError,
  JourneyStateLoadRequest,
  JourneyStateLoadResult,
  JourneyStateTransitionCommand,
  JourneyStateTransitionResult,
  JourneyStatus,
  JourneyStatusQuery,
  McpRequest,
  McpResponse,
  McpTransportError,
  ModelAdmissionError,
  ModelSuggestionRequest,
  ModelSuggestionResult,
  MutationReceipt,
  NavigationError,
  NavigationReconciliationRequest,
  NavigationResult,
  NotificationRecord,
  ObservabilityError,
  OrchestratorError,
  PageCompletionRequest,
  PageCompletionResult,
  PageUnderstandingError,
  PageUnderstandingRequest,
  PageUnderstandingResult,
  PortResult,
  PrivacyAdmissionRequest,
  PrivacyDenial,
  ProfileAnswerResult,
  ProfileQueryError,
  ProfileQueryRequest,
  ProgressReadRequest,
  SafetyAdmissionRequest,
  SafetyDenial,
  StartJourneyCommand,
  TerminalResult,
  VerificationError,
  VerificationRequest,
  VerificationResult,
} from "./types.ts";

export const inProcessContractPolicy = {
  pin: "git-revision",
  runtimeVersionField: false,
} as const;

export const portNames = [
  "FixtureRuntime",
  "BrowserSession",
  "JourneyIntake",
  "ProfileQuery",
  "JourneyStateStore",
  "PageUnderstanding",
  "AnswerResolver",
  "FieldDriver",
  "FieldVerifier",
  "CompletionNavigation",
  "JourneyControl",
  "McpJourneyApi",
  "EventSink",
  "ProgressReader",
  "FailureReporter",
  "PrivacyGuard",
  "SafetyGuard",
  "EvidenceStore",
  "ModelController",
] as const;

type AsyncResult<T, E> = Promise<PortResult<T, E>>;

export interface FixtureRuntime {
  start(request: FixtureStartRequest, signal?: AbortSignal): AsyncResult<FixtureStartResult, FixtureRuntimeError>;
  transition(request: FixtureTransitionRequest, signal?: AbortSignal): AsyncResult<FixtureTransitionResult, FixtureRuntimeError>;
  reset(request: FixtureResetRequest, signal?: AbortSignal): AsyncResult<FixtureResetResult, FixtureRuntimeError>;
  setFault(request: FixtureFaultRequest, signal?: AbortSignal): AsyncResult<void, FixtureRuntimeError>;
}

export interface BrowserSession {
  start(request: BrowserStartRequest, signal?: AbortSignal): AsyncResult<BrowserSessionResult, BrowserSessionError>;
  observe(request: BrowserObservationRequest, signal?: AbortSignal): AsyncResult<BrowserObservation, BrowserSessionError>;
  mutate(request: BrowserMutationRequest, signal?: AbortSignal): AsyncResult<BrowserOperationReceipt, BrowserSessionError>;
  navigate(request: BrowserNavigationRequest, signal?: AbortSignal): AsyncResult<BrowserNavigationObservation, BrowserSessionError>;
  close(request: BrowserCloseRequest, signal?: AbortSignal): AsyncResult<void, BrowserSessionError>;
}

export interface JourneyIntake {
  bootstrap(request: JourneyBootstrapRequest, signal?: AbortSignal): AsyncResult<JourneyBootstrapResult, JourneyInputError>;
}

export interface ProfileQuery {
  query(request: ProfileQueryRequest, signal?: AbortSignal): AsyncResult<ProfileAnswerResult, ProfileQueryError>;
}

export interface JourneyStateStore {
  load(request: JourneyStateLoadRequest, signal?: AbortSignal): AsyncResult<JourneyStateLoadResult, JourneyStateError>;
  transition(request: JourneyStateTransitionCommand, signal?: AbortSignal): AsyncResult<JourneyStateTransitionResult, JourneyStateError>;
}

export interface PageUnderstanding {
  understand(request: PageUnderstandingRequest, signal?: AbortSignal): AsyncResult<PageUnderstandingResult, PageUnderstandingError>;
}

export interface AnswerResolver {
  resolve(request: AnswerResolutionRequest, signal?: AbortSignal): AsyncResult<AnswerResolutionResult, AnswerResolutionError>;
}

export interface FieldDriver {
  drive(request: DriverRequest, signal?: AbortSignal): AsyncResult<MutationReceipt, DriverError>;
}

export interface FieldVerifier {
  verify(request: VerificationRequest, signal?: AbortSignal): AsyncResult<VerificationResult, VerificationError>;
}

export interface CompletionNavigation {
  complete(request: PageCompletionRequest, signal?: AbortSignal): AsyncResult<PageCompletionResult, NavigationError>;
  reconcile(request: NavigationReconciliationRequest, signal?: AbortSignal): AsyncResult<NavigationResult, NavigationError>;
}

export interface JourneyControl {
  start(request: StartJourneyCommand, signal?: AbortSignal): AsyncResult<JourneyOperationResult, OrchestratorError>;
  cancel(request: CancelJourneyCommand, signal?: AbortSignal): AsyncResult<JourneyOperationResult, OrchestratorError>;
  status(request: JourneyStatusQuery, signal?: AbortSignal): AsyncResult<JourneyStatus, OrchestratorError>;
  result(request: JourneyResultQuery, signal?: AbortSignal): AsyncResult<TerminalResult, OrchestratorError>;
}

export interface McpJourneyApi {
  handle(request: McpRequest, signal?: AbortSignal): AsyncResult<McpResponse, McpTransportError>;
}

export interface EventSink {
  append(request: EventAppendRequest, signal?: AbortSignal): AsyncResult<EventAppendResult, ObservabilityError>;
}

export interface ProgressReader {
  read(request: ProgressReadRequest, signal?: AbortSignal): AsyncResult<JourneyProgress, ObservabilityError>;
}

export interface FailureReporter {
  report(request: FailureReportRequest, signal?: AbortSignal): AsyncResult<
    { readonly report: FailureReport; readonly notification: NotificationRecord },
    FailureReportingError
  >;
}

export interface PrivacyGuard {
  admit(request: PrivacyAdmissionRequest, signal?: AbortSignal): AsyncResult<AdmissionDecision, PrivacyDenial>;
}

export interface SafetyGuard {
  admit(request: SafetyAdmissionRequest, signal?: AbortSignal): AsyncResult<AdmissionDecision, SafetyDenial>;
}

export interface EvidenceStore {
  write(request: EvidenceAdmissionRequest, signal?: AbortSignal): AsyncResult<EvidenceWriteResult, EvidenceError>;
  read(request: EvidenceReadRequest, signal?: AbortSignal): AsyncResult<EvidenceManifest, EvidenceError>;
}

export interface ModelController {
  suggest(request: ModelSuggestionRequest, signal?: AbortSignal): AsyncResult<ModelSuggestionResult, ModelAdmissionError>;
}
