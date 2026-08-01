import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalAnswerTypes,
  liveClassificationVersions,
  parseAtsFamilyClassificationResult,
  parseCanonicalAnswerTypeClassificationResult,
  parseQuestionClassificationResult,
  parseUiBehaviorClassificationResult,
  parseVisibleOptionMappingResult,
  parseWorkdayPageTypeClassificationResult,
  workdayPageTypes,
} from "../../../src/contracts/index.ts";

const revisionId = "classification_revision_0123456789abcdef";
const classificationId = "classification_0123456789abcdef";

test("classification layers and versions are additive and exact", () => {
  assert.deepEqual(liveClassificationVersions, {
    atsFamilyClassification: 1,
    workdayPageTypeClassification: 1,
    uiBehaviorClassification: 1,
    questionClassification: 1,
    canonicalAnswerTypeClassification: 1,
    visibleOptionMapping: 1,
    sanitizedStructuralObservation: 1,
    sanitizedUnknownCandidate: 1,
    reviewedPromotionRecord: 1,
  });
  assert.deepEqual(canonicalAnswerTypes, [
    "text",
    "boolean",
    "number",
    "iso_date",
    "single_choice",
    "multi_choice",
    "resume_artifact",
  ]);
  assert.deepEqual(workdayPageTypes, [
    "job_posting",
    "account_entry",
    "email_verification",
    "candidate_home",
    "profile",
    "questionnaire",
    "review",
  ]);
});

test("each layer preserves recognized and exact factual outcomes", () => {
  assert.deepEqual(parseAtsFamilyClassificationResult({
    schemaVersion: 1,
    kind: "classified",
    atsFamily: "workday",
    classificationId,
    sourceRevisionId: revisionId,
  }), {
    schemaVersion: 1,
    kind: "classified",
    atsFamily: "workday",
    classificationId,
    sourceRevisionId: revisionId,
  });
  assert.deepEqual(parseAtsFamilyClassificationResult({
    schemaVersion: 1,
    kind: "ats_unsupported",
    familyId: "ats_family_0123456789abcdef",
    sourceRevisionId: revisionId,
  }), {
    schemaVersion: 1,
    kind: "ats_unsupported",
    familyId: "ats_family_0123456789abcdef",
    sourceRevisionId: revisionId,
  });
  for (const kind of ["ats_unknown", "ats_ambiguous"] as const) {
    assert.deepEqual(parseAtsFamilyClassificationResult({ schemaVersion: 1, kind }), { schemaVersion: 1, kind });
  }

  assert.deepEqual(parseWorkdayPageTypeClassificationResult({
    schemaVersion: 1,
    kind: "classified",
    pageType: "questionnaire",
    classificationId,
    sourceRevisionId: revisionId,
  }), {
    schemaVersion: 1,
    kind: "classified",
    pageType: "questionnaire",
    classificationId,
    sourceRevisionId: revisionId,
  });
  for (const kind of ["workday_page_unknown", "workday_page_ambiguous"] as const) {
    assert.deepEqual(parseWorkdayPageTypeClassificationResult({ schemaVersion: 1, kind }), { schemaVersion: 1, kind });
  }

  assert.deepEqual(parseUiBehaviorClassificationResult({
    schemaVersion: 1,
    kind: "classified",
    behavior: "listbox",
    reviewedVariantId: "ui_variant_0123456789abcdef",
    classificationId,
    sourceRevisionId: revisionId,
  }), {
    schemaVersion: 1,
    kind: "classified",
    behavior: "listbox",
    reviewedVariantId: "ui_variant_0123456789abcdef",
    classificationId,
    sourceRevisionId: revisionId,
  });
  assert.deepEqual(parseUiBehaviorClassificationResult({
    schemaVersion: 1,
    kind: "ui_variant_unreviewed",
    variantId: "ui_variant_0123456789abcdef",
  }), {
    schemaVersion: 1,
    kind: "ui_variant_unreviewed",
    variantId: "ui_variant_0123456789abcdef",
  });
  for (const kind of ["ui_behavior_unknown", "ui_behavior_ambiguous"] as const) {
    assert.deepEqual(parseUiBehaviorClassificationResult({ schemaVersion: 1, kind }), { schemaVersion: 1, kind });
  }

  assert.deepEqual(parseQuestionClassificationResult({
    schemaVersion: 1,
    kind: "classified",
    questionId: "question-country",
    classificationId,
    sourceRevisionId: revisionId,
  }), {
    schemaVersion: 1,
    kind: "classified",
    questionId: "question-country",
    classificationId,
    sourceRevisionId: revisionId,
  });
  for (const kind of ["question_unknown", "question_ambiguous"] as const) {
    assert.deepEqual(parseQuestionClassificationResult({ schemaVersion: 1, kind }), { schemaVersion: 1, kind });
  }
});

test("answer types carry value-free provenance and visible option mapping stays factual", () => {
  const classified = {
    schemaVersion: 1,
    kind: "classified",
    questionId: "question-country",
    answerType: "single_choice",
    provenance: {
      schemaVersion: 1,
      provenanceId: "answer_provenance_0123456789abcdef",
      source: "profile",
      sourceRevisionId: "answer_source_revision_0123456789abcdef",
    },
  } as const;
  assert.deepEqual(parseCanonicalAnswerTypeClassificationResult(classified), classified);
  for (const kind of ["answer_type_unknown", "answer_type_ambiguous", "profile_answer_missing"] as const) {
    const factual = { schemaVersion: 1, kind, questionId: "question-country" } as const;
    assert.deepEqual(parseCanonicalAnswerTypeClassificationResult(factual), factual);
  }

  const mapped = {
    schemaVersion: 1,
    kind: "mapped",
    questionId: "question-country",
    optionId: "option-united-states",
    sourceRevisionId: revisionId,
  } as const;
  assert.deepEqual(parseVisibleOptionMappingResult(mapped), mapped);
  for (const kind of ["option_no_match", "option_ambiguous"] as const) {
    const factual = { schemaVersion: 1, kind, questionId: "question-country" } as const;
    assert.deepEqual(parseVisibleOptionMappingResult(factual), factual);
  }
});
