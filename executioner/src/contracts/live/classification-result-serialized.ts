import { uiBehaviorIds } from "../types.ts";
import type {
  AnswerProvenanceId,
  AnswerSourceRevisionId,
  AtsFamilyClassificationResultV1,
  AtsFamilyId,
  CanonicalAnswerProvenanceV1,
  CanonicalAnswerTypeClassificationResultV1,
  ClassificationRevisionId,
  QuestionClassificationResultV1,
  UiBehaviorClassificationResultV1,
  VisibleOptionMappingResultV1,
  WorkdayPageTypeClassificationResultV1,
} from "./classification.ts";
import {
  answerProvenanceSources,
  canonicalAnswerTypes,
  workdayPageTypes,
} from "./classification.ts";
import {
  classificationId,
  identifier,
  oneOf,
  parseOptionId,
  parseQuestionId,
  record,
  revisionId,
  snapshot,
  uiVariantId,
  versioned,
} from "./private/classification-serialized-primitives.ts";

function factualResult(
  value: unknown,
  kinds: readonly string[],
): {
  readonly schemaVersion: 1;
  readonly kind: string;
  readonly sourceRevisionId: ClassificationRevisionId;
} | undefined {
  const input = record(value, "$");
  if (input.schemaVersion === 1 && typeof input.kind === "string" && kinds.includes(input.kind)) {
    const exactInput = versioned(input, "$", ["kind", "sourceRevisionId"]);
    return {
      schemaVersion: 1,
      kind: exactInput.kind as string,
      sourceRevisionId: revisionId(
        exactInput.sourceRevisionId,
        "$.sourceRevisionId",
      ),
    };
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
    const input = versioned(base, "$", ["kind", "variantId", "sourceRevisionId"]);
    return {
      schemaVersion: 1,
      kind: oneOf(input.kind, ["ui_variant_unreviewed"], "$.kind"),
      variantId: uiVariantId(input.variantId, "$.variantId"),
      sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
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

function parseProvenance(
  value: unknown,
  path: string,
): CanonicalAnswerProvenanceV1 {
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
    const input = versioned(base, "$", ["kind", "sourceRevisionId"]);
    return {
      schemaVersion: 1,
      kind: oneOf(input.kind, ["answer_type_unknown", "answer_type_ambiguous", "profile_answer_missing"], "$.kind"),
      sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
    };
  }
  const input = versioned(base, "$", [
    "kind",
    "answerType",
    "classificationId",
    "sourceRevisionId",
    "provenance",
  ]);
  return {
    schemaVersion: 1,
    kind: oneOf(input.kind, ["classified"], "$.kind"),
    answerType: oneOf(input.answerType, canonicalAnswerTypes, "$.answerType"),
    classificationId: classificationId(input.classificationId, "$.classificationId"),
    sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
    provenance: parseProvenance(input.provenance, "$.provenance"),
  };
}

export function parseVisibleOptionMappingResult(
  value: unknown,
): VisibleOptionMappingResultV1 {
  const copied = snapshot(value);
  const base = record(copied, "$");
  if (["option_no_match", "option_ambiguous"].includes(String(base.kind))) {
    const input = versioned(base, "$", ["kind", "sourceRevisionId"]);
    return {
      schemaVersion: 1,
      kind: oneOf(input.kind, ["option_no_match", "option_ambiguous"], "$.kind"),
      sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
    };
  }
  const input = versioned(base, "$", [
    "kind",
    "optionId",
    "classificationId",
    "sourceRevisionId",
  ]);
  return {
    schemaVersion: 1,
    kind: oneOf(input.kind, ["mapped"], "$.kind"),
    optionId: parseOptionId(input.optionId, "$.optionId"),
    classificationId: classificationId(input.classificationId, "$.classificationId"),
    sourceRevisionId: revisionId(input.sourceRevisionId, "$.sourceRevisionId"),
  };
}
