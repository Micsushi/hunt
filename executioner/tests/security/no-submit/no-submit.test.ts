import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  browserPageId,
  browserTargetToken,
  boundedText,
  fieldId,
  generatedOperationId,
  guardRevision,
  journeyId as exactJourneyId,
  type BrowserNavigationAdmissionSnapshot,
  type McpRequest,
} from "../../../src/contracts/index.ts";
import { mcpMethods } from "../../../src/control/mcp/facade.ts";
import {
  inspectWorkdayReview,
  stopAtVerifiedReview,
} from "../../../src/interaction/review/index.ts";
import {
  reviewPageFixture,
} from "../../interaction/review/fixtures.ts";
import { contractFixtures } from "../../../src/testing/contracts/index.ts";

test("MCP and navigation command surfaces have no final Submit operation", () => {
  assert.deepEqual(mcpMethods, [
    "start_journey",
    "cancel_journey",
    "journey_status",
    "journey_result",
  ] satisfies readonly McpRequest["method"][]);

  const navigation = {
    policyRevision: guardRevision("guard-r1"),
    capability: "navigate_next",
    effect: {
      kind: "browser_navigation",
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: browserPageId("page-review"),
      operationId: generatedOperationId("operation_1111111111111111"),
      action: "next",
    },
  } as const satisfies BrowserNavigationAdmissionSnapshot;
  assert.equal(navigation.effect.action, "next");

  const forbiddenNavigation: BrowserNavigationAdmissionSnapshot = {
    ...navigation,
    effect: {
      ...navigation.effect,
      // @ts-expect-error final Submit is intentionally absent from navigation.
      action: "submit",
    },
  };
  assert.equal(forbiddenNavigation.effect.action, "submit");
});

test("Review proof exposes structural facts without any callable target or action", async () => {
  const pageId = browserPageId("page-review");
  const journeyId = exactJourneyId("journey_reviewnosecret01");
  const operationId = generatedOperationId("operation_reviewnosecret01");
  const requiredFieldId = fieldId("review-no-submit-required");
  const structure = await inspectWorkdayReview(reviewPageFixture());
  const result = stopAtVerifiedReview({
    state: { schemaVersion: 3, journeyId, status: "running", pageId, revision: 1 },
    operationId,
    pageId,
    page: {
      pageIdentity: { kind: "workday", page: "review" },
      fields: [{
        fieldId: requiredFieldId,
        target: browserTargetToken("review-no-submit-target"),
        label: boundedText("Verified Review field"),
        required: true,
        behavior: "text",
        options: [],
        state: "populated",
      }],
    },
    verification: [{ kind: "verified", fieldId: requiredFieldId }],
    completion: { kind: "complete", decision: { kind: "stop_review" } },
    structure,
  });

  assert.equal(result.kind, "review_confirmed");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /selector|locator|target|action|click|press|activate/iu);
});

test("drivers, navigator, MCP, model-facing control, and Review source contain no final Submit capability", () => {
  const sources = [
    "src/control/mcp/facade.ts",
    "src/control/orchestrator/loop/index.ts",
    "src/interaction/drivers/registry.ts",
    "src/interaction/navigation/completion-navigation.ts",
    "src/interaction/review/index.ts",
    "src/acceptance/s2-journey.ts",
    "scripts/run-s2-review.ts",
  ].map((path) => readFileSync(path, "utf8"));

  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /(?:submit_application|submit_my_application|final_submit|activate_submit|click_submit)/iu,
    );
  }
  assert.doesNotMatch(sources.at(-1)!, /\.(?:click|press|fill|check|dispatchEvent)\s*\(/u);
});
