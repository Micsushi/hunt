import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";

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

test("Workday Review requires a scoped Submit and a matching final step", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 778, height: 446 } });
    const review = '<section data-automation-id="applyFlowReviewPage">Review</section>';
    const footer = '<div data-automation-id="pageFooter"><button>Submit</button></div>';
    await page.setContent(`<main data-automation-id="applyFlowPage">${review}</main>${footer}`);
    assert.deepEqual((await inspectWorkdayReview(page)).finalSubmit, {
      count: 0, visible: false, enabled: false,
    });

    const completed = '<li data-automation-id="progressBarCompletedStep">Completed</li>';
    const active = (position: string) =>
      `<li data-automation-id="progressBarActiveStep"><label aria-live="polite">current step ${position}</label></li>`;
    for (const [steps, sameFlow, accepted] of [
      [completed + completed + active("3 of 3"), true, true],
      [completed + completed + active("2 of 3"), true, false],
      [completed + active("3 of 3") + completed, true, false],
      [completed + active("3 of 3") + active("3 of 3"), true, false],
      [completed + completed + active("7 of 7"), true, false],
      [completed + completed + active("3 of 3"), false, false],
    ] as const) {
      const progress = `<ol data-automation-id="progressBar">${steps}</ol>`;
      await page.setContent(sameFlow
        ? `<main data-automation-id="applyFlowPage">${progress}${review}${footer}</main>`
        : `<main data-automation-id="applyFlowPage">${progress}</main><main data-automation-id="applyFlowPage">${review}${footer}</main>`);
      const observed = await inspectWorkdayReview(page);
      assert.deepEqual(observed.activeStep, { count: accepted ? 1 : 0, visible: accepted });
      assert.equal(observed.finalSubmit.enabled, true);
    }
  } finally {
    await browser.close();
  }
});

test("verified Review returns only structural Submit facts and a terminal transition", async () => {
  const structure = await inspectWorkdayReview(reviewPageFixture());

  const result = stopAtVerifiedReview({
    state,
    operationId,
    pageId,
    page,
    verification: [{ kind: "verified", fieldId: requiredFieldId }],
    completion: { kind: "complete", decision: { kind: "stop_review" } },
    structure,
  });
  assert.deepEqual(result, {
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
  });
  assert.doesNotMatch(JSON.stringify(result), /selector|locator|target|action|click|press|activate/iu);
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
