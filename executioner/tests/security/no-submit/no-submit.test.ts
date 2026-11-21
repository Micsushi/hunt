import assert from "node:assert/strict";
import { test } from "node:test";

import {
  browserPageId,
  generatedOperationId,
  guardRevision,
  type BrowserNavigationAdmissionSnapshot,
  type McpRequest,
} from "../../../src/contracts/index.ts";
import { mcpMethods } from "../../../src/control/mcp/facade.ts";
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
