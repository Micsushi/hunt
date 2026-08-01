import type {
  ClassificationId,
  ClassificationRevisionId,
  UiVariantId,
} from "./classification.ts";

declare const learningIdentifierBrand: unique symbol;
export type LearningIdentifier<Kind extends string> = string & {
  readonly [learningIdentifierBrand]: Kind;
};

export type StructuralObservationId =
  LearningIdentifier<"structural_observation">;
export type StructuralTraitId = LearningIdentifier<"structural_trait">;
export type UnknownCandidateId = LearningIdentifier<"unknown_candidate">;
export type PromotionId = LearningIdentifier<"promotion">;

export const classificationLayers = [
  "ats_family",
  "workday_page_type",
  "ui_behavior",
  "question",
  "answer_type",
  "visible_option",
] as const;
export type ClassificationLayer = (typeof classificationLayers)[number];

export interface ClassificationLineageV1 {
  readonly layer: ClassificationLayer;
  readonly classificationId: ClassificationId;
}

export interface SanitizedStructuralObservationV1 {
  readonly schemaVersion: 1;
  readonly observationId: StructuralObservationId;
  readonly layer: ClassificationLayer;
  readonly parentLineage: readonly ClassificationLineageV1[];
  readonly traitIds: readonly StructuralTraitId[];
  readonly observedVariantId: UiVariantId | null;
}

export type SanitizedUnknownOutcome =
  | "ats_unsupported"
  | "ats_unknown"
  | "ats_ambiguous"
  | "workday_page_unknown"
  | "workday_page_ambiguous"
  | "ui_behavior_unknown"
  | "ui_behavior_ambiguous"
  | "ui_variant_unreviewed"
  | "question_unknown"
  | "question_ambiguous"
  | "answer_type_unknown"
  | "answer_type_ambiguous"
  | "profile_answer_missing"
  | "option_no_match"
  | "option_ambiguous";

export interface SanitizedUnknownCandidateV1 {
  readonly schemaVersion: 1;
  readonly candidateId: UnknownCandidateId;
  readonly observationId: StructuralObservationId;
  readonly layer: ClassificationLayer;
  readonly outcome: SanitizedUnknownOutcome;
  readonly parentLineage: readonly ClassificationLineageV1[];
  readonly traitIds: readonly StructuralTraitId[];
  readonly observedVariantId: UiVariantId | null;
}

export type ReviewedPromotionRecordV1 =
  | {
      readonly schemaVersion: 1;
      readonly promotionId: PromotionId;
      readonly candidateId: UnknownCandidateId;
      readonly layer: ClassificationLayer;
      readonly scope: "between_runs";
      readonly sourceRevisionId: ClassificationRevisionId;
      readonly decision: "accepted";
      readonly acceptedRevisionId: ClassificationRevisionId;
    }
  | {
      readonly schemaVersion: 1;
      readonly promotionId: PromotionId;
      readonly candidateId: UnknownCandidateId;
      readonly layer: ClassificationLayer;
      readonly scope: "between_runs";
      readonly sourceRevisionId: ClassificationRevisionId;
      readonly decision: "rejected";
      readonly acceptedRevisionId: null;
    };
