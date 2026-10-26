import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ContractParseError,
  liveClassificationSchemas,
  parseReviewedPromotionRecord,
} from "../../../src/contracts/index.ts";

const base = {
  schemaVersion: 1,
  promotionId: "promotion_0123456789abcdef",
  candidateId: "unknown_candidate_0123456789abcdef",
  layer: "question",
  scope: "between_runs",
  reviewerDecisionId: "reviewer_decision_0123456789abcdef",
  reviewedFixtureIds: ["reviewed_fixture_0123456789abcdef"],
  testEvidenceIds: ["test_evidence_0123456789abcdef"],
  sourceRevisionId: "classification_revision_0123456789abcdef",
} as const;

function expectInvalid(value: unknown, path: string): void {
  assert.throws(
    () => parseReviewedPromotionRecord(value),
    (error: unknown) => error instanceof ContractParseError && error.path === path,
  );
}

test("accepted promotion records require a new immutable revision", () => {
  const accepted = {
    ...base,
    decision: "accepted",
    sourceChangeId: "source_change_0123456789abcdef",
    acceptedRevisionId: "classification_revision_fedcba9876543210",
  } as const;
  assert.deepEqual(parseReviewedPromotionRecord(accepted), accepted);
  expectInvalid({ ...accepted, acceptedRevisionId: accepted.sourceRevisionId }, "$.acceptedRevisionId");
  expectInvalid({ ...accepted, acceptedRevisionId: null }, "$.acceptedRevisionId");
});

test("rejected promotion records have no source change or accepted revision and remain between-run data", () => {
  const rejected = {
    ...base,
    decision: "rejected",
    sourceChangeId: null,
    acceptedRevisionId: null,
  } as const;
  assert.deepEqual(parseReviewedPromotionRecord(rejected), rejected);
  expectInvalid({ ...rejected, acceptedRevisionId: "classification_revision_fedcba9876543210" }, "$.acceptedRevisionId");
  expectInvalid({ ...rejected, sourceChangeId: "source_change_0123456789abcdef" }, "$.sourceChangeId");
  expectInvalid({ ...rejected, scope: "active_journey" }, "$.scope");
  expectInvalid({ ...rejected, fixture: "raw" }, "$.fixture");
});

test("the promotion schema publishes accepted-versus-rejected revision closure", () => {
  assert.equal(liveClassificationSchemas.reviewedPromotionRecord.additionalProperties, false);
  assert.deepEqual(
    liveClassificationSchemas.reviewedPromotionRecord.allOf.map(
      ({ if: condition }) => condition.properties.decision.const,
    ),
    ["accepted", "rejected"],
  );
});
