import {
  admitContractSnapshot,
  bindAdmissionRequest,
  createGeneratedIdAllocator,
  generatedOperationId,
  guardRevision,
  journeyId,
  type BrowserMutation,
  type BrowserMutationRequest,
  type BrowserNavigationRequest,
  type BrowserPageId,
  type BrowserSessionId,
} from "../../src/contracts/index.ts";

export const testJourneyId = journeyId("journey_1111111111111111");

export function testIds(...tokens: string[]) {
  const queue = [...tokens];
  return createGeneratedIdAllocator({
    next: () => queue.shift() ?? "ffffffffffffffff",
  });
}

export function dataPage(body: string, pageId = "page-test"): string {
  return `data:text/html,${encodeURIComponent(`<html data-hunt-page-id="${pageId}"><body>${body}</body></html>`)}`;
}

function admissionValue<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("test admission failed");
  return result.value;
}

export function admittedMutation(
  sessionId: BrowserSessionId,
  pageId: BrowserPageId,
  mutation: BrowserMutation,
  seed = "1111111111111111",
): BrowserMutationRequest {
  const operationId = generatedOperationId(`operation_${seed}`);
  const revision = guardRevision("policy-s1");
  return bindAdmissionRequest(admissionValue(admitContractSnapshot(
    {
      policyRevision: revision,
      capability: "field_mutation",
      effect: { kind: "browser_mutation", sessionId, pageId, operationId, mutation },
    },
    "safety",
    { journeyId: testJourneyId, attemptId: operationId, guardRevision: revision },
  )));
}

export function admittedNavigation(
  sessionId: BrowserSessionId,
  pageId: BrowserPageId,
  seed = "2222222222222222",
): BrowserNavigationRequest {
  const operationId = generatedOperationId(`operation_${seed}`);
  const revision = guardRevision("policy-s1");
  return bindAdmissionRequest(admissionValue(admitContractSnapshot(
    {
      policyRevision: revision,
      capability: "navigate_next",
      effect: { kind: "browser_navigation", sessionId, pageId, operationId, action: "next" },
    },
    "safety",
    { journeyId: testJourneyId, attemptId: operationId, guardRevision: revision },
  )));
}
