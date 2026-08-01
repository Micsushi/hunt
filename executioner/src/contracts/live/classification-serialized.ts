import { copyContractDataGraph } from "../admission.ts";
import { ContractParseError } from "../serialized.ts";
import { optionId, questionId, uiBehaviorIds } from "../types.ts";
import type {
  AnswerProvenanceId,
  AnswerSourceRevisionId,
  AtsFamilyClassificationResultV1,
  AtsFamilyId,
  CanonicalAnswerProvenanceV1,
  CanonicalAnswerTypeClassificationResultV1,
  ClassificationId,
  ClassificationRevisionId,
  QuestionClassificationResultV1,
  UiBehaviorClassificationResultV1,
  UiVariantId,
  VisibleOptionMappingResultV1,
  WorkdayPageTypeClassificationResultV1,
} from "./classification.ts";
import {
  answerProvenanceSources,
  canonicalAnswerTypes,
  workdayPageTypes,
} from "./classification.ts";
import type {
  ClassificationLayer,
  ClassificationLineageV1,
  LearningIdentifier,
  ReviewedPromotionRecordV1,
  SanitizedStructuralObservationV1,
  SanitizedUnknownCandidateV1,
  SanitizedUnknownOutcome,
  StructuralObservationId,
  StructuralTraitId,
  UnknownCandidateId,
} from "./learning.ts";
import { classificationLayers } from "./learning.ts";

type JsonObject = Record<string, unknown>;

function snapshot(value: unknown): unknown {
  const copied = copyContractDataGraph(value);
  if (!copied.ok) throw new ContractParseError("invalid_type", "$");
  return copied.value;
}

function record(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractParseError("invalid_type", path);
  }
  return value as JsonObject;
}

function exact(
  value: unknown,
  path: string,
  required: readonly string[],
): JsonObject {
  const input = record(value, path);
  for (const key of required) {
    if (!Object.hasOwn(input, key)) {
      throw new ContractParseError("missing_key", `${path}.${key}`);
    }
  }
  const allowed = new Set(required);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new ContractParseError("extra_key", `${path}.${key}`);
    }
  }
  return input;
}

function versioned(
  value: unknown,
  path: string,
  required: readonly string[],
): JsonObject {
  const input = exact(value, path, ["schemaVersion", ...required]);
  if (input.schemaVersion !== 1) {
    throw new ContractParseError(
      typeof input.schemaVersion === "number"
        ? "incompatible_version"
        : "invalid_type",
      `${path}.schemaVersion`,
    );
  }
  return input;
}

function oneOf<const T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  if (!(values as readonly string[]).includes(value)) {
    throw new ContractParseError("invalid_value", path);
  }
  return value as T;
}

function identifier<Kind extends string>(
  value: unknown,
  prefix: string,
  path: string,
): LearningIdentifier<Kind> {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  const expression = new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`, "u");
  if (!expression.test(value)) {
    throw new ContractParseError("invalid_value", path);
  }
  return value as LearningIdentifier<Kind>;
}

function classificationId(value: unknown, path: string): ClassificationId {
  return identifier(value, "classification", path) as unknown as ClassificationId;
}

function revisionId(
  value: unknown,
  path: string,
): ClassificationRevisionId {
  return identifier(
    value,
    "classification_revision",
    path,
  ) as unknown as ClassificationRevisionId;
}

function uiVariantId(value: unknown, path: string): UiVariantId {
  return identifier(value, "ui_variant", path) as unknown as UiVariantId;
}

function nullableVariant(value: unknown, path: string): UiVariantId | null {
  return value === null ? null : uiVariantId(value, path);
}

function parseQuestionId(value: unknown, path: string) {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  try {
    return questionId(value);
  } catch {
    throw new ContractParseError("invalid_value", path);
  }
}

function parseOptionId(value: unknown, path: string) {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  try {
    return optionId(value);
  } catch {
    throw new ContractParseError("invalid_value", path);
  }
}

function parseLineage(
  value: unknown,
  layer: ClassificationLayer,
  path: string,
): readonly ClassificationLineageV1[] {
  if (!Array.isArray(value)) {
    throw new ContractParseError("invalid_type", path);
  }
  const layerIndex = classificationLayers.indexOf(layer);
  if (value.length !== layerIndex) {
    throw new ContractParseError("invalid_value", path);
  }
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const input = exact(entry, entryPath, ["layer", "classificationId"]);
    const expectedLayer = classificationLayers[index];
    const parsedLayer = oneOf(input.layer, classificationLayers, `${entryPath}.layer`);
    if (parsedLayer !== expectedLayer) {
      throw new ContractParseError("invalid_value", `${entryPath}.layer`);
    }
    return {
      layer: parsedLayer,
      classificationId: classificationId(
        input.classificationId,
        `${entryPath}.classificationId`,
      ),
    };
  });
}

function parseTraits(value: unknown, path: string): readonly StructuralTraitId[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new ContractParseError(
      Array.isArray(value) ? "invalid_value" : "invalid_type",
      path,
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const parsed = identifier(
      entry,
      "structural_trait",
      entryPath,
    ) as StructuralTraitId;
    if (seen.has(parsed)) {
      throw new ContractParseError("invalid_value", entryPath);
    }
    seen.add(parsed);
    return parsed;
  });
}

const outcomesByLayer = {
  ats_family: ["ats_unsupported", "ats_unknown", "ats_ambiguous"],
  workday_page_type: ["workday_page_unknown", "workday_page_ambiguous"],
  ui_behavior: [
    "ui_behavior_unknown",
    "ui_behavior_ambiguous",
    "ui_variant_unreviewed",
  ],
  question: ["question_unknown", "question_ambiguous"],
  answer_type: [
    "answer_type_unknown",
    "answer_type_ambiguous",
    "profile_answer_missing",
  ],
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
    "parentLineage",
    "traitIds",
    "observedVariantId",
  ]);
  const layer = oneOf(input.layer, classificationLayers, "$.layer");
  const observedVariantId = nullableVariant(
    input.observedVariantId,
    "$.observedVariantId",
  );
  validateVariant(layer, observedVariantId, "$.observedVariantId");
  return {
    schemaVersion: 1,
    observationId: identifier(
      input.observationId,
      "structural_observation",
      "$.observationId",
    ) as StructuralObservationId,
    layer,
    parentLineage: parseLineage(input.parentLineage, layer, "$.parentLineage"),
    traitIds: parseTraits(input.traitIds, "$.traitIds"),
    observedVariantId,
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
    "parentLineage",
    "traitIds",
    "observedVariantId",
  ]);
  const layer = oneOf(input.layer, classificationLayers, "$.layer");
  const observedVariantId = nullableVariant(
    input.observedVariantId,
    "$.observedVariantId",
  );
  validateVariant(layer, observedVariantId, "$.observedVariantId");
  const allowedOutcomes = outcomesByLayer[layer];
  const outcome = oneOf(
    input.outcome,
    allowedOutcomes,
    "$.outcome",
  ) as SanitizedUnknownOutcome;
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
    parentLineage: parseLineage(input.parentLineage, layer, "$.parentLineage"),
    traitIds: parseTraits(input.traitIds, "$.traitIds"),
    observedVariantId,
  };
}

export function parseReviewedPromotionRecord(
  value: unknown,
): ReviewedPromotionRecordV1 {
  const input = versioned(snapshot(value), "$", [
    "promotionId",
    "candidateId",
    "layer",
    "scope",
    "sourceRevisionId",
    "decision",
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
    sourceRevisionId,
  };
  if (decision === "accepted") {
    const acceptedRevisionId = revisionId(
      input.acceptedRevisionId,
      "$.acceptedRevisionId",
    );
    if (acceptedRevisionId === sourceRevisionId) {
      throw new ContractParseError("invalid_value", "$.acceptedRevisionId");
    }
    return { ...common, decision, acceptedRevisionId } as ReviewedPromotionRecordV1;
  }
  if (input.acceptedRevisionId !== null) {
    throw new ContractParseError("invalid_value", "$.acceptedRevisionId");
  }
  return { ...common, decision, acceptedRevisionId: null } as ReviewedPromotionRecordV1;
}

function factualResult(
  value: unknown,
  kinds: readonly string[],
): { readonly schemaVersion: 1; readonly kind: string } | undefined {
  const input = record(value, "$");
  if (input.schemaVersion === 1 && typeof input.kind === "string" && kinds.includes(input.kind)) {
    exact(input, "$", ["schemaVersion", "kind"]);
    return { schemaVersion: 1, kind: input.kind };
  }
  return undefined;
}

export function parseAtsFamilyClassificationResult(
  value: unknown,
): AtsFamilyClassificationResultV1 {
  const copied = snapshot(value);
  const factual = factualResult(copied, ["ats_unknown", "ats_ambiguous"]);
  if (factual !== undefined) return factual as AtsFamilyClassificationResultV1;
  const base = record(copied, "$");
  if (base.kind === "classified") {
    const input = versioned(base, "$", ["kind", "atsFamily", "classificationId", "sourceRevisionId"]);
    return {
      schemaVersion: 1,
      kind: oneOf(input.kind, ["classified"], "$.kind"),
      atsFamily: oneOf(input.atsFamily, ["workday"], "$.atsFamily"),
      classificationId: classificationId(input.classificationId, "$.classificationId"),
      sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
    };
  }
  const input = versioned(base, "$", ["kind", "familyId", "sourceRevisionId"]);
  return {
    schemaVersion: 1,
    kind: oneOf(input.kind, ["ats_unsupported"], "$.kind"),
    familyId: identifier(input.familyId, "ats_family", "$.familyId") as unknown as AtsFamilyId,
    sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
  };
}

export function parseWorkdayPageTypeClassificationResult(
  value: unknown,
): WorkdayPageTypeClassificationResultV1 {
  const copied = snapshot(value);
  const factual = factualResult(copied, ["workday_page_unknown", "workday_page_ambiguous"]);
  if (factual !== undefined) return factual as WorkdayPageTypeClassificationResultV1;
  const input = versioned(copied, "$", ["kind", "pageType", "classificationId", "sourceRevisionId"]);
  return {
    schemaVersion: 1,
    kind: oneOf(input.kind, ["classified"], "$.kind"),
    pageType: oneOf(input.pageType, workdayPageTypes, "$.pageType"),
    classificationId: classificationId(input.classificationId, "$.classificationId"),
    sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
  };
}

export function parseUiBehaviorClassificationResult(
  value: unknown,
): UiBehaviorClassificationResultV1 {
  const copied = snapshot(value);
  const factual = factualResult(copied, ["ui_behavior_unknown", "ui_behavior_ambiguous"]);
  if (factual !== undefined) return factual as UiBehaviorClassificationResultV1;
  const base = record(copied, "$");
  if (base.kind === "ui_variant_unreviewed") {
    const input = versioned(base, "$", ["kind", "variantId"]);
    return {
      schemaVersion: 1,
      kind: oneOf(input.kind, ["ui_variant_unreviewed"], "$.kind"),
      variantId: uiVariantId(input.variantId, "$.variantId"),
    };
  }
  const input = versioned(base, "$", ["kind", "behavior", "reviewedVariantId", "classificationId", "sourceRevisionId"]);
  return {
    schemaVersion: 1,
    kind: oneOf(input.kind, ["classified"], "$.kind"),
    behavior: oneOf(input.behavior, uiBehaviorIds, "$.behavior"),
    reviewedVariantId: uiVariantId(input.reviewedVariantId, "$.reviewedVariantId"),
    classificationId: classificationId(input.classificationId, "$.classificationId"),
    sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
  };
}

export function parseQuestionClassificationResult(
  value: unknown,
): QuestionClassificationResultV1 {
  const copied = snapshot(value);
  const factual = factualResult(copied, ["question_unknown", "question_ambiguous"]);
  if (factual !== undefined) return factual as QuestionClassificationResultV1;
  const input = versioned(copied, "$", ["kind", "questionId", "classificationId", "sourceRevisionId"]);
  return {
    schemaVersion: 1,
    kind: oneOf(input.kind, ["classified"], "$.kind"),
    questionId: parseQuestionId(input.questionId, "$.questionId"),
    classificationId: classificationId(input.classificationId, "$.classificationId"),
    sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
  };
}

function parseProvenance(value: unknown, path: string): CanonicalAnswerProvenanceV1 {
  const input = versioned(value, path, ["provenanceId", "source", "sourceRevisionId"]);
  return {
    schemaVersion: 1,
    provenanceId: identifier(input.provenanceId, "answer_provenance", `${path}.provenanceId`) as unknown as AnswerProvenanceId,
    source: oneOf(input.source, answerProvenanceSources, `${path}.source`),
    sourceRevisionId: identifier(input.sourceRevisionId, "answer_source_revision", `${path}.sourceRevisionId`) as unknown as AnswerSourceRevisionId,
  };
}

export function parseCanonicalAnswerTypeClassificationResult(
  value: unknown,
): CanonicalAnswerTypeClassificationResultV1 {
  const copied = snapshot(value);
  const base = record(copied, "$");
  if (["answer_type_unknown", "answer_type_ambiguous", "profile_answer_missing"].includes(String(base.kind))) {
    const input = versioned(base, "$", ["kind", "questionId"]);
    return {
      schemaVersion: 1,
      kind: oneOf(input.kind, ["answer_type_unknown", "answer_type_ambiguous", "profile_answer_missing"], "$.kind"),
      questionId: parseQuestionId(input.questionId, "$.questionId"),
    };
  }
  const input = versioned(base, "$", ["kind", "questionId", "answerType", "provenance"]);
  return {
    schemaVersion: 1,
    kind: oneOf(input.kind, ["classified"], "$.kind"),
    questionId: parseQuestionId(input.questionId, "$.questionId"),
    answerType: oneOf(input.answerType, canonicalAnswerTypes, "$.answerType"),
    provenance: parseProvenance(input.provenance, "$.provenance"),
  };
}

export function parseVisibleOptionMappingResult(
  value: unknown,
): VisibleOptionMappingResultV1 {
  const copied = snapshot(value);
  const base = record(copied, "$");
  if (["option_no_match", "option_ambiguous"].includes(String(base.kind))) {
    const input = versioned(base, "$", ["kind", "questionId"]);
    return {
      schemaVersion: 1,
      kind: oneOf(input.kind, ["option_no_match", "option_ambiguous"], "$.kind"),
      questionId: parseQuestionId(input.questionId, "$.questionId"),
    };
  }
  const input = versioned(base, "$", ["kind", "questionId", "optionId", "sourceRevisionId"]);
  return {
    schemaVersion: 1,
    kind: oneOf(input.kind, ["mapped"], "$.kind"),
    questionId: parseQuestionId(input.questionId, "$.questionId"),
    optionId: parseOptionId(input.optionId, "$.optionId"),
    sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
  };
}
