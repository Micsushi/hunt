import assert from "node:assert/strict";
import test from "node:test";

import {
  bindAdmissionRequest,
  browserPageId,
  browserTargetToken,
  generatedOperationId,
  guardRevision,
  providerError,
  type BrowserMutationAdmissionSnapshot,
  type BrowserNavigationAdmissionSnapshot,
  type BrowserSession,
  type DriverRequest,
  type SafetyAdmissionRequest,
  type SafetyGuard,
} from "../../../../src/contracts/index.ts";
import {
  contractFixtures,
  createBrowserSessionFake,
  createSafetyGuardFake,
} from "../../../../src/testing/contracts/index.ts";

const driverRequest = {
  journeyId: contractFixtures.journeyState.journeyId,
  sessionId: contractFixtures.browserObservation.sessionId,
  pageId: browserPageId("page-profile"),
  guardRevision: guardRevision("guard-driver-consumer"),
  operationId: generatedOperationId("operation_3333333333333333"),
  intent: {
    kind: "text",
    behavior: "text",
    fieldId: contractFixtures.field.fieldId,
    target: browserTargetToken("target-given-name"),
    value: "Synthetic",
    provenance: "owner_provided",
  },
} as const satisfies DriverRequest;

if (false) {
  const mutationInput = mutationAdmissionRequest(driverRequest).input;
  const matchingMutation: SafetyAdmissionRequest<typeof mutationInput> = {
    ...mutationAdmissionRequest(driverRequest),
    capability: "field_mutation",
  };
  const navigationInput = {
    policyRevision: driverRequest.guardRevision,
    capability: "navigate_next",
    effect: {
      kind: "browser_navigation",
      sessionId: driverRequest.sessionId,
      pageId: driverRequest.pageId,
      operationId: driverRequest.operationId,
      action: "next",
    },
  } as const satisfies BrowserNavigationAdmissionSnapshot;
  const matchingNavigation: SafetyAdmissionRequest<typeof navigationInput> = {
    binding: {
      journeyId: driverRequest.journeyId,
      attemptId: driverRequest.operationId,
      guardRevision: driverRequest.guardRevision,
    },
    policyRevision: driverRequest.guardRevision,
    capability: "navigate_next",
    input: navigationInput,
  };
  const mismatchedMutation: SafetyAdmissionRequest<typeof mutationInput> = {
    ...matchingMutation,
    // @ts-expect-error mutation admission cannot claim navigation capability
    capability: "navigate_next",
  };
  void matchingMutation;
  void matchingNavigation;
  void mismatchedMutation;
}

function mutationAdmissionRequest(
  request: DriverRequest,
): SafetyAdmissionRequest<BrowserMutationAdmissionSnapshot> {
  const input = {
    policyRevision: request.guardRevision,
    capability: "field_mutation",
    effect: {
      kind: "browser_mutation",
      sessionId: request.sessionId,
      pageId: request.pageId,
      operationId: request.operationId,
      mutation: {
        kind: "set_text",
        target: request.intent.target,
        text: request.intent.kind === "text" ? request.intent.value : "",
      },
    },
  } as const satisfies BrowserMutationAdmissionSnapshot;
  return {
    binding: {
      journeyId: request.journeyId,
      attemptId: request.operationId,
      guardRevision: request.guardRevision,
    },
    policyRevision: request.guardRevision,
    capability: "field_mutation",
    input,
  };
}

async function admitThenMutate(
  safety: SafetyGuard,
  browser: BrowserSession,
  request: SafetyAdmissionRequest<BrowserMutationAdmissionSnapshot>,
  signal: AbortSignal,
) {
  const admitted = await safety.admit(request, signal);
  if (!admitted.ok) return admitted;
  return browser.mutate(bindAdmissionRequest(admitted.value), signal);
}

test("a safety denial preserves the F11 error and makes zero browser calls", async () => {
  const safety = createSafetyGuardFake({
    admit: {
      ok: false,
      error: providerError("policy_override_forbidden"),
    },
  });
  const browser = createBrowserSessionFake();

  const result = await admitThenMutate(
    safety.port,
    browser.port,
    mutationAdmissionRequest(driverRequest),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: "policy_override_forbidden", retryable: false },
  });
  assert.deepEqual(safety.calls.map(({ operation }) => operation), ["admit"]);
  assert.deepEqual(browser.calls, []);
});
