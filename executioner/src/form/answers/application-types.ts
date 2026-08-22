import type {
  AnswerProvenance,
  AnswerResolutionError,
  CancellationError,
  FieldId,
  FieldIntent,
  FieldObservation,
  PortResult,
  ProfileAnswerProvenance,
  ProfileId,
  ProfileQueryError,
  QuestionId,
  ResolvedResumeArtifact,
  ResumeSelection,
} from "../../contracts/index.ts";
import {
  booleanProfileFactIds,
  numberProfileFactIds,
  textProfileFactIds,
} from "../../contracts/index.ts";

export const answerProvenanceLanes = [
  "live_owner_fact",
  "synthetic_test_default",
] as const;
export type AnswerProvenanceLane = (typeof answerProvenanceLanes)[number];

export const answerExecutionModes = [
  "live",
  "synthetic_test_non_submittable",
] as const;
export type AnswerExecutionMode = (typeof answerExecutionModes)[number];

export function answerLaneAdmitted(
  mode: AnswerExecutionMode,
  lane: AnswerProvenanceLane,
): boolean {
  return mode === "live"
    ? lane === "live_owner_fact"
    : lane === "synthetic_test_default";
}

export const applicationTextProfileFactIds = [
  ...textProfileFactIds,
  "application_source",
  "salary_expectations",
  "gender_disclosure",
  "ethnicity_disclosure",
  "veteran_disclosure",
  "disability_disclosure",
  "self_identification_language",
  "self_identification_name",
  "self_identification_date",
] as const;

export const applicationBooleanProfileFactIds = [
  ...booleanProfileFactIds,
  "previously_worked_for_organization",
  "associate_referral",
  "current_associate",
  "previously_applied",
  "relatives_employed",
  "essential_functions_ability",
  "employment_agreement_prevents_employment",
  "terms_consent",
] as const;

export const applicationNumberProfileFactIds = [...numberProfileFactIds] as const;

export const applicationProfileFactIds = [
  ...applicationTextProfileFactIds,
  ...applicationBooleanProfileFactIds,
  ...applicationNumberProfileFactIds,
] as const;
export type ApplicationProfileFactId = (typeof applicationProfileFactIds)[number];

export type ApplicationProfileFact =
  | {
      readonly factId: (typeof applicationTextProfileFactIds)[number];
      readonly value: string;
      readonly provenance: ProfileAnswerProvenance;
      readonly lane: "live_owner_fact";
    }
  | {
      readonly factId: (typeof applicationBooleanProfileFactIds)[number];
      readonly value: boolean;
      readonly provenance: ProfileAnswerProvenance;
      readonly lane: "live_owner_fact";
    }
  | {
      readonly factId: (typeof applicationNumberProfileFactIds)[number];
      readonly value: number;
      readonly provenance: ProfileAnswerProvenance;
      readonly lane: "live_owner_fact";
    };

export interface DiscoveredIntakeField {
  readonly discoveredFieldId: string;
  readonly page:
    | "profile" | "questionnaire" | "voluntary_disclosures"
    | "self_identify" | "resume";
  readonly identity: string | "unresolved";
  readonly sanitizedLabel: string | null;
  readonly normalizedQuestionType:
    | "identity" | "address" | "phone" | "application_source"
    | "prior_employment" | "employment" | "education" | "authorization"
    | "legal" | "compensation" | "availability" | "demographic"
    | "attachment" | "skill" | "website" | "social_network" | "unknown";
  readonly behavior:
    | "text" | "textarea" | "date" | "radio" | "select" | "listbox"
    | "checkbox" | "file_upload" | "repeatable" | "search_select";
  readonly answerType:
    | "text" | "date" | "boolean" | "single_select"
    | "file" | "multi_select" | "repeatable";
  readonly uiVariant: string;
  readonly required: boolean | null;
  readonly allowedOptions: readonly string[];
  readonly allowsCustomValue: boolean;
  readonly constraints: {
    readonly maxBytes: number | null;
    readonly displayFormat: string | null;
  };
  readonly answer: { readonly kind: "profile_answer_missing" };
}

export type ApplicationProfileAnswerResult =
  | {
      readonly kind: "answered";
      readonly value: string | number | boolean;
      readonly provenance: ProfileAnswerProvenance;
      readonly lane: "live_owner_fact";
    }
  | { readonly kind: "profile_answer_missing" };

export interface ApplicationProfileQueryRequest {
  readonly profileId: ProfileId;
  readonly profileRevision: number;
  readonly factId: ApplicationProfileFactId;
}

export interface ApplicationProfileQuery {
  query(
    request: ApplicationProfileQueryRequest,
    signal: AbortSignal,
  ): Promise<PortResult<
    ApplicationProfileAnswerResult,
    ProfileQueryError | CancellationError
  >>;
}

export interface ApplicationAnswerResolutionRequest {
  readonly mode: AnswerExecutionMode;
  readonly field: FieldObservation;
  readonly profileId: ProfileId;
  readonly profileRevision: number;
  readonly resume: ResumeSelection;
  readonly resumeArtifact: ResolvedResumeArtifact;
}

export type ApplicationAnswerResolutionResult =
  | {
      readonly kind: "resolved";
      readonly intent: FieldIntent;
      readonly lane: AnswerProvenanceLane;
    }
  | { readonly kind: "profile_answer_missing"; readonly questionId: QuestionId }
  | { readonly kind: "option_no_match"; readonly questionId: QuestionId }
  | { readonly kind: "option_ambiguous"; readonly questionId: QuestionId }
  | { readonly kind: "unsupported"; readonly fieldId: FieldId };

export interface ApplicationAnswerResolver {
  resolve(
    request: ApplicationAnswerResolutionRequest,
    signal: AbortSignal,
  ): Promise<PortResult<
    ApplicationAnswerResolutionResult,
    AnswerResolutionError | CancellationError
  >>;
}

export type ApplicationAnswerProvenance = AnswerProvenance;
