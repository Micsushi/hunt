export type FixturePageId = string;
export type FixtureSemanticHash = string;
export type BrowserSessionId = string;
export type BrowserPageId = string;
export type BrowserTargetToken = string;
export type JourneyId = string;
export type QuestionId = string;
export type OptionId = string;
export type OperationId = string;

export type PortResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface PortError<C extends string> {
  readonly code: C;
  readonly retryable: boolean;
}

export interface FixtureManifest {
  readonly schemaVersion: 1;
  readonly fixtureSet: "workday-s1";
  readonly pages: readonly {
    readonly id: FixturePageId;
    readonly path: string;
    readonly semanticHash: FixtureSemanticHash;
  }[];
}

export interface FixtureRunState {
  readonly fixtureRunId: string;
  readonly pageId: FixturePageId;
  readonly enabledFault: string | null;
}

export interface FixtureStartRequest {
  readonly fixtureRunId: string;
}

export interface FixtureTransitionRequest {
  readonly fixtureRunId: string;
  readonly transitionId: string;
  readonly toPageId: FixturePageId;
}

export interface FixtureResetRequest {
  readonly fixtureRunId: string;
}

export interface FixtureFaultRequest {
  readonly fixtureRunId: string;
  readonly fault: "component_failure" | null;
}

export interface FixtureStartResult {
  readonly fixtureRunId: string;
  readonly origin: string;
  readonly pageId: FixturePageId;
}

export interface FixtureTransitionResult {
  readonly transitionId: string;
  readonly pageId: FixturePageId;
  readonly semanticHash: FixtureSemanticHash;
}

export interface FixtureResetResult {
  readonly fixtureRunId: string;
  readonly semanticHash: FixtureSemanticHash;
}

export type FixtureRuntimeError = PortError<
  | "fixture_not_found"
  | "fixture_already_started"
  | "fixture_transition_illegal"
  | "fixture_transition_replayed"
  | "fixture_timeout"
>;

export type BrowserTargetRole =
  | "textbox"
  | "radio"
  | "checkbox"
  | "combobox"
  | "listbox"
  | "button"
  | "file";

export const MAX_BROWSER_READBACK_CODE_POINTS = 512 as const;

declare const browserReadbackTextBrand: unique symbol;
export type BrowserReadbackText = string & {
  readonly [browserReadbackTextBrand]: true;
};

export function browserReadbackText(value: string): BrowserReadbackText {
  let codePoints = 0;
  for (const _codePoint of value) {
    codePoints += 1;
    if (codePoints > MAX_BROWSER_READBACK_CODE_POINTS) {
      throw new RangeError("browser readback exceeds the contract limit");
    }
  }
  return value as BrowserReadbackText;
}

export type BrowserReadback =
  | { readonly kind: "empty" }
  | { readonly kind: "text"; readonly value: BrowserReadbackText }
  | { readonly kind: "checked"; readonly checked: boolean }
  | {
      readonly kind: "selected";
      readonly option: BrowserReadbackText | null;
    }
  | { readonly kind: "upload"; readonly resumeId: string | null }
  | { readonly kind: "unavailable" };

export interface BrowserObservation {
  readonly sessionId: BrowserSessionId;
  readonly pageId: BrowserPageId;
  readonly origin: string;
  readonly path: string;
  readonly targets: readonly {
    readonly token: BrowserTargetToken;
    readonly role: BrowserTargetRole;
    readonly name: BrowserReadbackText;
    readonly required: boolean;
    readonly options: readonly BrowserReadbackText[];
    readonly readback: BrowserReadback;
  }[];
}

export type BrowserMutation =
  | {
      readonly kind: "type";
      readonly target: BrowserTargetToken;
      readonly text: string;
    }
  | {
      readonly kind: "click";
      readonly target: BrowserTargetToken;
    }
  | {
      readonly kind: "select";
      readonly target: BrowserTargetToken;
      readonly option: string;
    }
  | {
      readonly kind: "upload";
      readonly target: BrowserTargetToken;
      readonly resumeId: string;
    };

export interface BrowserStartRequest {
  readonly journeyId: JourneyId;
  readonly target: string;
}

export interface BrowserObservationRequest {
  readonly sessionId: BrowserSessionId;
  readonly pageId: BrowserPageId;
}

export interface BrowserMutationRequest {
  readonly sessionId: BrowserSessionId;
  readonly operationId: OperationId;
  readonly mutation: BrowserMutation;
}

export interface BrowserNavigationRequest {
  readonly sessionId: BrowserSessionId;
  readonly operationId: OperationId;
  readonly action: "next";
}

export interface BrowserCloseRequest {
  readonly sessionId: BrowserSessionId;
}

export interface BrowserSessionResult {
  readonly sessionId: BrowserSessionId;
  readonly pageId: BrowserPageId;
}

export interface BrowserOperationReceipt {
  readonly operationId: OperationId;
  readonly pageId: BrowserPageId;
  readonly attempted: true;
}

export interface BrowserNavigationObservation {
  readonly operationId: OperationId;
  readonly fromPageId: BrowserPageId;
  readonly pageId: BrowserPageId;
}

export type BrowserSessionError = PortError<
  | "browser_target_invalid"
  | "browser_page_owned"
  | "browser_session_missing"
  | "browser_target_stale"
  | "browser_target_ambiguous"
  | "browser_operation_replayed"
  | "browser_timeout"
  | "browser_cancelled"
>;

export interface JobIntake {
  readonly jobId: string;
  readonly title: string;
  readonly company: string;
  readonly applyUrl: string;
}

export interface ResumeSelection {
  readonly resumeId: string;
  readonly sha256: string;
}

export type ProfileAnswerProvenance =
  | "owner_provided"
  | "resume_verified"
  | "configured_template";

export const textProfileFactIds = [
  "given_name",
  "family_name",
  "preferred_name",
  "email_address",
  "phone_number",
  "city",
  "region",
  "country",
  "postal_code",
  "current_company",
  "current_title",
  "highest_education",
  "earliest_start_date",
  "configured_narrative",
] as const;

export const booleanProfileFactIds = [
  "work_authorization",
  "sponsorship_required",
  "age_requirement_met",
] as const;

export const numberProfileFactIds = [
  "years_experience",
  "desired_salary",
] as const;

export const profileFactIds = [
  ...textProfileFactIds,
  ...booleanProfileFactIds,
  ...numberProfileFactIds,
] as const;

export type ProfileFactId = (typeof profileFactIds)[number];

export type ProfileFact =
  | {
      readonly factId: (typeof textProfileFactIds)[number];
      readonly value: string;
      readonly provenance: ProfileAnswerProvenance;
    }
  | {
      readonly factId: (typeof booleanProfileFactIds)[number];
      readonly value: boolean;
      readonly provenance: ProfileAnswerProvenance;
    }
  | {
      readonly factId: (typeof numberProfileFactIds)[number];
      readonly value: number;
      readonly provenance: ProfileAnswerProvenance;
    };

export interface ApplicantProfile {
  readonly profileId: string;
  readonly revision: number;
  readonly facts: readonly ProfileFact[];
}

export interface JourneyInputs {
  readonly job: JobIntake;
  readonly resume: ResumeSelection;
  readonly profile: ApplicantProfile;
}

export type JourneyStatus =
  | "ready"
  | "running"
  | "cancelling"
  | "review_reached"
  | "cancelled"
  | "failed";

export interface DurableJourneyState {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly status: JourneyStatus;
  readonly pageId: string | null;
  readonly revision: number;
}

export const journeyBootstrapReferenceKeys = [
  "operationId",
  "jobId",
  "resumeId",
  "profileId",
] as const;

export type JourneyBootstrapRequest = Readonly<
  Record<(typeof journeyBootstrapReferenceKeys)[number], string>
>;

export interface JourneyBootstrapResult {
  readonly journeyId: JourneyId;
  readonly inputs: JourneyInputs;
  readonly state: DurableJourneyState;
}

export interface ProfileQueryRequest {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly factId: ProfileFactId;
}

export type ProfileAnswerResult =
  | {
      readonly kind: "answered";
      readonly value: string | number | boolean;
      readonly provenance: ProfileAnswerProvenance;
    }
  | { readonly kind: "profile_answer_missing" };

export interface JourneyStateLoadRequest {
  readonly journeyId: JourneyId;
}

export interface JourneyStateTransitionCommand {
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly expectedRevision: number;
  readonly status: JourneyStatus;
  readonly pageId: string | null;
}

export interface JourneyStateLoadResult {
  readonly state: DurableJourneyState | null;
}

export interface JourneyStateTransitionResult {
  readonly state: DurableJourneyState;
  readonly applied: boolean;
}

export type JourneyInputError = PortError<
  "journey_input_invalid" | "resume_identity_mismatch"
>;
export type ProfileQueryError = PortError<
  "profile_missing" | "profile_revision_mismatch"
>;
export type JourneyStateError = PortError<
  | "journey_state_invalid"
  | "journey_transition_illegal"
  | "journey_revision_conflict"
  | "journey_state_unavailable"
>;

export type PageIdentity =
  | { readonly kind: "workday"; readonly page: "account" | "profile" | "questionnaire" | "review" }
  | { readonly kind: "unknown" }
  | { readonly kind: "ambiguous" };

export const uiBehaviorIds = [
  "text",
  "textarea",
  "radio",
  "checkbox",
  "select",
  "listbox",
  "date",
  "file_upload",
] as const;

export type UiBehaviorId = (typeof uiBehaviorIds)[number];

export interface FieldObservation {
  readonly fieldId: string;
  readonly target: BrowserTargetToken;
  readonly label: string;
  readonly required: boolean;
  readonly behavior: UiBehaviorId | "unsupported";
  readonly options: readonly { readonly id: OptionId; readonly label: string }[];
  readonly state: "empty" | "populated" | "hidden" | "ambiguous";
}

export interface SemanticPageSnapshot {
  readonly pageIdentity: PageIdentity;
  readonly fields: readonly FieldObservation[];
}

export interface PageUnderstandingRequest {
  readonly observation: BrowserObservation;
}

export type PageUnderstandingResult =
  | {
      readonly kind: "understood";
      readonly snapshot: SemanticPageSnapshot;
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "ambiguous" };

export type PageUnderstandingError = PortError<
  "page_observation_invalid" | "page_understanding_cancelled"
>;

export type AnswerProvenance =
  | ProfileAnswerProvenance
  | "reviewed_catalog"
  | "visible_option";

export type FieldIntent =
  | {
      readonly kind: "text";
      readonly behavior: "text" | "textarea";
      readonly fieldId: string;
      readonly target: BrowserTargetToken;
      readonly value: string;
      readonly provenance: AnswerProvenance;
    }
  | {
      readonly kind: "choice";
      readonly behavior: "radio" | "select" | "listbox";
      readonly fieldId: string;
      readonly target: BrowserTargetToken;
      readonly optionId: OptionId;
      readonly provenance: AnswerProvenance;
    }
  | {
      readonly kind: "toggle";
      readonly behavior: "checkbox";
      readonly fieldId: string;
      readonly target: BrowserTargetToken;
      readonly checked: boolean;
      readonly provenance: AnswerProvenance;
    }
  | {
      readonly kind: "date";
      readonly behavior: "date";
      readonly fieldId: string;
      readonly target: BrowserTargetToken;
      readonly isoDate: string;
      readonly provenance: AnswerProvenance;
    }
  | {
      readonly kind: "resume_upload";
      readonly behavior: "file_upload";
      readonly fieldId: string;
      readonly target: BrowserTargetToken;
      readonly resumeId: string;
      readonly provenance: AnswerProvenance;
    };

export interface AnswerResolutionRequest {
  readonly field: FieldObservation;
  readonly profileId: string;
  readonly profileRevision: number;
}

export type AnswerResolutionResult =
  | { readonly kind: "resolved"; readonly intent: FieldIntent }
  | { readonly kind: "profile_answer_missing"; readonly questionId: QuestionId }
  | { readonly kind: "option_no_match"; readonly questionId: QuestionId }
  | { readonly kind: "option_ambiguous"; readonly questionId: QuestionId }
  | { readonly kind: "unsupported"; readonly fieldId: string };

export type AnswerResolutionError = PortError<
  | "question_unknown"
  | "question_ambiguous"
  | "protected_answer_denied"
  | "answer_resolution_cancelled"
>;

export type DriverBehaviorId = UiBehaviorId;

export interface DriverRequest {
  readonly operationId: OperationId;
  readonly intent: FieldIntent;
}

export interface MutationReceipt {
  readonly operationId: OperationId;
  readonly fieldId: string;
  readonly behavior: DriverBehaviorId;
  readonly attempted: boolean;
}

export type DriverError = PortError<
  | "driver_intent_invalid"
  | "driver_behavior_unsupported"
  | "driver_target_invalid"
  | "driver_operation_replayed"
  | "driver_cancelled"
>;

export interface VerificationRequest {
  readonly intent: FieldIntent;
  readonly receipt: MutationReceipt;
}

export type VerificationResult =
  | { readonly kind: "verified"; readonly fieldId: string }
  | { readonly kind: "rejected"; readonly fieldId: string; readonly reason: "mismatch" | "stale" }
  | { readonly kind: "ambiguous"; readonly fieldId: string }
  | { readonly kind: "unavailable"; readonly fieldId: string };

export interface PageCompletionRequest {
  readonly page: SemanticPageSnapshot;
  readonly verification: readonly VerificationResult[];
}

export type PageCompletionResult =
  | {
      readonly kind: "complete";
      readonly decision: NavigationDecision;
    }
  | {
      readonly kind: "blocked";
      readonly fieldIds: readonly string[];
      readonly decision: { readonly kind: "blocked" };
    };

export type NavigationDecision =
  | { readonly kind: "next"; readonly expectedPage: "profile" | "questionnaire" | "review" }
  | { readonly kind: "stop_review" }
  | { readonly kind: "blocked" };

export interface NavigationReconciliationRequest {
  readonly operationId: OperationId;
  readonly decision: NavigationDecision;
  readonly observation: BrowserNavigationObservation;
}

export type NavigationResult =
  | { readonly kind: "advanced"; readonly page: "profile" | "questionnaire" | "review" }
  | { readonly kind: "review_reached" }
  | { readonly kind: "uncertain" }
  | { readonly kind: "illegal_transition" };

export type VerificationError = PortError<
  "verification_input_invalid" | "verification_timeout" | "verification_cancelled"
>;
export type NavigationError = PortError<
  "page_incomplete" | "navigation_illegal" | "navigation_uncertain"
>;

export type StartJourneyCommand = JourneyBootstrapRequest;

export interface CancelJourneyCommand {
  readonly operationId: OperationId;
  readonly journeyId: JourneyId;
}

export interface JourneyStatusQuery {
  readonly journeyId: JourneyId;
}

export interface JourneyResultQuery {
  readonly journeyId: JourneyId;
}

export interface JourneyOperationResult {
  readonly operationId: OperationId;
  readonly journeyId: JourneyId;
  readonly accepted: boolean;
}

export type TerminalResult =
  | {
      readonly schemaVersion: 1;
      readonly journeyId: JourneyId;
      readonly status: "review_reached" | "cancelled";
      readonly completedPages: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly journeyId: JourneyId;
      readonly status: "failed";
      readonly completedPages: number;
      readonly errorCode: StableErrorCode;
    };

export type McpRequest =
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly method: "start_journey";
      readonly params: JourneyBootstrapRequest;
    }
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly method: "cancel_journey";
      readonly params: {
        readonly operationId: OperationId;
        readonly journeyId: JourneyId;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly method: "journey_status" | "journey_result";
      readonly params: { readonly journeyId: JourneyId };
    };

export type McpResult =
  | {
      readonly kind: "accepted";
      readonly operationId: OperationId;
    }
  | {
      readonly kind: "status";
      readonly journeyId: JourneyId;
      readonly status: JourneyStatus;
    }
  | { readonly kind: "terminal"; readonly terminal: TerminalResult };

export type McpResponse =
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly ok: true;
      readonly result: McpResult;
    }
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly ok: false;
      readonly error: ErrorEnvelope;
    };

export type OrchestratorError = PortError<
  | "journey_operation_replayed"
  | "journey_not_found"
  | "journey_already_terminal"
  | "journey_busy"
  | "journey_retry_exhausted"
  | "journey_cancelled"
>;
export type McpTransportError = PortError<
  "mcp_request_invalid" | "mcp_method_unknown" | "mcp_internal_error"
>;

export type EventKind =
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "journey_terminal";

export const phaseIds = [
  "fixture",
  "browser",
  "intake",
  "profile",
  "journey_state",
  "page_understanding",
  "answer_resolution",
  "field_interaction",
  "verification",
  "navigation",
  "orchestration",
  "mcp",
  "observability",
  "privacy",
  "safety",
  "evidence",
  "model",
  "terminal",
] as const;

export type PhaseId = (typeof phaseIds)[number];

export const stepIds = [
  "start",
  "observe",
  "validate",
  "classify",
  "resolve",
  "mutate",
  "readback",
  "verify",
  "complete",
  "navigate",
  "reconcile",
  "persist",
  "append",
  "report",
  "notify",
  "admit",
  "cancel",
  "close",
  "reset",
  "transition",
  "stop_review",
] as const;

export type StepId = (typeof stepIds)[number];

export interface SourceReference {
  readonly kind: "operation" | "event" | "evidence" | "fixture";
  readonly id: string;
}

export interface VerifiedCause {
  readonly verification: "verified";
  readonly code: StableErrorCode;
  readonly source: SourceReference;
}

export interface EventEnvelope {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly journeyId: JourneyId;
  readonly component: ComponentId;
  readonly phase: PhaseId;
  readonly step: StepId;
  readonly kind: EventKind;
  readonly at: string;
  readonly source: SourceReference;
}

export interface EventAppendRequest {
  readonly event: EventEnvelope;
}

export interface JourneyProgress {
  readonly journeyId: JourneyId;
  readonly status: JourneyStatus;
  readonly completedSteps: number;
}

export interface EventAppendResult {
  readonly appended: boolean;
  readonly progress: JourneyProgress;
}

export interface ProgressReadRequest {
  readonly journeyId: JourneyId;
}

export interface FailureContext {
  readonly journeyId: JourneyId;
  readonly component: ComponentId;
  readonly phase: PhaseId;
  readonly step: StepId;
  readonly code: StableErrorCode;
  readonly retryable: boolean;
  readonly source: SourceReference;
  readonly cause?: VerifiedCause;
}

export interface FailureReportRequest {
  readonly reportId: string;
  readonly context: FailureContext;
}

export interface FailureReport {
  readonly reportId: string;
  readonly context: FailureContext;
}

export interface NotificationRecord {
  readonly reportId: string;
  readonly delivered: boolean;
}

export type ObservabilityError = PortError<
  "event_invalid" | "event_store_unavailable" | "progress_not_found"
>;
export type FailureReportingError = PortError<
  "failure_context_invalid" | "notification_unavailable"
>;

export type AdmissionDecision =
  | { readonly kind: "admitted"; readonly policyRevision: string }
  | {
      readonly kind: "denied";
      readonly policyRevision: string;
      readonly code: RedactionCode;
    };

export type RedactionCode =
  | "credential_forbidden"
  | "token_forbidden"
  | "raw_text_forbidden"
  | "selector_forbidden"
  | "policy_override_forbidden"
  | "submit_forbidden"
  | "payload_too_large";

export interface PrivacyAdmissionRequest {
  readonly policyRevision: string;
  readonly semanticPayload: Readonly<Record<string, string | number | boolean>>;
}

export interface SafetyAdmissionRequest {
  readonly policyRevision: string;
  readonly capability:
    | "observe"
    | "field_mutation"
    | "navigate_next"
    | "read_progress"
    | "read_result";
}

export interface EvidenceRecord {
  readonly id: string;
  readonly kind: "semantic_snapshot" | "operation_receipt" | "verification";
  readonly component: ComponentId;
  readonly phase: PhaseId;
  readonly step: StepId;
  readonly sha256: string;
}

export interface EvidenceManifest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly records: readonly EvidenceRecord[];
}

export interface EvidenceAdmissionRequest {
  readonly journeyId: JourneyId;
  readonly record: EvidenceRecord;
}

export interface EvidenceReadRequest {
  readonly journeyId: JourneyId;
}

export interface EvidenceWriteResult {
  readonly recordId: string;
  readonly written: boolean;
}

export interface ModelSuggestionRequest {
  readonly attemptId: string;
  readonly questionId: QuestionId;
  readonly allowedOptionIds: readonly OptionId[];
}

export interface ModelSuggestion {
  readonly kind: "option_ranking" | "question_hint";
  readonly optionIds: readonly OptionId[];
}

export interface ModelSuggestionResult {
  readonly attemptId: string;
  readonly suggestion: ModelSuggestion;
}

export type PrivacyDenial = PortError<RedactionCode>;
export type SafetyDenial = PortError<RedactionCode>;
export type EvidenceError = PortError<
  "evidence_denied" | "evidence_limit_exceeded" | "evidence_unavailable"
>;
export type ModelAdmissionError = PortError<
  "model_request_denied" | "model_result_denied" | "model_unavailable"
>;

export type ComponentId =
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

export type StableErrorCode =
  | FixtureRuntimeError["code"]
  | BrowserSessionError["code"]
  | JourneyInputError["code"]
  | ProfileQueryError["code"]
  | JourneyStateError["code"]
  | PageUnderstandingError["code"]
  | AnswerResolutionError["code"]
  | DriverError["code"]
  | VerificationError["code"]
  | NavigationError["code"]
  | OrchestratorError["code"]
  | McpTransportError["code"]
  | ObservabilityError["code"]
  | FailureReportingError["code"]
  | PrivacyDenial["code"]
  | EvidenceError["code"]
  | ModelAdmissionError["code"];

export interface ErrorEnvelope {
  readonly schemaVersion: 1;
  readonly code: StableErrorCode;
  readonly component: ComponentId;
  readonly phase: PhaseId;
  readonly step: StepId;
  readonly retryable: boolean;
  readonly source: SourceReference;
  readonly cause?: VerifiedCause;
}
