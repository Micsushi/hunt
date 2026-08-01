import { ContractParseError } from "../serialized.ts";
import type { UiVariantId } from "./classification.ts";
import type {
  ClassificationLayer,
  ReviewedFixtureId,
  ReviewedPromotionRecordV1,
  ReviewerDecisionId,
  SanitizedStructuralObservationV1,
  SanitizedUnknownCandidateV1,
  SanitizedUnknownOutcome,
  SourceChangeId,
  StructuralObservationId,
  TestEvidenceId,
  UnknownCandidateId,
} from "./learning.ts";
import { classificationLayers } from "./learning.ts";
import {
  exact,
  identifier,
  nullableVariant,
  oneOf,
  orderedUniqueIdentifiers,
  parseLineage,
  parseTraits,
  revisionId,
  snapshot,
  structuralCount,
  versioned,
} from "./private/classification-serialized-primitives.ts";

const outcomesByLayer = {
  ats_family: ["ats_unsupported", "ats_unknown", "ats_ambiguous"],
  workday_page_type: ["workday_page_unknown", "workday_page_ambiguous"],
  ui_behavior: [
    "ui_behavior_unknown",
    "ui_behavior_ambiguous",
    "ui_variant_unreviewed",
  ],
  question: ["question_unknown", "question_ambiguous"],
  answer_type: ["answer_type_unknown", "answer_type_ambiguous"],
  visible_option: ["option_no_match", "option_ambiguous"],
} as const satisfies Record<
  ClassificationLayer,
  readonly SanitizedUnknownOutcome[]
>;

function validateVariant(
  layer: ClassificationLayer,
  value: UiVariantId | null,
  path: string,
): void {
  if (layer !== "ui_behavior" && value !== null) {
    throw new ContractParseError("invalid_value", path);
  }
}

export function parseSanitizedStructuralObservation(
  value: unknown,
): SanitizedStructuralObservationV1 {
  const input = versioned(snapshot(value), "$", [
    "observationId",
    "layer",
    "sourceRevisionId",
    "parentLineage",
    "traitIds",
    "observedVariantId",
    "controlCount",
    "requiredControlCount",
    "optionCount",
  ]);
  const layer = oneOf(input.layer, classificationLayers, "$.layer");
  const observedVariantId = nullableVariant(
    input.observedVariantId,
    "$.observedVariantId",
  );
  validateVariant(layer, observedVariantId, "$.observedVariantId");
  const controlCount = structuralCount(input.controlCount, "$.controlCount");
  const requiredControlCount = structuralCount(
    input.requiredControlCount,
    "$.requiredControlCount",
  );
  if (requiredControlCount > controlCount) {
    throw new ContractParseError("invalid_value", "$.requiredControlCount");
  }
  return {
    schemaVersion: 1,
    observationId: identifier(
      input.observationId,
      "structural_observation",
      "$.observationId",
    ) as StructuralObservationId,
    layer,
    sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
    parentLineage: parseLineage(input.parentLineage, layer, "$.parentLineage"),
    traitIds: parseTraits(input.traitIds, "$.traitIds"),
    observedVariantId,
    controlCount,
    requiredControlCount,
    optionCount: structuralCount(input.optionCount, "$.optionCount"),
  };
}

export function parseSanitizedUnknownCandidate(
  value: unknown,
): SanitizedUnknownCandidateV1 {
  const input = versioned(snapshot(value), "$", [
    "candidateId",
    "observationId",
    "layer",
    "outcome",
    "sourceRevisionId",
    "parentLineage",
    "traitIds",
    "observedVariantId",
    "controlCount",
    "requiredControlCount",
    "optionCount",
  ]);
  const layer = oneOf(input.layer, classificationLayers, "$.layer");
  const observedVariantId = nullableVariant(
    input.observedVariantId,
    "$.observedVariantId",
  );
  validateVariant(layer, observedVariantId, "$.observedVariantId");
  const outcome = oneOf(
    input.outcome,
    outcomesByLayer[layer],
    "$.outcome",
  ) as SanitizedUnknownOutcome;
  const controlCount = structuralCount(input.controlCount, "$.controlCount");
  const requiredControlCount = structuralCount(
    input.requiredControlCount,
    "$.requiredControlCount",
  );
  if (requiredControlCount > controlCount) {
    throw new ContractParseError("invalid_value", "$.requiredControlCount");
  }
  return {
    schemaVersion: 1,
    candidateId: identifier(
      input.candidateId,
      "unknown_candidate",
      "$.candidateId",
    ) as UnknownCandidateId,
    observationId: identifier(
      input.observationId,
      "structural_observation",
      "$.observationId",
    ) as StructuralObservationId,
    layer,
    outcome,
    sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
    parentLineage: parseLineage(input.parentLineage, layer, "$.parentLineage"),
    traitIds: parseTraits(input.traitIds, "$.traitIds"),
    observedVariantId,
    controlCount,
    requiredControlCount,
    optionCount: structuralCount(input.optionCount, "$.optionCount"),
  };
}

export function deriveSanitizedUnknownCandidate(
  value: unknown,
): SanitizedUnknownCandidateV1 {
  const input = exact(snapshot(value), "$", [
    "candidateId",
    "observation",
    "outcome",
  ]);
  const observation = parseSanitizedStructuralObservation(input.observation);
  return parseSanitizedUnknownCandidate({
    schemaVersion: 1,
    candidateId: input.candidateId,
    observationId: observation.observationId,
    layer: observation.layer,
    outcome: input.outcome,
    sourceRevisionId: observation.sourceRevisionId,
    parentLineage: observation.parentLineage,
    traitIds: observation.traitIds,
    observedVariantId: observation.observedVariantId,
    controlCount: observation.controlCount,
    requiredControlCount: observation.requiredControlCount,
    optionCount: observation.optionCount,
  });
}

export function parseReviewedPromotionRecord(
  value: unknown,
): ReviewedPromotionRecordV1 {
  const input = versioned(snapshot(value), "$", [
    "promotionId",
    "candidateId",
    "layer",
    "scope",
    "reviewerDecisionId",
    "reviewedFixtureIds",
    "testEvidenceIds",
    "sourceRevisionId",
    "decision",
    "sourceChangeId",
    "acceptedRevisionId",
  ]);
  const sourceRevisionId = revisionId(
    input.sourceRevisionId,
    "$.sourceRevisionId",
  );
  const decision = oneOf(
    input.decision,
    ["accepted", "rejected"],
    "$.decision",
  );
  const common = {
    schemaVersion: 1 as const,
    promotionId: identifier(
      input.promotionId,
      "promotion",
      "$.promotionId",
    ),
    candidateId: identifier(
      input.candidateId,
      "unknown_candidate",
      "$.candidateId",
    ) as UnknownCandidateId,
    layer: oneOf(input.layer, classificationLayers, "$.layer"),
    scope: oneOf(input.scope, ["between_runs"], "$.scope"),
    reviewerDecisionId: identifier(
      input.reviewerDecisionId,
      "reviewer_decision",
      "$.reviewerDecisionId",
    ) as ReviewerDecisionId,
    reviewedFixtureIds: orderedUniqueIdentifiers(
      input.reviewedFixtureIds,
      "reviewed_fixture",
      "$.reviewedFixtureIds",
    ) as readonly ReviewedFixtureId[],
    testEvidenceIds: orderedUniqueIdentifiers(
      input.testEvidenceIds,
      "test_evidence",
      "$.testEvidenceIds",
    ) as readonly TestEvidenceId[],
    sourceRevisionId,
  };
  if (decision === "accepted") {
    const sourceChangeId = identifier(
      input.sourceChangeId,
      "source_change",
      "$.sourceChangeId",
    ) as SourceChangeId;
    const acceptedRevisionId = revisionId(
      input.acceptedRevisionId,
      "$.acceptedRevisionId",
    );
    if (acceptedRevisionId === sourceRevisionId) {
      throw new ContractParseError("invalid_value", "$.acceptedRevisionId");
    }
    return {
      ...common,
      decision,
      sourceChangeId,
      acceptedRevisionId,
    } as ReviewedPromotionRecordV1;
  }
  if (input.sourceChangeId !== null) {
    throw new ContractParseError("invalid_value", "$.sourceChangeId");
  }
  if (input.acceptedRevisionId !== null) {
    throw new ContractParseError("invalid_value", "$.acceptedRevisionId");
  }
  return {
    ...common,
    decision,
    sourceChangeId: null,
    acceptedRevisionId: null,
  } as ReviewedPromotionRecordV1;
}
