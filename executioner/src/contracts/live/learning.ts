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
export type ReviewerDecisionId = LearningIdentifier<"reviewer_decision">;
export type ReviewedFixtureId = LearningIdentifier<"reviewed_fixture">;
export type TestEvidenceId = LearningIdentifier<"test_evidence">;
export type SourceChangeId = LearningIdentifier<"source_change">;

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
  readonly sourceRevisionId: ClassificationRevisionId;
  readonly parentLineage: readonly ClassificationLineageV1[];
  readonly traitIds: readonly StructuralTraitId[];
  readonly observedVariantId: UiVariantId | null;
  readonly controlCount: number;
  readonly requiredControlCount: number;
  readonly optionCount: number;
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
  | "option_no_match"
  | "option_ambiguous";

export interface SanitizedUnknownCandidateV1 {
  readonly schemaVersion: 1;
  readonly candidateId: UnknownCandidateId;
  readonly observationId: StructuralObservationId;
  readonly layer: ClassificationLayer;
  readonly outcome: SanitizedUnknownOutcome;
  readonly sourceRevisionId: ClassificationRevisionId;
  readonly parentLineage: readonly ClassificationLineageV1[];
  readonly traitIds: readonly StructuralTraitId[];
  readonly observedVariantId: UiVariantId | null;
  readonly controlCount: number;
  readonly requiredControlCount: number;
  readonly optionCount: number;
}

interface ReviewedPromotionEvidenceV1 {
  readonly schemaVersion: 1;
  readonly promotionId: PromotionId;
  readonly candidateId: UnknownCandidateId;
  readonly layer: ClassificationLayer;
  readonly scope: "between_runs";
  readonly reviewerDecisionId: ReviewerDecisionId;
  readonly reviewedFixtureIds: readonly ReviewedFixtureId[];
  readonly testEvidenceIds: readonly TestEvidenceId[];
  readonly sourceRevisionId: ClassificationRevisionId;
}

export type ReviewedPromotionRecordV1 =
  | (ReviewedPromotionEvidenceV1 & {
      readonly decision: "accepted";
      readonly sourceChangeId: SourceChangeId;
      readonly acceptedRevisionId: ClassificationRevisionId;
    })
  | (ReviewedPromotionEvidenceV1 & {
      readonly decision: "rejected";
      readonly sourceChangeId: null;
      readonly acceptedRevisionId: null;
    });
