import assert from "node:assert/strict";
import test from "node:test";

import {
  browserPageId,
  createGeneratedIdAllocator,
  generatedOperationId,
  generatedSessionId,
  guardRevision,
  providerError,
} from "../../../../src/contracts/index.ts";
import {
  contractFixtures,
  createAnswerResolverFake,
  createBrowserSessionFake,
  createCompletionNavigationFake,
  createFieldDriverFake,
  createFieldVerifierFake,
  createPageUnderstandingFake,
  createSafetyGuardFake,
} from "../../../../src/testing/contracts/index.ts";
import { runPageLoop } from "../../../../src/control/orchestrator/loop/index.ts";

function ids() {
  let next = 0;
  return () => ({
    ok: true as const,
    value: generatedOperationId(
      `operation_${(++next).toString(16).padStart(16, "0")}`,
    ),
  });
}

function dependencies(
  verifier: ReturnType<typeof createFieldVerifierFake>,
  browser = createBrowserSessionFake(),
) {
  const driver = createFieldDriverFake();
  return {
    browser: browser.port,
    understanding: createPageUnderstandingFake().port,
    answers: createAnswerResolverFake().port,
    driver: driver.port,
    driverCalls: driver.calls,
    verifier: verifier.port,
    completion: createCompletionNavigationFake({
      complete: {
        ok: true,
        value: { kind: "complete", decision: { kind: "stop_review" } },
      },
    }).port,
    safety: createSafetyGuardFake().port,
    nextOperationId: ids(),
    guardRevision: guardRevision("policy-s1"),
  } as const;
}

const input = {
  journeyId: contractFixtures.journeyState.journeyId,
  inputs: contractFixtures.journeyInputs,
  sourceId: generatedOperationId("operation_parent0000000000"),
} as const;

function twoSessionBrowser(
  failure?: "close" | "start" | "observe",
) {
  const allocated = generatedSessionId(
    createGeneratedIdAllocator({ next: () => "2222222222222222" }),
  );
  if (!allocated.ok) throw new Error("fresh session fixture allocation failed");
  const fresh = {
    sessionId: allocated.value,
    pageId: browserPageId("page-recovery"),
  };
  let invalidated = false;
  const browser = createBrowserSessionFake({
    start: (_request, _signal, callIndex) =>
      callIndex === 1 && failure === "start"
        ? { ok: false, error: providerError("browser_timeout") }
        : {
            ok: true,
            value:
              callIndex === 0
                ? {
                    sessionId: contractFixtures.browserObservation.sessionId,
                    pageId: contractFixtures.browserObservation.pageId,
                  }
                : fresh,
          },
    observe: (request) =>
      invalidated &&
      request.sessionId === contractFixtures.browserObservation.sessionId
        ? {
            ok: false,
            error: providerError("browser_session_invalidated"),
          }
        : failure === "observe" && request.sessionId === fresh.sessionId
          ? { ok: false, error: providerError("browser_timeout") }
          : {
            ok: true,
            value: {
              ...contractFixtures.browserObservation,
              sessionId: request.sessionId,
              pageId: request.pageId,
            },
          },
    close: (request) => {
      if (request.sessionId === contractFixtures.browserObservation.sessionId) {
        invalidated = true;
      }
      return failure === "close"
        ? {
            ok: false,
            error: providerError("browser_session_invalidated"),
          }
        : { ok: true, value: undefined };
    },
  });
  return { browser, fresh, invalidate: () => { invalidated = true; } };
}

test("a mutation retries once only after an independent rejection", async () => {
  const verifier = createFieldVerifierFake({
    verify: (_request, _signal, callIndex) => ({
      ok: true,
      value:
        callIndex === 0
          ? {
              kind: "rejected",
              fieldId: contractFixtures.field.fieldId,
              reason: "mismatch",
            }
          : contractFixtures.verification,
    }),
  });
  const deps = dependencies(verifier);

  const result = await runPageLoop(
    deps,
    input,
    new AbortController().signal,
    { mutationRetryLimit: 1 },
  );

  assert.equal(result.ok, true);
  assert.equal(deps.driverCalls.length, 2);
  assert.equal(verifier.calls.length, 2);
  assert.notEqual(
    (deps.driverCalls[0]?.request as { operationId: string }).operationId,
    (deps.driverCalls[1]?.request as { operationId: string }).operationId,
  );
});

test("ambiguous verification stops without blind remutation", async () => {
  const verifier = createFieldVerifierFake({
    verify: {
      ok: true,
      value: {
        kind: "ambiguous",
        fieldId: contractFixtures.field.fieldId,
      },
    },
  });
  const deps = dependencies(verifier);

  const result = await runPageLoop(
    deps,
    input,
    new AbortController().signal,
    { mutationRetryLimit: 3 },
  );

  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "blocked") return;
  assert.deepEqual(result.value.factualOutcome, {
    source: "verification",
    result: {
      kind: "ambiguous",
      fieldId: contractFixtures.field.fieldId,
    },
  });
  assert.equal(deps.driverCalls.length, 1);
});

test("retryable reads are bounded before any effect begins", async () => {
  const browser = createBrowserSessionFake({
    observe: (_request, _signal, callIndex) =>
      callIndex === 0
        ? { ok: false, error: providerError("browser_timeout") }
        : { ok: true, value: contractFixtures.browserObservation },
  });
  const deps = dependencies(createFieldVerifierFake(), browser);

  const result = await runPageLoop(
    deps,
    input,
    new AbortController().signal,
    { providerRetryLimit: 1 },
  );

  assert.equal(result.ok, true);
  assert.equal(
    browser.calls.filter(({ operation }) => operation === "observe").length,
    2,
  );
});

test("driver uncertainty owns a fresh observed session and stops without remutation", async () => {
  const sessions = twoSessionBrowser();
  const driver = createFieldDriverFake({
    drive: () => {
      sessions.invalidate();
      return {
        ok: false,
        error: providerError("browser_effect_uncertain"),
      };
    },
  });
  const deps = {
    ...dependencies(createFieldVerifierFake(), sessions.browser),
    driver: driver.port,
  };

  const result = await runPageLoop(
    deps,
    input,
    new AbortController().signal,
    { mutationRetryLimit: 3, providerRetryLimit: 3 },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.error, providerError("browser_effect_uncertain"));
  assert.equal(result.error.phase, "field_interaction");
  assert.equal(result.error.step, "mutate");
  assert.equal(result.error.sessionId, sessions.fresh.sessionId);
  assert.equal(driver.calls.length, 1);
  assert.deepEqual(
    sessions.browser.calls.map(({ operation }) => operation),
    ["start", "observe", "close", "start", "observe"],
  );
  assert.equal(
    sessions.browser.calls.filter(({ operation }) => operation === "mutate").length,
    0,
  );
  assert.equal(
    sessions.browser.calls.filter(({ operation }) => operation === "navigate").length,
    0,
  );
  assert.deepEqual(
    await sessions.browser.port.observe(
      {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
      },
      new AbortController().signal,
    ),
    { ok: false, error: providerError("browser_session_invalidated") },
  );
});

test("verifier cancellation refreshes browser truth and stops without reusing the receipt", async () => {
  const sessions = twoSessionBrowser();
  const verifier = createFieldVerifierFake({
    verify: { ok: false, error: providerError("operation_cancelled") },
  });
  const deps = dependencies(verifier, sessions.browser);

  const result = await runPageLoop(
    deps,
    input,
    new AbortController().signal,
    { mutationRetryLimit: 3, providerRetryLimit: 3 },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.error, providerError("operation_cancelled"));
  assert.equal(result.error.phase, "verification");
  assert.equal(result.error.step, "verify");
  assert.equal(result.error.sessionId, sessions.fresh.sessionId);
  assert.equal(deps.driverCalls.length, 1);
  assert.equal(verifier.calls.length, 1);
  assert.deepEqual(
    sessions.browser.calls.map(({ operation }) => operation),
    ["start", "observe", "close", "start", "observe"],
  );
});

test("fresh-session failures retain exact dependency coordinates", async () => {
  const cases = [
    {
      failure: "close",
      code: "browser_session_invalidated",
      step: "close",
      effect: "uncertain",
    },
    {
      failure: "start",
      code: "browser_timeout",
      step: "start",
      effect: "none",
    },
    {
      failure: "observe",
      code: "browser_timeout",
      step: "observe",
      effect: "none",
    },
  ] as const;

  for (const scenario of cases) {
    const sessions = twoSessionBrowser(scenario.failure);
    const driver = createFieldDriverFake({
      drive: () => {
        sessions.invalidate();
        return {
          ok: false,
          error: providerError("browser_effect_uncertain"),
        };
      },
    });
    const result = await runPageLoop(
      {
        ...dependencies(createFieldVerifierFake(), sessions.browser),
        driver: driver.port,
      },
      input,
      new AbortController().signal,
    );

    assert.equal(result.ok, false, scenario.failure);
    if (result.ok) continue;
    assert.equal(result.error.error.code, scenario.code, scenario.failure);
    assert.equal(result.error.component, "F3", scenario.failure);
    assert.equal(result.error.phase, "browser", scenario.failure);
    assert.equal(result.error.step, scenario.step, scenario.failure);
    assert.equal(result.error.effect, scenario.effect, scenario.failure);
    assert.equal(driver.calls.length, 1, scenario.failure);
  }
});
