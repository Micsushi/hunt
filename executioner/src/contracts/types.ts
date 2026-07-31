export const MAX_IDENTIFIER_CODE_POINTS = 128 as const;

declare const identifierBrand: unique symbol;
type Identifier<Kind extends string> = string & {
  readonly [identifierBrand]: Kind;
};

function boundedIdentifier<Kind extends string>(
  value: string,
  kind: Kind,
  label: string = kind,
): Identifier<Kind> {
  let codePoints = 0;
  for (const _codePoint of value) {
    codePoints += 1;
  }
  if (
    codePoints === 0 ||
    codePoints > MAX_IDENTIFIER_CODE_POINTS ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new RangeError(`${label} identifier is malformed or out of bounds`);
  }
  return value as Identifier<Kind>;
}

export type FixturePageId = Identifier<"fixture_page">;
export type FixtureSemanticHash = Identifier<"fixture_semantic_hash">;
export type BrowserSessionId = Identifier<"browser_session">;
export type BrowserPageId = Identifier<"browser_page">;
export type BrowserTargetToken = Identifier<"browser_target">;
export type JourneyId = Identifier<"journey">;
export type QuestionId = Identifier<"question">;
export type OptionId = Identifier<"option">;
export type OperationId = Identifier<"operation">;
export type JobId = Identifier<"upstream_job">;
export type ResumeId = Identifier<"upstream_resume">;
export type ProfileId = Identifier<"upstream_profile">;
export type McpRequestId = Identifier<"mcp_request">;
export type GuardRevision = Identifier<"guard_revision">;
export type FixtureRunId = Identifier<"fixture_run">;
export type FieldId = Identifier<"field">;
export type EventId = Identifier<"event">;
export type EvidenceId = Identifier<"evidence">;
export type ReportId = Identifier<"report">;

export const upstreamJobId = (value: string): JobId =>
  boundedIdentifier(value, "upstream_job", "job");
export const upstreamResumeId = (value: string): ResumeId =>
  boundedIdentifier(value, "upstream_resume", "resume");
export const upstreamProfileId = (value: string): ProfileId =>
  boundedIdentifier(value, "upstream_profile", "profile");
export const mcpRequestId = (value: string): McpRequestId =>
  boundedIdentifier(value, "mcp_request", "MCP request");
export const guardRevision = (value: string): GuardRevision =>
  boundedIdentifier(value, "guard_revision", "guard revision");
export function generatedOperationId(value: string): OperationId {
  if (!/^operation_[A-Za-z0-9_-]{16,64}$/u.test(value)) {
    throw new RangeError("operation identifier is malformed or out of bounds");
  }
  return value as OperationId;
}
export function journeyId(value: string): JourneyId {
  if (!/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value)) {
    throw new RangeError("journey identifier is malformed or out of bounds");
  }
  return value as JourneyId;
}
export const fixturePageId = (value: string): FixturePageId =>
  boundedIdentifier(value, "fixture_page", "fixture page");
export const fixtureSemanticHash = (value: string): FixtureSemanticHash =>
  boundedIdentifier(
    value,
    "fixture_semantic_hash",
    "fixture semantic hash",
  );
export const browserPageId = (value: string): BrowserPageId =>
  boundedIdentifier(value, "browser_page", "browser page");
export const browserTargetToken = (value: string): BrowserTargetToken =>
  boundedIdentifier(value, "browser_target", "browser target");
export const questionId = (value: string): QuestionId =>
  boundedIdentifier(value, "question");
export const optionId = (value: string): OptionId =>
  boundedIdentifier(value, "option");
export const fixtureRunId = (value: string): FixtureRunId =>
  boundedIdentifier(value, "fixture_run", "fixture run");
export const fieldId = (value: string): FieldId =>
  boundedIdentifier(value, "field");
export const eventId = (value: string): EventId =>
  boundedIdentifier(value, "event");
export function generatedEvidenceId(value: string): EvidenceId {
  if (!/^evidence_[A-Za-z0-9_-]{16,64}$/u.test(value)) {
    throw new RangeError("evidence identifier is malformed or out of bounds");
  }
  return value as EvidenceId;
}
export function generatedReportId(value: string): ReportId {
  if (!/^report_[A-Za-z0-9_-]{16,64}$/u.test(value)) {
    throw new RangeError("report identifier is malformed or out of bounds");
  }
  return value as ReportId;
}

export type GeneratedIdScope = "journey" | "browser_session" | "operation" | "report";

export interface NonSensitiveIdSource {
  next(scope: GeneratedIdScope): string;
}

export interface GeneratedIdAllocator {
  journeyId(): PortResult<JourneyId, JourneyIdentityError>;
  sessionId(): PortResult<BrowserSessionId, SessionIdentityError>;
  operationId(): PortResult<OperationId, OperationIdentityError>;
  reportId(): PortResult<ReportId, ReportIdentityError>;
}

export type SessionIdentityError = PortError<
  "session_identity_source_invalid" | "session_identity_collision"
>;
export type JourneyIdentityError = PortError<
  "journey_identity_source_invalid" | "journey_identity_collision"
>;
export type OperationIdentityError = PortError<
  "operation_identity_source_invalid" | "operation_identity_collision"
>;
export type ReportIdentityError = PortError<
  "report_identity_source_invalid" | "report_identity_collision"
>;

export function createGeneratedIdAllocator(
  source: NonSensitiveIdSource,
): GeneratedIdAllocator {
  const occupied = new Set<string>();
  const prefixes = {
    journey: "journey_",
    browser_session: "browser_session_",
    operation: "operation_",
    report: "report_",
  } as const;
  const allocate = <Kind extends GeneratedIdScope>(scope: Kind) => {
    const errorPrefix = scope === "browser_session" ? "session" : scope;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let token: string;
      try {
        token = source.next(scope);
      } catch {
        return { ok: false, error: providerError(`${errorPrefix}_identity_source_invalid` as
          | "session_identity_source_invalid"
          | "journey_identity_source_invalid"
          | "operation_identity_source_invalid"
          | "report_identity_source_invalid") } as const;
      }
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,64}$/u.test(token)) {
        return { ok: false, error: providerError(`${errorPrefix}_identity_source_invalid` as
          | "session_identity_source_invalid"
          | "journey_identity_source_invalid"
          | "operation_identity_source_invalid"
          | "report_identity_source_invalid") } as const;
      }
      const candidate = boundedIdentifier(`${prefixes[scope]}${token}`, scope);
      if (!occupied.has(candidate)) {
        occupied.add(candidate);
        return { ok: true, value: candidate } as const;
      }
    }
    return { ok: false, error: providerError(`${errorPrefix}_identity_collision` as
      | "session_identity_collision"
      | "journey_identity_collision"
      | "operation_identity_collision"
      | "report_identity_collision") } as const;
  };
  return Object.freeze({
    journeyId: () => allocate("journey") as PortResult<JourneyId, JourneyIdentityError>,
    sessionId: () => allocate("browser_session") as PortResult<BrowserSessionId, SessionIdentityError>,
    operationId: () => allocate("operation") as PortResult<OperationId, OperationIdentityError>,
    reportId: () => allocate("report") as PortResult<ReportId, ReportIdentityError>,
  });
}

export function generatedJourneyId(
  allocator: GeneratedIdAllocator,
): PortResult<JourneyId, JourneyIdentityError> {
  return allocator.journeyId();
}

export function generatedSessionId(
  allocator: GeneratedIdAllocator,
): PortResult<BrowserSessionId, SessionIdentityError> {
  return allocator.sessionId();
}

export const stableErrorPolicy = {
  session_identity_source_invalid: { owner: "F3", retryable: false },
  session_identity_collision: { owner: "F3", retryable: false },
  journey_identity_source_invalid: { owner: "F9", retryable: false },
  journey_identity_collision: { owner: "F9", retryable: false },
  operation_identity_source_invalid: { owner: "F9", retryable: false },
  operation_identity_collision: { owner: "F9", retryable: false },
  report_identity_source_invalid: { owner: "F10", retryable: false },
  report_identity_collision: { owner: "F10", retryable: false },
  operation_cancelled: { owner: "F9", retryable: false },
  fixture_not_found: { owner: "F2", retryable: false },
  fixture_already_started: { owner: "F2", retryable: false },
  fixture_timeout: { owner: "F2", retryable: true },
  browser_target_invalid: { owner: "F3", retryable: false },
  browser_page_owned: { owner: "F3", retryable: false },
  browser_session_missing: { owner: "F3", retryable: false },
  browser_target_stale: { owner: "F3", retryable: false },
  browser_target_ambiguous: { owner: "F3", retryable: false },
  browser_operation_replayed: { owner: "F3", retryable: false },
  browser_timeout: { owner: "F3", retryable: true },
  browser_effect_uncertain: { owner: "F3", retryable: false },
  browser_session_invalidated: { owner: "F3", retryable: false },
  journey_input_invalid: { owner: "F4", retryable: false },
  resume_identity_mismatch: { owner: "F4", retryable: false },
  journey_persistence_unavailable: { owner: "F4", retryable: true },
  artifact_size_invalid: { owner: "F4", retryable: false },
  artifact_digest_mismatch: { owner: "F4", retryable: false },
  artifact_changed: { owner: "F4", retryable: false },
  artifact_already_consumed: { owner: "F4", retryable: false },
  artifact_handle_invalid: { owner: "F4", retryable: false },
  profile_query_invalid: { owner: "F4", retryable: false },
  profile_missing: { owner: "F4", retryable: false },
  profile_revision_mismatch: { owner: "F4", retryable: false },
  journey_state_invalid: { owner: "F4", retryable: false },
  journey_transition_illegal: { owner: "F4", retryable: false },
  journey_revision_conflict: { owner: "F4", retryable: true },
  journey_state_unavailable: { owner: "F4", retryable: true },
  page_observation_invalid: { owner: "F5", retryable: false },
  question_unknown: { owner: "F6", retryable: false },
  question_ambiguous: { owner: "F6", retryable: false },
  protected_answer_denied: { owner: "F6", retryable: false },
  driver_intent_invalid: { owner: "F7", retryable: false },
  driver_behavior_unsupported: { owner: "F7", retryable: false },
  driver_target_invalid: { owner: "F7", retryable: false },
  driver_operation_replayed: { owner: "F7", retryable: false },
  verification_input_invalid: { owner: "F8", retryable: false },
  verification_timeout: { owner: "F8", retryable: true },
  page_incomplete: { owner: "F8", retryable: false },
  navigation_illegal: { owner: "F8", retryable: false },
  navigation_uncertain: { owner: "F8", retryable: false },
  journey_request_conflict: { owner: "F9", retryable: false },
  journey_not_found: { owner: "F9", retryable: false },
  journey_already_terminal: { owner: "F9", retryable: false },
  journey_busy: { owner: "F9", retryable: false },
  journey_retry_exhausted: { owner: "F9", retryable: false },
  mcp_request_invalid: { owner: "F9", retryable: false },
  mcp_method_unknown: { owner: "F9", retryable: false },
  mcp_internal_error: { owner: "F9", retryable: true },
  event_invalid: { owner: "F10", retryable: false },
  event_store_unavailable: { owner: "F10", retryable: true },
  progress_not_found: { owner: "F10", retryable: false },
  failure_context_invalid: { owner: "F10", retryable: false },
  notification_unavailable: { owner: "F10", retryable: true },
  credential_forbidden: { owner: "F11", retryable: false },
  token_forbidden: { owner: "F11", retryable: false },
  raw_text_forbidden: { owner: "F11", retryable: false },
  selector_forbidden: { owner: "F11", retryable: false },
  policy_override_forbidden: { owner: "F11", retryable: false },
  submit_forbidden: { owner: "F11", retryable: false },
  payload_too_large: { owner: "F11", retryable: false },
  evidence_denied: { owner: "F11", retryable: false },
  evidence_limit_exceeded: { owner: "F11", retryable: false },
  evidence_unavailable: { owner: "F11", retryable: true },
  admission_graph_invalid: { owner: "F11", retryable: false },
  admission_shape_invalid: { owner: "F11", retryable: false },
  admission_invalid: { owner: "F11", retryable: false },
  admission_stale: { owner: "F11", retryable: false },
  admission_consumed: { owner: "F11", retryable: false },
  admission_mismatch: { owner: "F11", retryable: false },
} as const;

export type StableErrorCode = keyof typeof stableErrorPolicy;
export type ErrorOwner = (typeof stableErrorPolicy)[StableErrorCode]["owner"];

type ErrorPolicy<C extends StableErrorCode> = (typeof stableErrorPolicy)[C];
export type ProviderErrorCause<C extends StableErrorCode = StableErrorCode> =
  C extends StableErrorCode
    ? {
        readonly code: C;
        readonly owner: ErrorPolicy<C>["owner"];
        readonly retryable: ErrorPolicy<C>["retryable"];
        readonly source: SourceReference;
      }
    : never;

export type PortResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type PortError<C extends StableErrorCode> = C extends StableErrorCode
  ? {
      readonly code: C;
      readonly retryable: ErrorPolicy<C>["retryable"];
      readonly cause?: ProviderErrorCause;
    }
  : never;

export type CancellationError = PortError<"operation_cancelled">;

export function providerCause<C extends StableErrorCode>(
  code: C,
  source: SourceReference,
): ProviderErrorCause<C> {
  const policy = stableErrorPolicy[code];
  return { code, owner: policy.owner, retryable: policy.retryable, source } as
    ProviderErrorCause<C>;
}

export function providerError<C extends StableErrorCode>(
  code: C,
  cause?: ProviderErrorCause,
): PortError<C> {
  const error = { code, retryable: stableErrorPolicy[code].retryable, cause };
  if (cause === undefined) delete error.cause;
  return error as PortError<C>;
}

export interface FixtureManifest {
  readonly schemaVersion: 2;
  readonly fixtureSet: "workday-s1";
  readonly pages: readonly {
    readonly id: FixturePageId;
    readonly path: string;
    readonly semanticHash: FixtureSemanticHash;
  }[];
}

export type FixtureFault = "component_failure" | null;

export interface FixtureRunState {
  readonly fixtureRunId: FixtureRunId;
  readonly pageId: FixturePageId;
  readonly enabledFault: FixtureFault;
}

export interface FixtureStartRequest {
  readonly fixtureRunId: FixtureRunId;
}

export interface FixtureResetRequest {
  readonly fixtureRunId: FixtureRunId;
}

export interface FixtureFaultRequest {
  readonly fixtureRunId: FixtureRunId;
  readonly fault: FixtureFault;
}

export interface FixtureStartResult {
  readonly fixtureRunId: FixtureRunId;
  readonly origin: string;
  readonly pageId: FixturePageId;
}

export interface FixtureResetResult {
  readonly fixtureRunId: FixtureRunId;
  readonly semanticHash: FixtureSemanticHash;
}

export type FixtureRuntimeError = PortError<
  | "fixture_not_found"
  | "fixture_already_started"
  | "fixture_timeout"
>;

export const browserControlKinds = [
  "text",
  "date",
  "choice",
  "select",
  "button",
  "file",
] as const;

export type BrowserControl =
  | {
      readonly kind: "text";
      readonly element: "input" | "textarea";
    }
  | {
      readonly kind: "date";
      readonly element: "input";
    }
  | {
      readonly kind: "choice";
      readonly element: "input";
      readonly choice: "radio" | "checkbox";
      readonly group: BoundedText;
      readonly checked: boolean;
    }
  | {
      readonly kind: "select";
      readonly element: "select" | "listbox";
      readonly options: readonly BrowserReadbackText[];
    }
  | { readonly kind: "button"; readonly element: "button" }
  | { readonly kind: "file"; readonly element: "input" };

export const MAX_BROWSER_READBACK_CODE_POINTS = 512 as const;

declare const boundedTextBrand: unique symbol;
export type BoundedText = string & {
  readonly [boundedTextBrand]: true;
};

export function boundedText(value: string): BoundedText {
  let codePoints = 0;
  for (const _codePoint of value) {
    codePoints += 1;
    if (codePoints > MAX_BROWSER_READBACK_CODE_POINTS) {
      throw new RangeError("browser readback exceeds the contract limit");
    }
  }
  return value as BoundedText;
}

export type BrowserReadbackText = BoundedText;
export const browserReadbackText = boundedText;

declare const sha256DigestBrand: unique symbol;
export type Sha256Digest = string & {
  readonly [sha256DigestBrand]: true;
};

export function sha256Digest(value: string): Sha256Digest {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError("SHA-256 digest must be 64 lowercase hexadecimal characters");
  }
  return value as Sha256Digest;
}

export type BrowserReadback =
  | { readonly kind: "empty" }
  | { readonly kind: "text"; readonly value: BrowserReadbackText }
  | { readonly kind: "checked"; readonly checked: boolean }
  | {
      readonly kind: "selected";
      readonly option: BrowserReadbackText | null;
    }
  | {
      readonly kind: "upload";
      readonly resumeId: null;
      readonly sha256: null;
    }
  | {
      readonly kind: "upload";
      readonly resumeId: ResumeId;
      readonly sha256: Sha256Digest;
    }
  | { readonly kind: "unavailable" };

export type BrowserTargetState =
  | {
      readonly visibility: "hidden";
      readonly enabled: boolean;
      readonly actionable: false;
    }
  | {
      readonly visibility: "visible";
      readonly enabled: false;
      readonly actionable: false;
    }
  | {
      readonly visibility: "visible";
      readonly enabled: true;
      readonly actionable: boolean;
    };

export interface BrowserTargetObservation {
  readonly token: BrowserTargetToken;
  readonly name: BrowserReadbackText;
  readonly required: boolean;
  readonly control: BrowserControl;
  readonly state: BrowserTargetState;
  readonly readback: BrowserReadback;
}

export interface BrowserObservation {
  readonly sessionId: BrowserSessionId;
  readonly pageId: BrowserPageId;
  readonly origin: string;
  readonly path: string;
  readonly targets: readonly BrowserTargetObservation[];
}

export type BrowserMutation =
  | {
      readonly kind: "set_text";
      readonly target: BrowserTargetToken;
      readonly text: string;
    }
  | {
      readonly kind: "set_date";
      readonly target: BrowserTargetToken;
      readonly isoDate: string;
    }
  | {
      readonly kind: "set_checked";
      readonly target: BrowserTargetToken;
      readonly checked: boolean;
    }
  | {
      readonly kind: "select";
      readonly target: BrowserTargetToken;
      readonly option: BoundedText;
    }
  | {
      readonly kind: "upload";
      readonly target: BrowserTargetToken;
      readonly artifact: ResolvedResumeArtifact;
    };

export const browserUploadPolicy = {
  consumeHandle: true,
  verifyFreshCopyDigestBeforeSideEffect: true,
} as const;

export interface BrowserStartRequest {
  readonly journeyId: JourneyId;
  readonly target: string;
}

export const browserOperationCoordinateKeys = [
  "sessionId",
  "pageId",
] as const;

export interface BrowserOperationCoordinates {
  readonly sessionId: BrowserSessionId;
  readonly pageId: BrowserPageId;
}

export type BrowserObservationRequest = BrowserOperationCoordinates;

export type BrowserMutationAdmissionSnapshot = {
  readonly policyRevision: GuardRevision;
  readonly capability: "field_mutation";
  readonly effect: {
    readonly kind: "browser_mutation";
    readonly sessionId: BrowserSessionId;
    readonly pageId: BrowserPageId;
    readonly operationId: OperationId;
    readonly mutation: BrowserMutation;
  };
};

export type BrowserNavigationAdmissionSnapshot = {
  readonly policyRevision: GuardRevision;
  readonly capability: "navigate_next";
  readonly effect: {
    readonly kind: "browser_navigation";
    readonly sessionId: BrowserSessionId;
    readonly pageId: BrowserPageId;
    readonly operationId: OperationId;
    readonly action: "next";
  };
};

export type BrowserMutationRequest = AdmissionConsumptionRequest<
  "safety",
  BrowserMutationAdmissionSnapshot
>;

export type BrowserNavigationRequest = AdmissionConsumptionRequest<
  "safety",
  BrowserNavigationAdmissionSnapshot
>;

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

export type BrowserReadError = PortError<
  | "browser_target_invalid"
  | "browser_page_owned"
  | "browser_session_missing"
  | "browser_target_stale"
  | "browser_target_ambiguous"
  | "browser_operation_replayed"
  | "browser_timeout"
>;

export type BrowserEffectError = PortError<
  | "browser_target_invalid"
  | "browser_page_owned"
  | "browser_session_missing"
  | "browser_target_stale"
  | "browser_target_ambiguous"
  | "browser_operation_replayed"
  | "browser_timeout"
  | "browser_effect_uncertain"
  | "browser_session_invalidated"
  | "artifact_changed"
  | "artifact_already_consumed"
  | "artifact_handle_invalid"
  | AdmissionConsumptionCode
>;

export type BrowserSessionError =
  | BrowserReadError
  | BrowserEffectError
  | SessionIdentityError;

export interface JobIntake {
  readonly jobId: JobId;
  readonly title: string;
  readonly company: string;
  readonly applyUrl: string;
}

export interface ResumeSelection {
  readonly resumeId: ResumeId;
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
  readonly profileId: ProfileId;
  readonly revision: number;
  readonly facts: readonly ProfileFact[];
}

export interface JourneyInputs {
  readonly job: JobIntake;
  readonly resume: ResumeSelection;
  readonly resumeArtifact: ResolvedResumeArtifact;
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
  readonly schemaVersion: 2;
  readonly journeyId: JourneyId;
  readonly status: JourneyStatus;
  readonly pageId: BrowserPageId | null;
  readonly revision: number;
}

export const journeyBootstrapReferenceKeys = [
  "jobId",
  "resumeId",
  "profileId",
] as const;

export interface JourneyBootstrapRequest {
  readonly jobId: JobId;
  readonly resumeId: ResumeId;
  readonly profileId: ProfileId;
}

export interface JourneyBootstrapResult {
  readonly journeyId: JourneyId;
  readonly inputs: JourneyInputs;
  readonly state: DurableJourneyState;
}

export interface ProfileQueryRequest {
  readonly profileId: ProfileId;
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
  readonly pageId: BrowserPageId | null;
}

export interface JourneyStateLoadResult {
  readonly state: DurableJourneyState | null;
}

export interface JourneyStateTransitionResult {
  readonly state: DurableJourneyState;
  readonly applied: boolean;
}

export type JourneyInputError = PortError<
  | "journey_input_invalid"
  | "resume_identity_mismatch"
  | "journey_persistence_unavailable"
  | "artifact_size_invalid"
  | "artifact_digest_mismatch"
>;
export type ProfileQueryError = PortError<
  "profile_query_invalid" | "profile_missing" | "profile_revision_mismatch"
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
  readonly fieldId: FieldId;
  readonly target: BrowserTargetToken;
  readonly label: BoundedText;
  readonly required: boolean;
  readonly behavior: UiBehaviorId | "unsupported";
  readonly options: readonly {
    readonly id: OptionId;
    readonly label: BoundedText;
  }[];
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

export type PageUnderstandingError = PortError<"page_observation_invalid">;

export type AnswerProvenance =
  | ProfileAnswerProvenance
  | "reviewed_catalog"
  | "visible_option";

export type FieldIntent =
  | {
      readonly kind: "text";
      readonly behavior: "text" | "textarea";
      readonly fieldId: FieldId;
      readonly target: BrowserTargetToken;
      readonly value: string;
      readonly provenance: AnswerProvenance;
    }
  | {
      readonly kind: "choice";
      readonly behavior: "radio" | "select" | "listbox";
      readonly fieldId: FieldId;
      readonly target: BrowserTargetToken;
      readonly optionId: OptionId;
      readonly expectedOption: BoundedText;
      readonly provenance: AnswerProvenance;
    }
  | {
      readonly kind: "toggle";
      readonly behavior: "checkbox";
      readonly fieldId: FieldId;
      readonly target: BrowserTargetToken;
      readonly checked: boolean;
      readonly provenance: AnswerProvenance;
    }
  | {
      readonly kind: "date";
      readonly behavior: "date";
      readonly fieldId: FieldId;
      readonly target: BrowserTargetToken;
      readonly isoDate: string;
      readonly provenance: AnswerProvenance;
    }
  | {
      readonly kind: "resume_upload";
      readonly behavior: "file_upload";
      readonly fieldId: FieldId;
      readonly target: BrowserTargetToken;
      readonly artifact: ResolvedResumeArtifact;
      readonly provenance: AnswerProvenance;
    };

export interface AnswerResolutionRequest {
  readonly field: FieldObservation;
  readonly profileId: ProfileId;
  readonly profileRevision: number;
  readonly resume: ResumeSelection;
  readonly resumeArtifact: ResolvedResumeArtifact;
}

export type AnswerResolutionResult =
  | { readonly kind: "resolved"; readonly intent: FieldIntent }
  | { readonly kind: "profile_answer_missing"; readonly questionId: QuestionId }
  | { readonly kind: "option_no_match"; readonly questionId: QuestionId }
  | { readonly kind: "option_ambiguous"; readonly questionId: QuestionId }
  | { readonly kind: "unsupported"; readonly fieldId: FieldId };

export type AnswerResolutionError =
  | PortError<
      | "question_unknown"
      | "question_ambiguous"
      | "protected_answer_denied"
    >
  | ProfileQueryError;

export type DriverBehaviorId = UiBehaviorId;

export interface DriverRequest {
  readonly journeyId: JourneyId;
  readonly sessionId: BrowserSessionId;
  readonly pageId: BrowserPageId;
  readonly guardRevision: GuardRevision;
  readonly operationId: OperationId;
  readonly intent: FieldIntent;
}

export interface MutationReceipt {
  readonly operationId: OperationId;
  readonly fieldId: FieldId;
  readonly behavior: DriverBehaviorId;
  readonly attempted: true;
}

export type DriverError =
  | PortError<
      | "driver_intent_invalid"
      | "driver_behavior_unsupported"
      | "driver_target_invalid"
      | "driver_operation_replayed"
    >
  | SafetyDenial
  | BrowserEffectError;

export interface VerificationRequest {
  readonly sessionId: BrowserSessionId;
  readonly pageId: BrowserPageId;
  readonly intent: FieldIntent;
  readonly receipt: MutationReceipt;
}

export type VerificationResult =
  | { readonly kind: "verified"; readonly fieldId: FieldId }
  | { readonly kind: "rejected"; readonly fieldId: FieldId; readonly reason: "mismatch" | "stale" }
  | { readonly kind: "ambiguous"; readonly fieldId: FieldId }
  | { readonly kind: "unavailable"; readonly fieldId: FieldId };

export interface PageCompletionRequest {
  readonly page: SemanticPageSnapshot;
  readonly verification: readonly VerificationResult[];
}

export type PageCompletionResult =
  | {
      readonly kind: "complete";
      readonly decision: ApprovedNavigationDecision;
    }
  | {
      readonly kind: "blocked";
      readonly fieldIds: readonly FieldId[];
      readonly decision: { readonly kind: "blocked" };
    };

export type ApprovedNavigationDecision =
  | { readonly kind: "next"; readonly expectedPage: "profile" | "questionnaire" | "review" }
  | { readonly kind: "stop_review" };

export type NavigationDecision =
  | ApprovedNavigationDecision
  | { readonly kind: "blocked" };

export interface NavigationReconciliationRequest {
  readonly operationId: OperationId;
  readonly decision: ApprovedNavigationDecision;
  readonly observation: BrowserNavigationObservation;
  readonly sourcePage: PageIdentity;
  readonly expected: PageIdentity;
  readonly observed: PageIdentity;
}

export type NavigationResult = {
  readonly expected: PageIdentity;
  readonly observed: PageIdentity;
} & (
  | { readonly kind: "advanced" }
  | { readonly kind: "review_reached" }
  | { readonly kind: "uncertain" }
  | { readonly kind: "illegal_transition" }
);

export type VerificationError =
  | PortError<"verification_input_invalid" | "verification_timeout">
  | BrowserSessionError;
export type NavigationError = PortError<
  "page_incomplete" | "navigation_illegal" | "navigation_uncertain"
>;

export type StartJourneyCommand = JourneyBootstrapRequest & {
  readonly operationId: OperationId;
};

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
      readonly schemaVersion: 2;
      readonly journeyId: JourneyId;
      readonly status: "review_reached" | "cancelled";
      readonly completedPages: number;
    }
  | {
      readonly schemaVersion: 2;
      readonly journeyId: JourneyId;
      readonly status: "failed";
      readonly completedPages: number;
      readonly errorCode: StableErrorCode;
    };

export type McpRequest =
  | {
      readonly schemaVersion: 2;
      readonly requestId: McpRequestId;
      readonly method: "start_journey";
      readonly params: JourneyBootstrapRequest;
    }
  | {
      readonly schemaVersion: 2;
      readonly requestId: McpRequestId;
      readonly method: "cancel_journey";
      readonly params: { readonly journeyId: JourneyId };
    }
  | {
      readonly schemaVersion: 2;
      readonly requestId: McpRequestId;
      readonly method: "journey_status" | "journey_result";
      readonly params: { readonly journeyId: JourneyId };
    };

export type McpResult =
  | {
      readonly kind: "accepted";
      readonly operationId: OperationId;
      readonly journeyId: JourneyId;
    }
  | {
      readonly kind: "status";
      readonly progress: JourneyProgress;
    }
  | { readonly kind: "terminal"; readonly terminal: TerminalResult };

export type McpResponse =
  | {
      readonly schemaVersion: 2;
      readonly requestId: McpRequestId;
      readonly ok: true;
      readonly result: McpResult;
    }
  | {
      readonly schemaVersion: 2;
      readonly requestId: McpRequestId;
      readonly ok: false;
      readonly error: ErrorEnvelope;
    };

export type OrchestratorError = PortError<
  | "journey_request_conflict"
  | "journey_not_found"
  | "journey_already_terminal"
  | "journey_busy"
  | "journey_retry_exhausted"
> | JourneyIdentityError | OperationIdentityError;
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

export type SourceReference =
  | { readonly kind: "operation"; readonly id: OperationId }
  | { readonly kind: "event"; readonly id: EventId }
  | { readonly kind: "evidence"; readonly id: EvidenceId }
  | { readonly kind: "fixture"; readonly id: FixtureRunId };

export interface VerifiedCause {
  readonly verification: "verified";
  readonly code: StableErrorCode;
  readonly source: SourceReference;
}

export interface EventEnvelope {
  readonly schemaVersion: 2;
  readonly eventId: EventId;
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

export type FailureContext = {
  readonly [C in StableErrorCode]: {
    readonly journeyId: JourneyId;
    readonly component: ErrorPolicy<C>["owner"];
    readonly phase: PhaseId;
    readonly step: StepId;
    readonly code: C;
    readonly retryable: ErrorPolicy<C>["retryable"];
    readonly source: SourceReference;
    readonly cause?: VerifiedCause;
  };
}[StableErrorCode];

export interface FailureReportRequest {
  readonly reportId: ReportId;
  readonly context: FailureContext;
}

export interface FailureReport {
  readonly reportId: ReportId;
  readonly context: FailureContext;
}

export interface NotificationRecord {
  readonly reportId: ReportId;
  readonly delivered: boolean;
}

export type ObservabilityError = PortError<
  "event_invalid" | "event_store_unavailable" | "progress_not_found"
>;
export type FailureReportingError = PortError<
  | "failure_context_invalid"
  | "notification_unavailable"
  | "report_identity_source_invalid"
  | "report_identity_collision"
>;

export const admissionDecisionPolicy = {
  admitted: "result",
  denied: "error",
} as const;

export type AdmissionDecision = AdmittedSnapshot;

export type RedactionCode =
  | "credential_forbidden"
  | "token_forbidden"
  | "raw_text_forbidden"
  | "selector_forbidden"
  | "policy_override_forbidden"
  | "submit_forbidden"
  | "payload_too_large";

export interface PrivacyAdmissionRequest {
  readonly binding: AdmissionBinding;
  readonly purpose: "privacy" | "evidence";
  readonly input: Readonly<Record<string, unknown>>;
}

export type SafetyAdmissionInput =
  | BrowserMutationAdmissionSnapshot
  | BrowserNavigationAdmissionSnapshot;

export interface SafetyAdmissionRequest<
  I extends SafetyAdmissionInput = SafetyAdmissionInput,
> {
  readonly binding: AdmissionBinding;
  readonly policyRevision: GuardRevision;
  readonly capability: I["capability"];
  readonly input: I;
}

export interface EvidenceRecord {
  readonly id: EvidenceId;
  readonly kind: "semantic_snapshot" | "operation_receipt" | "verification";
  readonly component: ComponentId;
  readonly phase: PhaseId;
  readonly step: StepId;
  readonly sha256: string;
}

export interface EvidenceManifest {
  readonly schemaVersion: 2;
  readonly journeyId: JourneyId;
  readonly records: readonly EvidenceRecord[];
}

export type EvidenceAdmissionSnapshot = {
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly record: EvidenceRecord;
};

export type EvidenceAdmissionRequest = AdmissionConsumptionRequest<
  "evidence",
  EvidenceAdmissionSnapshot
>;

export interface EvidenceReadRequest {
  readonly journeyId: JourneyId;
}

export interface EvidenceWriteResult {
  readonly recordId: EvidenceId;
  readonly written: boolean;
}

export type AdmissionInputCode = "admission_graph_invalid" | "admission_shape_invalid";
export type AdmissionConsumptionCode =
  | "admission_invalid"
  | "admission_stale"
  | "admission_consumed"
  | "admission_mismatch";
export type PrivacyDenial = PortError<RedactionCode | AdmissionInputCode | AdmissionConsumptionCode>;
export type SafetyDenial = PortError<RedactionCode | AdmissionInputCode | AdmissionConsumptionCode>;
export type EvidenceError = PortError<
  | "evidence_denied"
  | "evidence_limit_exceeded"
  | "evidence_unavailable"
  | AdmissionConsumptionCode
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

export type ErrorEnvelope = {
  readonly [C in StableErrorCode]: {
    readonly schemaVersion: 2;
    readonly code: C;
    readonly component: ErrorPolicy<C>["owner"];
    readonly phase: PhaseId;
    readonly step: StepId;
    readonly retryable: ErrorPolicy<C>["retryable"];
    readonly source: SourceReference;
    readonly cause?: VerifiedCause;
  };
}[StableErrorCode];
import type { ResolvedResumeArtifact } from "./resume-artifact.ts";
import type { AdmissionBinding, AdmittedSnapshot, AdmissionConsumptionRequest } from "./admission.ts";
