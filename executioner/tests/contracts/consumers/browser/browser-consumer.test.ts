import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contractFixtures,
  createBrowserSessionFake,
} from "../../../../src/testing/contracts/index.ts";
import {
  browserPageId,
  admitContractSnapshot,
  bindAdmissionRequest,
  consumeBrowserMutationAdmission,
  consumeBrowserNavigationAdmission,
  createGeneratedIdAllocator,
  generatedJourneyId,
  generatedSessionId,
  generatedOperationId,
  guardRevision,
} from "../../../../src/contracts/index.ts";

test("a browser consumer can exercise every shared fake operation", async () => {
  const ids = createGeneratedIdAllocator({
    next: () => "0123456789abcdef",
  });
  const sessionId = generatedSessionId(ids);
  if (!sessionId.ok) throw new Error("test session allocation failed");
  const journeyId = generatedJourneyId(ids);
  if (!journeyId.ok) throw new Error("test journey allocation failed");
  const harness = createBrowserSessionFake({
    start: () => ({
      ok: true,
      value: {
        sessionId: sessionId.value,
        pageId: browserPageId("page-account"),
      },
    }),
    observe: (request) => ({
      ok: true,
      value: {
        ...contractFixtures.browserObservation,
        sessionId: request.sessionId,
        pageId: request.pageId,
      },
    }),
    mutate: (request) => {
      const consumed = consumeBrowserMutationAdmission(request);
      if (!consumed.ok) return consumed;
      const effect = consumed.value.effect;
      return { ok: true, value: { operationId: effect.operationId, pageId: effect.pageId, attempted: true } };
    },
    navigate: (request) => {
      const consumed = consumeBrowserNavigationAdmission(request);
      if (!consumed.ok) return consumed;
      const effect = consumed.value.effect;
      return {
        ok: true,
        value: { operationId: effect.operationId, fromPageId: effect.pageId, pageId: browserPageId("page-profile") },
      };
    },
    close: () => ({ ok: true, value: undefined }),
  });
  const signal = new AbortController().signal;
  const started = await harness.port.start(
    {
      journeyId: journeyId.value,
      target: "https://fixture.invalid/account",
    },
    signal,
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const coordinates = started.value;
  const revision = guardRevision("guard-browser-consumer");
  const mutationOperationId = generatedOperationId("operation_0123456789abcdef");
  const mutationAdmission = admitContractSnapshot(
    {
      policyRevision: revision,
      capability: "field_mutation",
      effect: {
        kind: "browser_mutation",
        ...coordinates,
        operationId: mutationOperationId,
        mutation: { kind: "set_text", target: contractFixtures.field.target, text: "Synthetic" },
      },
    },
    "safety",
    { journeyId: journeyId.value, attemptId: mutationOperationId, guardRevision: revision },
  );
  if (!mutationAdmission.ok) throw new Error("test mutation admission failed");
  const navigationOperationId = generatedOperationId("operation_fedcba9876543210");
  const navigationAdmission = admitContractSnapshot(
    {
      policyRevision: revision,
      capability: "navigate_next",
      effect: { kind: "browser_navigation", ...coordinates, operationId: navigationOperationId, action: "next" },
    },
    "safety",
    { journeyId: journeyId.value, attemptId: navigationOperationId, guardRevision: revision },
  );
  if (!navigationAdmission.ok) throw new Error("test navigation admission failed");
  assert.notEqual(mutationAdmission.value.permit, navigationAdmission.value.permit);
  assert.notEqual(mutationAdmission.value.attemptId, navigationAdmission.value.attemptId);

  await harness.port.observe(coordinates, signal);
  await harness.port.mutate(
    bindAdmissionRequest(mutationAdmission.value),
    signal,
  );
  await harness.port.navigate(
    bindAdmissionRequest(navigationAdmission.value),
    signal,
  );
  await harness.port.close({ sessionId: coordinates.sessionId }, signal);

  assert.deepEqual(
    harness.calls.map(({ operation }) => operation),
    ["start", "observe", "mutate", "navigate", "close"],
  );
  assert.deepEqual(
    await harness.port.observe(coordinates, AbortSignal.abort()),
    {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    },
  );
});
