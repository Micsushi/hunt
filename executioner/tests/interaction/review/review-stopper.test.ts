import assert from "node:assert/strict";
import { test } from "node:test";

import {
  browserPageId,
  browserTargetToken,
  boundedText,
  fieldId,
  generatedOperationId,
  journeyId as exactJourneyId,
  type DurableJourneyState,
  type SemanticPageSnapshot,
} from "../../../src/contracts/index.ts";
import {
  inspectWorkdayReview,
  stopAtVerifiedReview,
} from "../../../src/interaction/review/index.ts";
import {
  realWorkdayReviewFixture,
  reviewPageFixture,
} from "./fixtures.ts";

const journeyId = exactJourneyId("journey_reviewstopproof01");
const operationId = generatedOperationId("operation_reviewstopproof01");
const pageId = browserPageId("page-review");
const requiredFieldId = fieldId("review-required");
const page = Object.freeze({
  pageIdentity: Object.freeze({ kind: "workday", page: "review" }),
  fields: Object.freeze([
    Object.freeze({
      fieldId: requiredFieldId,
      target: browserTargetToken("review-summary-only"),
      label: boundedText("Required review summary"),
      required: true,
      behavior: "text",
      options: Object.freeze([]),
      state: "populated",
    }),
  ]),
}) satisfies SemanticPageSnapshot;
const state = Object.freeze({
  schemaVersion: 3,
  journeyId,
  status: "running",
  pageId,
  revision: 7,
}) satisfies DurableJourneyState;

test("real Workday Review structure produces a value-free observation", async () => {
  assert.deepEqual(
    await inspectWorkdayReview(reviewPageFixture()),
    {
      schemaVersion: 1,
      reviewRoot: { count: 1, visible: true },
      activeStep: { count: 1, visible: true },
      validationErrorCount: 0,
      finalSubmit: { count: 1, visible: true, enabled: true },
    },
  );
});

test("absent structural matches are counted without waiting on element state", async () => {
  const absent = {
    count: () => Promise.resolve(0),
    isVisible: () => Promise.reject(new Error("absent locator state read")),
    isEnabled: () => Promise.reject(new Error("absent locator state read")),
    getByRole: () => absent,
  };
  const observed = await inspectWorkdayReview({
    locator: () => absent,
  });

  assert.deepEqual(observed, {
    schemaVersion: 1,
    reviewRoot: { count: 0, visible: false },
    activeStep: { count: 0, visible: false },
    validationErrorCount: 0,
    finalSubmit: { count: 0, visible: false, enabled: false },
  });
});

test("a Submit outside the exact Workday page footer cannot satisfy the signature", async () => {
  const absent = {
    count: () => Promise.resolve(0),
    isVisible: () => Promise.resolve(false),
    isEnabled: () => Promise.resolve(false),
    getByRole: () => absent,
  };
  const outsideSubmit = {
    count: () => Promise.resolve(1),
    isVisible: () => Promise.resolve(true),
    isEnabled: () => Promise.resolve(true),
    getByRole: () => outsideSubmit,
  };
  const root = {
    count: () => Promise.resolve(1),
    isVisible: () => Promise.resolve(true),
    isEnabled: () => Promise.resolve(false),
    getByRole: () => absent,
  };
  const pageWithOutsideSubmit = {
    locator: (selector: string) => selector.includes("pageFooter")
      ? absent
      : selector.includes("applyFlowReviewPage")
      ? selector.includes("error") ? absent : root
      : root,
    getByRole: () => outsideSubmit,
  };
  const observed = await inspectWorkdayReview(pageWithOutsideSubmit);

  assert.deepEqual(observed.finalSubmit, {
    count: 0,
    visible: false,
    enabled: false,
  });
});

test("verified Review returns only structural Submit facts and a terminal transition", async () => {
  const structure = await inspectWorkdayReview(reviewPageFixture());

  assert.deepEqual(
    stopAtVerifiedReview({
      state,
      operationId,
      pageId,
      page,
      verification: [{ kind: "verified", fieldId: requiredFieldId }],
      completion: { kind: "complete", decision: { kind: "stop_review" } },
      structure,
    }),
    {
      kind: "review_confirmed",
      proof: {
        schemaVersion: 1,
        page: "review",
        requiredFieldCount: 1,
        verifiedRequiredFieldCount: 1,
        validationErrorCount: 0,
        finalSubmit: { present: true, visible: true, enabled: true },
      },
      transition: {
        journeyId,
        operationId,
        expectedRevision: 7,
        status: "review_reached",
        pageId,
      },
    },
  );
});

const falsePositiveCases = [
  [
    "review path or heading without the exact Workday root",
    { ...realWorkdayReviewFixture, reviewRoot: { count: 0, visible: false } },
    "review_signature_missing",
  ],
  [
    "duplicate Review roots",
    { ...realWorkdayReviewFixture, reviewRoot: { count: 2, visible: true } },
    "review_signature_ambiguous",
  ],
  [
    "hidden Review root",
    { ...realWorkdayReviewFixture, reviewRoot: { count: 1, visible: false } },
    "review_not_visible",
  ],
  [
    "lookalike Review without the exact active step",
    { ...realWorkdayReviewFixture, activeStep: { count: 0, visible: false } },
    "review_signature_missing",
  ],
  [
    "visible validation error",
    { ...realWorkdayReviewFixture, validationError: { count: 1, visible: true } },
    "completion_unverified",
  ],
  [
    "page with no final Submit",
    { ...realWorkdayReviewFixture, finalSubmit: { count: 0, visible: false } },
    "submit_signature_missing",
  ],
  [
    "ambiguous final Submit controls",
    { ...realWorkdayReviewFixture, finalSubmit: { count: 2, visible: true } },
    "submit_signature_ambiguous",
  ],
] as const;

for (const [name, fixture, reason] of falsePositiveCases) {
  test(`denies ${name}`, async () => {
    const structure = await inspectWorkdayReview(reviewPageFixture(fixture));
    assert.deepEqual(
      stopAtVerifiedReview({
        state,
        operationId,
        pageId,
        page,
        verification: [{ kind: "verified", fieldId: requiredFieldId }],
        completion: { kind: "complete", decision: { kind: "stop_review" } },
        structure,
      }),
      { kind: "review_denied", reason },
    );
  });
}

test("denies semantic, completion, verification, and state substitutes", async () => {
  const structure = await inspectWorkdayReview(reviewPageFixture());
  const baseline = {
    state,
    operationId,
    pageId,
    page,
    verification: [{ kind: "verified", fieldId: requiredFieldId }],
    completion: { kind: "complete", decision: { kind: "stop_review" } },
    structure,
  } as const;

  assert.deepEqual(
    stopAtVerifiedReview({
      ...baseline,
      page: { ...page, pageIdentity: { kind: "workday", page: "questionnaire" } },
    }),
    { kind: "review_denied", reason: "page_not_review" },
  );
  assert.deepEqual(
    stopAtVerifiedReview({
      ...baseline,
      completion: { kind: "blocked", fieldIds: [requiredFieldId], decision: { kind: "blocked" } },
    }),
    { kind: "review_denied", reason: "completion_unverified" },
  );
  assert.deepEqual(
    stopAtVerifiedReview({ ...baseline, verification: [] }),
    { kind: "review_denied", reason: "completion_unverified" },
  );
  assert.deepEqual(
    stopAtVerifiedReview({
      ...baseline,
      page: { ...page, fields: [] },
      verification: [],
    }),
    { kind: "review_denied", reason: "completion_unverified" },
  );
  assert.deepEqual(
    stopAtVerifiedReview({
      ...baseline,
      verification: [
        ...baseline.verification,
        { kind: "verified", fieldId: fieldId("review-unknown") },
      ],
    }),
    { kind: "review_denied", reason: "completion_unverified" },
  );
  assert.deepEqual(
    stopAtVerifiedReview({
      ...baseline,
      state: { ...state, status: "review_reached" },
    }),
    { kind: "review_denied", reason: "state_mismatch" },
  );
});
