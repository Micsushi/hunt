import assert from "node:assert/strict";
import test from "node:test";

import {
  admitContractSnapshot,
  browserPageId,
  generatedOperationId,
  guardRevision,
  providerError,
  type BrowserObservation,
  type AnswerResolutionResult,
  type FactualTerminalOutcome,
  type NavigationReconciliationRequest,
  type OperationId,
  type PageUnderstandingResult,
  type VerificationResult,
} from "../../../../src/contracts/index.ts";
import {
  contractFixtures,
  createAnswerResolverFake,
  createBrowserSessionFake,
  createCompletionNavigationFake,
  createFieldDriverFake,
  createFieldVerifierFake,
  createPageUnderstandingFake,
  requiredFactualTerminalConsumerCases,
} from "../../../../src/testing/contracts/index.ts";
import { runPageLoop } from "../../../../src/control/orchestrator/loop/index.ts";

function operationIds() {
  let next = 0;
  return () => {
    next += 1;
    return {
      ok: true as const,
      value: generatedOperationId(
        `operation_${next.toString(16).padStart(16, "0")}`,
      ),
    };
  };
}

test("the sole page loop verifies every mutation before navigation and stops at Review", async () => {
  const order: string[] = [];
  const reviewPageId = browserPageId("page-review");
  const reviewObservation: BrowserObservation = {
    ...contractFixtures.browserObservation,
    pageId: reviewPageId,
    path: "/review",
    targets: [],
  };
  const browser = createBrowserSessionFake({
    start: async () => {
      order.push("browser.start");
      return {
        ok: true,
        value: {
          sessionId: contractFixtures.browserObservation.sessionId,
          pageId: contractFixtures.browserObservation.pageId,
        },
      };
    },
    observe: async (request) => {
      order.push("browser.observe");
      return {
        ok: true,
        value:
          (request as { pageId: string }).pageId === reviewPageId
            ? reviewObservation
            : contractFixtures.browserObservation,
      };
    },
    navigate: async (request) => {
      order.push("browser.navigate");
      const snapshot = (request as { snapshot: { effect: { operationId: OperationId; pageId: typeof contractFixtures.browserObservation.pageId } } }).snapshot;
      return {
        ok: true,
        value: {
          operationId: snapshot.effect.operationId,
          fromPageId: snapshot.effect.pageId,
          pageId: reviewPageId,
        },
      };
    },
  });
  const understanding = createPageUnderstandingFake({
    understand: async (request) => {
      order.push("understanding.understand");
      const observation = (request as { observation: BrowserObservation }).observation;
      return {
        ok: true,
        value: {
          kind: "understood",
          snapshot:
            observation.pageId === reviewPageId
              ? {
                  pageIdentity: { kind: "workday", page: "review" },
                  fields: [],
                }
              : contractFixtures.pageSnapshot,
        },
      };
    },
  });
  const answers = createAnswerResolverFake({
    resolve: async () => {
      order.push("answers.resolve");
      return { ok: true, value: { kind: "resolved", intent: contractFixtures.intent } };
    },
  });
  const driver = createFieldDriverFake({
    drive: async (request) => {
      order.push("driver.drive");
      const operationId = (request as { operationId: OperationId }).operationId;
      return {
        ok: true,
        value: { ...contractFixtures.mutationReceipt, operationId },
      };
    },
  });
  const verifier = createFieldVerifierFake({
    verify: async () => {
      order.push("verifier.verify");
      return { ok: true, value: contractFixtures.verification };
    },
  });
  const completion = createCompletionNavigationFake({
    complete: async () => {
      order.push("completion.complete");
      return {
        ok: true,
        value: {
          kind: "complete",
          decision: { kind: "next", expectedPage: "review" },
        },
      };
    },
    reconcile: async (request) => {
      order.push("completion.reconcile");
      const input = request as NavigationReconciliationRequest;
      assert.deepEqual(input.sourcePage, {
        kind: "workday",
        page: "profile",
      });
      assert.deepEqual(input.expected, { kind: "workday", page: "review" });
      assert.deepEqual(input.observed, { kind: "workday", page: "review" });
      return {
        ok: true,
        value: {
          kind: "review_reached",
          expected: input.expected,
          observed: input.observed,
        },
      };
    },
  });

  const result = await runPageLoop(
    {
      browser: browser.port,
      understanding: understanding.port,
      answers: answers.port,
      driver: driver.port,
      verifier: verifier.port,
      completion: completion.port,
      safety: {
        async admit(request, signal) {
          order.push("safety.admit");
          if (signal.aborted) {
            return { ok: false, error: providerError("operation_cancelled") };
          }
          return admitContractSnapshot(
            request.input,
            "safety",
            request.binding,
          );
        },
      },
      nextOperationId: operationIds(),
      guardRevision: guardRevision("policy-s1"),
    },
    {
      journeyId: contractFixtures.journeyState.journeyId,
      inputs: contractFixtures.journeyInputs,
      sourceId: generatedOperationId("operation_parent0000000000"),
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "review_candidate",
      pageId: reviewPageId,
      completedPages: 1,
      sessionId: contractFixtures.browserObservation.sessionId,
    },
  });
  assert.deepEqual(order, [
    "browser.start",
    "browser.observe",
    "understanding.understand",
    "answers.resolve",
    "driver.drive",
    "verifier.verify",
    "completion.complete",
    "safety.admit",
    "browser.navigate",
    "browser.observe",
    "understanding.understand",
    "completion.reconcile",
  ]);
});

test("provider failures retain their owner and block later mutation", async () => {
  const driver = createFieldDriverFake();
  const answers = createAnswerResolverFake({
    resolve: {
      ok: false,
      error: providerError("profile_revision_mismatch"),
    },
  });

  const result = await runPageLoop(
    {
      browser: createBrowserSessionFake().port,
      understanding: createPageUnderstandingFake().port,
      answers: answers.port,
      driver: driver.port,
      verifier: createFieldVerifierFake().port,
      completion: createCompletionNavigationFake().port,
      safety: {
        async admit() {
          throw new Error("safety must not run");
        },
      },
      nextOperationId: operationIds(),
      guardRevision: guardRevision("policy-s1"),
    },
    {
      journeyId: contractFixtures.journeyState.journeyId,
      inputs: contractFixtures.journeyInputs,
      sourceId: generatedOperationId("operation_parent0000000000"),
    },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.error.code, "profile_revision_mismatch");
  assert.equal(result.error.component, "F4");
  assert.equal(driver.calls.length, 0);
});

test("identity allocation failure retains the request-scoped source", async () => {
  const sourceId = generatedOperationId("operation_parent0000000000");
  const result = await runPageLoop(
    {
      browser: createBrowserSessionFake().port,
      understanding: createPageUnderstandingFake().port,
      answers: createAnswerResolverFake().port,
      driver: createFieldDriverFake().port,
      verifier: createFieldVerifierFake().port,
      completion: createCompletionNavigationFake().port,
      safety: {
        async admit() {
          throw new Error("safety must not run");
        },
      },
      nextOperationId: () => ({
        ok: false,
        error: providerError("operation_identity_source_invalid"),
      }),
      guardRevision: guardRevision("policy-s1"),
    },
    {
      journeyId: contractFixtures.journeyState.journeyId,
      inputs: contractFixtures.journeyInputs,
      sourceId,
    },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.error.code, "operation_identity_source_invalid");
  assert.equal(result.error.sourceId, sourceId);
});

test("all required factual results remain exact blocked outcomes", async () => {
  for (const consumerCase of requiredFactualTerminalConsumerCases) {
    const pageId =
      consumerCase.contextPageId ?? contractFixtures.browserObservation.pageId;
    const observation = { ...contractFixtures.browserObservation, pageId };
    const browser = createBrowserSessionFake({
      start: {
        ok: true,
        value: { sessionId: observation.sessionId, pageId },
      },
      observe: { ok: true, value: observation },
    });
    const understanding = createPageUnderstandingFake({
      understand:
        consumerCase.provider === "PageUnderstanding"
          ? {
              ok: true,
              value: consumerCase.providerResult as PageUnderstandingResult,
            }
          : {
              ok: true,
              value: {
                kind: "understood",
                snapshot: contractFixtures.pageSnapshot,
              },
            },
    });
    const answers = createAnswerResolverFake({
      resolve:
        consumerCase.provider === "AnswerResolver"
          ? {
              ok: true,
              value: consumerCase.providerResult as AnswerResolutionResult,
            }
          : {
              ok: true,
              value: { kind: "resolved", intent: contractFixtures.intent },
            },
    });
    const driver = createFieldDriverFake();
    const verifier = createFieldVerifierFake({
      verify:
        consumerCase.provider === "FieldVerifier"
          ? {
              ok: true,
              value: consumerCase.providerResult as VerificationResult,
            }
          : { ok: true, value: contractFixtures.verification },
    });
    const completion = createCompletionNavigationFake({
      complete: async () => {
        throw new Error("factual outcome must stop before completion");
      },
    });

    const result = await runPageLoop(
      {
        browser: browser.port,
        understanding: understanding.port,
        answers: answers.port,
        driver: driver.port,
        verifier: verifier.port,
        completion: completion.port,
        safety: {
          async admit(request) {
            return admitContractSnapshot(
              request.input,
              "safety",
              request.binding,
            );
          },
        },
        nextOperationId: operationIds(),
        guardRevision: guardRevision("policy-s1"),
      },
      {
        journeyId: contractFixtures.journeyState.journeyId,
        inputs: contractFixtures.journeyInputs,
        sourceId: generatedOperationId("operation_parent0000000000"),
      },
      new AbortController().signal,
      { mutationRetryLimit: 1 },
    );

    assert.equal(result.ok, true, consumerCase.name);
    if (!result.ok || result.value.kind !== "blocked") continue;
    assert.deepEqual(
      result.value.factualOutcome,
      consumerCase.factualOutcome as FactualTerminalOutcome,
      consumerCase.name,
    );
    assert.equal(result.value.component, consumerCase.terminalEvent.component);
    assert.equal(result.value.phase, consumerCase.terminalEvent.phase);
    assert.equal(result.value.step, consumerCase.terminalEvent.step);
    const expectedMutations =
      consumerCase.provider !== "FieldVerifier"
        ? 0
        : consumerCase.terminalize ===
            "after_bounded_verification_retry_exhausted"
          ? 2
          : 1;
    assert.equal(driver.calls.length, expectedMutations, consumerCase.name);
    assert.equal(completion.calls.length, 0, consumerCase.name);
  }
});
