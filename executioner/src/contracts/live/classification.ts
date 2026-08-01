import type {
  CancellationError,
  OptionId,
  PortResult,
  QuestionId,
  UiBehaviorId,
} from "../types.ts";
import type { SanitizedStructuralObservationV1 } from "./learning.ts";
import type { S2PortError } from "./types.ts";

declare const classificationIdentifierBrand: unique symbol;
export type ClassificationIdentifier<Kind extends string> = string & {
  readonly [classificationIdentifierBrand]: Kind;
};

export type ClassificationId = ClassificationIdentifier<"classification">;
export type ClassificationRevisionId =
  ClassificationIdentifier<"classification_revision">;
export type AtsFamilyId = ClassificationIdentifier<"ats_family">;
export type UiVariantId = ClassificationIdentifier<"ui_variant">;
export type AnswerProvenanceId =
  ClassificationIdentifier<"answer_provenance">;
export type AnswerSourceRevisionId =
  ClassificationIdentifier<"answer_source_revision">;

export const workdayPageTypes = [
  "job_posting",
  "account_entry",
  "email_verification",
  "candidate_home",
  "profile",
  "questionnaire",
  "review",
] as const;
export type WorkdayPageType = (typeof workdayPageTypes)[number];

export const canonicalAnswerTypes = [
  "text",
  "boolean",
  "number",
  "iso_date",
  "single_choice",
  "multi_choice",
  "resume_artifact",
] as const;
export type CanonicalAnswerType = (typeof canonicalAnswerTypes)[number];

export const answerProvenanceSources = [
  "profile",
  "resume",
  "job",
  "reviewed_catalog",
  "approved_template",
] as const;
export type AnswerProvenanceSource =
  (typeof answerProvenanceSources)[number];

export interface CanonicalAnswerProvenanceV1 {
  readonly schemaVersion: 1;
  readonly provenanceId: AnswerProvenanceId;
  readonly source: AnswerProvenanceSource;
  readonly sourceRevisionId: AnswerSourceRevisionId;
}

export interface AtsFamilyClassificationRequestV1 {
  readonly schemaVersion: 1;
  readonly observation: SanitizedStructuralObservationV1 & {
    readonly layer: "ats_family";
  };
}

export type AtsFamilyClassificationResultV1 =
  | {
      readonly schemaVersion: 1;
      readonly kind: "classified";
      readonly atsFamily: "workday";
      readonly classificationId: ClassificationId;
      readonly sourceRevisionId: ClassificationRevisionId;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "ats_unsupported";
      readonly familyId: AtsFamilyId;
      readonly sourceRevisionId: ClassificationRevisionId;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "ats_unknown" | "ats_ambiguous";
      readonly sourceRevisionId: ClassificationRevisionId;
    };

export interface AtsFamilyClassifier {
  classify(
    request: AtsFamilyClassificationRequestV1,
    signal: AbortSignal,
  ): Promise<PortResult<AtsFamilyClassificationResultV1, CancellationError>>;
}

export interface WorkdayPageTypeClassificationRequestV1 {
  readonly schemaVersion: 1;
  readonly atsFamilyClassificationId: ClassificationId;
  readonly observation: SanitizedStructuralObservationV1 & {
    readonly layer: "workday_page_type";
  };
}

export type WorkdayPageTypeClassificationResultV1 =
  | {
      readonly schemaVersion: 1;
      readonly kind: "classified";
      readonly pageType: WorkdayPageType;
      readonly classificationId: ClassificationId;
      readonly sourceRevisionId: ClassificationRevisionId;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "workday_page_unknown" | "workday_page_ambiguous";
      readonly sourceRevisionId: ClassificationRevisionId;
    };

export interface WorkdayPageTypeClassifier {
  classify(
    request: WorkdayPageTypeClassificationRequestV1,
    signal: AbortSignal,
  ): Promise<
    PortResult<WorkdayPageTypeClassificationResultV1, CancellationError>
  >;
}

export interface UiBehaviorClassificationRequestV1 {
  readonly schemaVersion: 1;
  readonly pageTypeClassificationId: ClassificationId;
  readonly observation: SanitizedStructuralObservationV1 & {
    readonly layer: "ui_behavior";
  };
}

export type UiBehaviorClassificationResultV1 =
  | {
      readonly schemaVersion: 1;
      readonly kind: "classified";
      readonly behavior: UiBehaviorId;
      readonly reviewedVariantId: UiVariantId;
      readonly classificationId: ClassificationId;
      readonly sourceRevisionId: ClassificationRevisionId;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "ui_behavior_unknown" | "ui_behavior_ambiguous";
      readonly sourceRevisionId: ClassificationRevisionId;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "ui_variant_unreviewed";
      readonly variantId: UiVariantId;
      readonly sourceRevisionId: ClassificationRevisionId;
    };

export interface UiBehaviorClassifier {
  classify(
    request: UiBehaviorClassificationRequestV1,
    signal: AbortSignal,
  ): Promise<PortResult<UiBehaviorClassificationResultV1, CancellationError>>;
}

export interface QuestionClassificationRequestV1 {
  readonly schemaVersion: 1;
  readonly uiBehaviorClassificationId: ClassificationId;
  readonly observation: SanitizedStructuralObservationV1 & {
    readonly layer: "question";
  };
}

export type QuestionClassificationResultV1 =
  | {
      readonly schemaVersion: 1;
      readonly kind: "classified";
      readonly questionId: QuestionId;
      readonly classificationId: ClassificationId;
      readonly sourceRevisionId: ClassificationRevisionId;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "question_unknown" | "question_ambiguous";
      readonly sourceRevisionId: ClassificationRevisionId;
    };

export interface QuestionClassifier {
  classify(
    request: QuestionClassificationRequestV1,
    signal: AbortSignal,
  ): Promise<PortResult<QuestionClassificationResultV1, CancellationError>>;
}

export interface CanonicalAnswerTypeClassificationRequestV1 {
  readonly schemaVersion: 1;
  readonly questionClassificationId: ClassificationId;
  readonly questionId: QuestionId;
  readonly observation: SanitizedStructuralObservationV1 & {
    readonly layer: "answer_type";
  };
}

export type CanonicalAnswerTypeClassificationResultV1 =
  | {
      readonly schemaVersion: 1;
      readonly kind: "classified";
      readonly answerType: CanonicalAnswerType;
      readonly classificationId: ClassificationId;
      readonly sourceRevisionId: ClassificationRevisionId;
      readonly provenance: CanonicalAnswerProvenanceV1;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind:
        | "answer_type_unknown"
        | "answer_type_ambiguous"
        | "profile_answer_missing";
      readonly sourceRevisionId: ClassificationRevisionId;
    };

export type CanonicalAnswerTypeClassificationError =
  | S2PortError<"answer_provenance_invalid">
  | CancellationError;

export interface CanonicalAnswerTypeClassifier {
  classify(
    request: CanonicalAnswerTypeClassificationRequestV1,
    signal: AbortSignal,
  ): Promise<
    PortResult<
      CanonicalAnswerTypeClassificationResultV1,
      CanonicalAnswerTypeClassificationError
    >
  >;
}

export interface VisibleOptionMappingRequestV1 {
  readonly schemaVersion: 1;
  readonly questionId: QuestionId;
  readonly answerTypeClassificationId: ClassificationId;
  readonly canonicalOptionId: OptionId;
  readonly visibleOptionIds: readonly OptionId[];
  readonly observation: SanitizedStructuralObservationV1 & {
    readonly layer: "visible_option";
  };
}

export type VisibleOptionMappingResultV1 =
  | {
      readonly schemaVersion: 1;
      readonly kind: "mapped";
      readonly optionId: OptionId;
      readonly classificationId: ClassificationId;
      readonly sourceRevisionId: ClassificationRevisionId;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "option_no_match" | "option_ambiguous";
      readonly sourceRevisionId: ClassificationRevisionId;
    };

export interface VisibleOptionMapper {
  map(
    request: VisibleOptionMappingRequestV1,
    signal: AbortSignal,
  ): Promise<PortResult<VisibleOptionMappingResultV1, CancellationError>>;
}
