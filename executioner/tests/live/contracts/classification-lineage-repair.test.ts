import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as classificationSerialized from "../../../src/contracts/live/classification-serialized.ts";
import * as liveContracts from "../../../src/contracts/live/index.ts";

import {
  ContractParseError,
  deriveSanitizedUnknownCandidate,
  liveClassificationOwnership,
  liveClassificationSchemas,
  parseAtsFamilyClassificationResult,
  parseCanonicalAnswerTypeClassificationResult,
  parseReviewedPromotionRecord,
  parseSanitizedStructuralObservation,
  parseSanitizedUnknownCandidate,
  parseVisibleOptionMappingResult,
  parseWorkdayPageTypeClassificationResult,
} from "../../../src/contracts/index.ts";

const sourceRevisionId = "classification_revision_0123456789abcdef";
const classificationId = "classification_0123456789abcdef";

const observation = {
  schemaVersion: 1,
  observationId: "structural_observation_0123456789abcdef",
  layer: "ats_family",
  sourceRevisionId,
  parentLineage: [],
  traitIds: ["structural_trait_0123456789abcdef"],
  observedVariantId: null,
  controlCount: 3,
  requiredControlCount: 2,
  optionCount: 4,
} as const;

test("the compatibility facade keeps exactly ten parsers and hides primitives", () => {
  assert.deepEqual(Object.keys(classificationSerialized).sort(), [
    "deriveSanitizedUnknownCandidate",
    "parseAtsFamilyClassificationResult",
    "parseCanonicalAnswerTypeClassificationResult",
    "parseQuestionClassificationResult",
    "parseReviewedPromotionRecord",
    "parseSanitizedStructuralObservation",
    "parseSanitizedUnknownCandidate",
    "parseUiBehaviorClassificationResult",
    "parseVisibleOptionMappingResult",
    "parseWorkdayPageTypeClassificationResult",
  ]);
  for (const privateName of [
    "classificationId",
    "exact",
    "identifier",
    "record",
    "revisionId",
    "snapshot",
    "versioned",
  ]) {
    assert.equal(privateName in liveContracts, false, privateName);
  }
});

function expectInvalid(run: () => unknown, path: string): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof ContractParseError && error.path === path,
  );
}

test("structural observations pin bounded counts and preserve them in exact candidates", () => {
  assert.deepEqual(parseSanitizedStructuralObservation(observation), observation);

  const candidate = deriveSanitizedUnknownCandidate({
    candidateId: "unknown_candidate_0123456789abcdef",
    observation,
    outcome: "ats_unsupported",
  });
  assert.deepEqual(candidate, {
    schemaVersion: 1,
    candidateId: "unknown_candidate_0123456789abcdef",
    observationId: observation.observationId,
    layer: "ats_family",
    outcome: "ats_unsupported",
    sourceRevisionId,
    parentLineage: [],
    traitIds: observation.traitIds,
    observedVariantId: null,
    controlCount: 3,
    requiredControlCount: 2,
    optionCount: 4,
  });
  assert.notStrictEqual(candidate.parentLineage, observation.parentLineage);
  assert.notStrictEqual(candidate.traitIds, observation.traitIds);

  expectInvalid(
    () => parseSanitizedStructuralObservation({ ...observation, controlCount: 65 }),
    "$.controlCount",
  );
  expectInvalid(
    () => parseSanitizedStructuralObservation({ ...observation, requiredControlCount: 4 }),
    "$.requiredControlCount",
  );
  expectInvalid(
    () => parseSanitizedStructuralObservation({ ...observation, optionCount: -1 }),
    "$.optionCount",
  );
});

test("candidate derivation admits only the closed layer and outcome graph", () => {
  expectInvalid(
    () => deriveSanitizedUnknownCandidate({
      candidateId: "unknown_candidate_0123456789abcdef",
      observation,
      outcome: "question_unknown",
    } as never),
    "$.outcome",
  );
  const answerObservation = {
    ...observation,
    layer: "answer_type",
    parentLineage: [
      { layer: "ats_family", classificationId },
      { layer: "workday_page_type", classificationId },
      { layer: "ui_behavior", classificationId },
      { layer: "question", classificationId },
    ],
  } as const;
  expectInvalid(
    () => deriveSanitizedUnknownCandidate({
      candidateId: "unknown_candidate_0123456789abcdef",
      observation: answerObservation,
      outcome: "profile_answer_missing",
    }),
    "$.outcome",
  );

  const unsupported = parseAtsFamilyClassificationResult({
    schemaVersion: 1,
    kind: "ats_unsupported",
    familyId: "ats_family_0123456789abcdef",
    sourceRevisionId,
  });
  assert.equal(unsupported.kind, "ats_unsupported");
  assert.equal(unsupported.familyId, "ats_family_0123456789abcdef");
  const candidate = deriveSanitizedUnknownCandidate({
    candidateId: "unknown_candidate_0123456789abcdef",
    observation,
    outcome: unsupported.kind,
  });
  assert.equal("familyId" in candidate, false);
  expectInvalid(
    () => parseSanitizedUnknownCandidate({ ...candidate, familyId: unsupported.familyId }),
    "$.familyId",
  );
});

test("every factual classification result pins its source revision and result identity is not repeated", () => {
  assert.deepEqual(parseWorkdayPageTypeClassificationResult({
    schemaVersion: 1,
    kind: "workday_page_unknown",
    sourceRevisionId,
  }), {
    schemaVersion: 1,
    kind: "workday_page_unknown",
    sourceRevisionId,
  });
  expectInvalid(
    () => parseWorkdayPageTypeClassificationResult({
      schemaVersion: 1,
      kind: "workday_page_unknown",
    }),
    "$.sourceRevisionId",
  );

  const answer = {
    schemaVersion: 1,
    kind: "classified",
    answerType: "single_choice",
    classificationId,
    sourceRevisionId,
    provenance: {
      schemaVersion: 1,
      provenanceId: "answer_provenance_0123456789abcdef",
      source: "profile",
      sourceRevisionId: "answer_source_revision_0123456789abcdef",
    },
  } as const;
  assert.deepEqual(parseCanonicalAnswerTypeClassificationResult(answer), answer);
  expectInvalid(
    () => parseCanonicalAnswerTypeClassificationResult({ ...answer, questionId: "question-country" }),
    "$.questionId",
  );

  const mapped = {
    schemaVersion: 1,
    kind: "mapped",
    optionId: "option-united-states",
    classificationId,
    sourceRevisionId,
  } as const;
  assert.deepEqual(parseVisibleOptionMappingResult(mapped), mapped);
  expectInvalid(
    () => parseVisibleOptionMappingResult({ ...mapped, questionId: "question-country" }),
    "$.questionId",
  );
});

test("answer classification binds visible option mapping and ownership flows forward", () => {
  const typeSource = readFileSync(
    new URL("../../../src/contracts/live/classification.ts", import.meta.url),
    "utf8",
  );
  const mappingRequest = typeSource.match(
    /export interface VisibleOptionMappingRequestV1 \{(?<body>[\s\S]*?)\n\}/u,
  )?.groups?.body ?? "";
  const answerRequest = typeSource.match(
    /export interface CanonicalAnswerTypeClassificationRequestV1 \{(?<body>[\s\S]*?)\n\}/u,
  )?.groups?.body ?? "";
  assert.match(answerRequest, /readonly questionId: QuestionId;/u);
  assert.match(mappingRequest, /readonly questionId: QuestionId;/u);
  assert.match(mappingRequest, /readonly answerTypeClassificationId: ClassificationId;/u);

  const answerOwner = liveClassificationOwnership.find(
    ({ contract }) => contract === "CanonicalAnswerTypeClassifier",
  );
  const mapperOwner = liveClassificationOwnership.find(
    ({ contract }) => contract === "VisibleOptionMapper",
  );
  assert.deepEqual(answerOwner?.consumers, [
    "VisibleOptionMapper",
    "F9 live coordinator",
    "F7 reviewed driver dispatch",
  ]);
  assert.deepEqual(mapperOwner?.consumers, [
    "F9 live coordinator",
    "F7 reviewed driver dispatch",
  ]);
});

test("promotion records close reviewer evidence and accepted versus rejected source changes", () => {
  const base = {
    schemaVersion: 1,
    promotionId: "promotion_0123456789abcdef",
    candidateId: "unknown_candidate_0123456789abcdef",
    layer: "question",
    scope: "between_runs",
    reviewerDecisionId: "reviewer_decision_0123456789abcdef",
    reviewedFixtureIds: ["reviewed_fixture_0123456789abcdef"],
    testEvidenceIds: ["test_evidence_0123456789abcdef"],
    sourceRevisionId,
  } as const;
  const accepted = {
    ...base,
    decision: "accepted",
    sourceChangeId: "source_change_0123456789abcdef",
    acceptedRevisionId: "classification_revision_fedcba9876543210",
  } as const;
  assert.deepEqual(parseReviewedPromotionRecord(accepted), accepted);

  const rejected = {
    ...base,
    decision: "rejected",
    sourceChangeId: null,
    acceptedRevisionId: null,
  } as const;
  assert.deepEqual(parseReviewedPromotionRecord(rejected), rejected);

  expectInvalid(
    () => parseReviewedPromotionRecord({ ...accepted, reviewedFixtureIds: [] }),
    "$.reviewedFixtureIds",
  );
  expectInvalid(
    () => parseReviewedPromotionRecord({ ...accepted, testEvidenceIds: [base.testEvidenceIds[0], base.testEvidenceIds[0]] }),
    "$.testEvidenceIds[1]",
  );
  expectInvalid(
    () => parseReviewedPromotionRecord({ ...rejected, sourceChangeId: accepted.sourceChangeId }),
    "$.sourceChangeId",
  );

  assert.equal(
    liveClassificationSchemas.reviewedPromotionRecord.additionalProperties,
    false,
  );
});
