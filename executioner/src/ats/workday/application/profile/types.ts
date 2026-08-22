import type { ProfileAnswerProvenance } from "../../../../contracts/index.ts";
import type {
  AnswerExecutionMode,
  AnswerProvenanceLane,
} from "../../../../form/answers/application-types.ts";

export type ProfileFieldAnswerProvenance =
  | ProfileAnswerProvenance
  | "generated_default"
  | "journey_derived";

export const profilePageTypes = ["profile", "contact"] as const;
export type ProfilePageType = (typeof profilePageTypes)[number];

export const profileRepeatableSections = [
  "experience",
  "education",
  "skills",
  "websites",
] as const;
export type ProfileRepeatableSection = (typeof profileRepeatableSections)[number];

export type ProfileQuestionType =
  | "identity"
  | "address"
  | "phone"
  | "application_source"
  | "prior_employment"
  | "employment"
  | "experience"
  | "education"
  | "skill"
  | "language"
  | "website"
  | "social_network";
export type ProfileCanonicalAnswerType =
  | "text"
  | "phone"
  | "date"
  | "month"
  | "year"
  | "number"
  | "url"
  | "boolean"
  | "option"
  | "single_select"
  | "multi_select";
export type ProfileUiBehavior =
  | "checkbox"
  | "file"
  | "text"
  | "textarea"
  | "phone"
  | "date"
  | "month"
  | "year"
  | "number"
  | "url"
  | "select"
  | "multi_select"
  | "search_select"
  | "radio_group";

export type ProfileFieldAnswer =
  | {
      readonly kind: "answered";
      readonly value: string;
      readonly provenance: ProfileFieldAnswerProvenance;
      readonly lane: AnswerProvenanceLane;
    }
  | { readonly kind: "profile_answer_missing" };

export interface ProfileOptionMapping {
  readonly canonicalValue: string;
  readonly visibleOption: string;
  readonly provenance: "visible_option";
}

export interface ProfileFieldPlan {
  readonly fieldId: string;
  readonly questionType: ProfileQuestionType;
  readonly answerType: ProfileCanonicalAnswerType;
  readonly allowedOptions: readonly string[];
  readonly answer: ProfileFieldAnswer;
  readonly optionMapping?: ProfileOptionMapping;
}

export interface ProfileRepeatableRowPlan {
  readonly rowKey: string;
  readonly fields: readonly ProfileFieldPlan[];
}

export interface ProfileRepeatablePlan {
  readonly section: ProfileRepeatableSection;
  readonly rows: readonly ProfileRepeatableRowPlan[];
}

export interface ProfilePagePlan {
  readonly mode: AnswerExecutionMode;
  readonly pageType: ProfilePageType;
  readonly fields: readonly ProfileFieldPlan[];
  readonly repeatables: readonly ProfileRepeatablePlan[];
}

export interface ProfileControlSnapshot {
  readonly controlId: string;
  readonly fieldId: string;
  readonly required: boolean;
  readonly uiBehavior: ProfileUiBehavior;
  readonly uiVariant: string;
  readonly readback: string | null;
}

export interface ProfileRowSnapshot {
  readonly section: ProfileRepeatableSection;
  readonly rowId: string;
  readonly ownedByC3: boolean;
  readonly controls: readonly ProfileControlSnapshot[];
}

export interface ProfilePageSnapshot {
  readonly pageType: ProfilePageType;
  readonly controls: readonly ProfileControlSnapshot[];
  readonly rows: readonly ProfileRowSnapshot[];
  readonly repeatableSections?: readonly ProfileRepeatableSection[];
}

export interface ProfileCommitRequest {
  readonly controlId: string;
  readonly uiBehavior: ProfileUiBehavior;
  readonly value: string;
}

export interface ProfileInteractionSnapshot {
  readonly popupBound: boolean | null;
  readonly optionFocused: boolean | null;
  readonly optionActivated: boolean | null;
  readonly popupClosed: boolean | null;
  readonly backingValueCommitted: boolean;
  readonly validationCleared: boolean;
  readonly visibleOptionCount: number | null;
  readonly selectedOptionOrdinal: number | null;
}

export interface WorkdayProfilePagePort {
  inspect(signal: AbortSignal): Promise<ProfilePageSnapshot>;
  commit(request: ProfileCommitRequest, signal: AbortSignal): Promise<void>;
  addOwnedRow(
    section: ProfileRepeatableSection,
    signal: AbortSignal,
  ): Promise<string>;
  removeOwnedRow(
    section: ProfileRepeatableSection,
    rowId: string,
    signal: AbortSignal,
  ): Promise<void>;
  interaction?(controlId: string): ProfileInteractionSnapshot | undefined;
}

export interface VerifiedProfileField {
  readonly fieldId: string;
  readonly questionType: ProfileQuestionType;
  readonly answerType: ProfileCanonicalAnswerType;
  readonly uiBehavior: ProfileUiBehavior;
  readonly uiVariant: string;
  readonly provenance: ProfileFieldAnswerProvenance;
  readonly lane: AnswerProvenanceLane;
  readonly optionMappingProvenance?: "visible_option";
  readonly rowKey?: string;
}

export type ProfilePageCompletionResult =
  | {
      readonly kind: "verified";
      readonly pageType: ProfilePageType;
      readonly verifiedFields: readonly VerifiedProfileField[];
      readonly ownedDuplicateRows: 0;
    }
  | {
      readonly kind: "blocked";
      readonly code:
        | "answer_type_unknown"
        | "operation_cancelled"
        | "profile_answer_missing"
        | "profile_answer_provenance_denied"
        | "profile_commit_unverified"
        | "profile_control_ambiguous"
        | "profile_control_missing"
        | "profile_page_mismatch"
        | "profile_plan_invalid"
        | "profile_port_unavailable"
        | "profile_row_unverified"
        | "profile_ui_behavior_mismatch"
        | "profile_ui_variant_unreviewed";
      readonly fieldId?: string;
      readonly uiBehavior?: ProfileUiBehavior;
      readonly uiVariant?: string;
    };
