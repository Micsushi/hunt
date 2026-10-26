import assert from "node:assert/strict";
import { test } from "node:test";

import {
  admitContractSnapshot,
  browserTargetToken,
  consumeBrowserMutationAdmission,
  generatedOperationId,
  guardRevision,
  journeyId,
  providerError,
  type BrowserEffectError,
  type BrowserMutationAdmissionSnapshot,
  type CancellationError,
  type DriverRequest,
  type FieldIntent,
} from "../../../../src/contracts/index.ts";
import { createFieldDriver } from "../../../../src/interaction/drivers/registry.ts";
import {
  contractFixtures,
  createBrowserSessionFake,
  createSafetyGuardFake,
} from "../../../../src/testing/contracts/index.ts";

function request(intent: FieldIntent = contractFixtures.intent): DriverRequest {
  return {
    journeyId: journeyId("journey_0123456789abcdef"),
    sessionId: contractFixtures.browserObservation.sessionId,
    pageId: contractFixtures.browserObservation.pageId,
    guardRevision: guardRevision("policy-s1"),
    operationId: generatedOperationId("operation_0123456789abcdef"),
    intent,
  };
}

function admittingSafety() {
  return createSafetyGuardFake({
    admit: (input) =>
      admitContractSnapshot(
        input.input,
        "safety",
        input.binding,
      ) as never,
  });
}

test("admits one exact operation before one browser mutation", async () => {
  const safety = admittingSafety();
  const browser = createBrowserSessionFake();
  const input = request();

  assert.deepEqual(
    await createFieldDriver(browser.port, safety.port).drive(
      input,
      new AbortController().signal,
    ),
    { ok: true, value: contractFixtures.mutationReceipt },
  );

  assert.equal(safety.calls.length, 1);
  const admission = safety.calls[0]!.request as {
    readonly binding: unknown;
    readonly policyRevision: unknown;
    readonly capability: unknown;
    readonly input: BrowserMutationAdmissionSnapshot;
  };
  assert.deepEqual(admission.binding, {
    journeyId: input.journeyId,
    attemptId: input.operationId,
    guardRevision: input.guardRevision,
  });
  assert.equal(admission.policyRevision, input.guardRevision);
  assert.equal(admission.capability, "field_mutation");
  assert.deepEqual(admission.input, {
    policyRevision: input.guardRevision,
    capability: "field_mutation",
    effect: {
      kind: "browser_mutation",
      sessionId: input.sessionId,
      pageId: input.pageId,
      operationId: input.operationId,
      mutation: {
        kind: "set_text",
        target: input.intent.target,
        text: contractFixtures.intent.value,
      },
    },
  });

  assert.equal(browser.calls.length, 1);
  const mutationRequest = browser.calls[0]!.request as {
    readonly purpose: unknown;
    readonly journeyId: unknown;
    readonly attemptId: unknown;
    readonly guardRevision: unknown;
    readonly snapshot: BrowserMutationAdmissionSnapshot;
    readonly admission: { readonly snapshot: BrowserMutationAdmissionSnapshot };
  };
  assert.equal(mutationRequest.purpose, "safety");
  assert.equal(mutationRequest.journeyId, input.journeyId);
  assert.equal(mutationRequest.attemptId, input.operationId);
  assert.equal(mutationRequest.guardRevision, input.guardRevision);
  assert.strictEqual(
    mutationRequest.snapshot,
    mutationRequest.admission.snapshot,
  );
  assert.deepEqual(mutationRequest.snapshot, admission.input);
});

test("the browser receives a fresh one-use permit after SafetyGuard admission", async () => {
  const order: string[] = [];
  let boundRequest: Parameters<
    ReturnType<typeof createBrowserSessionFake>["port"]["mutate"]
  >[0] | undefined;
  const safety = createSafetyGuardFake({
    admit: (input) => {
      order.push("safety");
      return admitContractSnapshot(
        input.input,
        "safety",
        input.binding,
      ) as never;
    },
  });
  const browser = createBrowserSessionFake({
    mutate: (input) => {
      order.push("browser");
      boundRequest = input;
      const consumed = consumeBrowserMutationAdmission(input);
      return consumed.ok
        ? {
            ok: true,
            value: {
              operationId: consumed.value.effect.operationId,
              pageId: consumed.value.effect.pageId,
              attempted: true,
            },
          }
        : consumed;
    },
  });

  assert.equal(
    (
      await createFieldDriver(browser.port, safety.port).drive(
        request(),
        new AbortController().signal,
      )
    ).ok,
    true,
  );
  assert.deepEqual(order, ["safety", "browser"]);
  assert.ok(boundRequest !== undefined);
  assert.deepEqual(consumeBrowserMutationAdmission(boundRequest), {
    ok: false,
    error: { code: "admission_consumed", retryable: false },
  });
});

test("rejects malformed and Submit-like targets before admission", async () => {
  const piiShapedTarget = ["applicant", "example.invalid"].join("@");
  for (const target of [
    "",
    "#given-name",
    "target with spaces",
    piiShapedTarget,
    "submit-button",
    "x".repeat(129),
  ]) {
    const safety = admittingSafety();
    const browser = createBrowserSessionFake();

    assert.deepEqual(
      await createFieldDriver(browser.port, safety.port).drive(
        request({
          ...contractFixtures.intent,
          target: target as ReturnType<typeof browserTargetToken>,
        }),
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "driver_target_invalid", retryable: false },
      },
    );
    assert.deepEqual(safety.calls, []);
    assert.deepEqual(browser.calls, []);
  }
});

test("rejects malformed or unsupported intents without admission", async () => {
  const cases = [
    {
      intent: { ...contractFixtures.intent, fieldId: "" },
      code: "driver_intent_invalid",
    },
    {
      intent: { ...contractFixtures.intent, behavior: "select" },
      code: "driver_intent_invalid",
    },
    {
      intent: { ...contractFixtures.intent, behavior: "submit" },
      code: "driver_behavior_unsupported",
    },
  ] as const;

  for (const { intent, code } of cases) {
    const safety = admittingSafety();
    const browser = createBrowserSessionFake();
    const result = await createFieldDriver(browser.port, safety.port).drive(
      request(intent as unknown as FieldIntent),
      new AbortController().signal,
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.error.code, code);
    assert.deepEqual(safety.calls, []);
    assert.deepEqual(browser.calls, []);
  }
});

test("non-string generated coordinates fail closed without dependency calls", async () => {
  for (const coordinate of ["journeyId", "sessionId", "operationId"] as const) {
    const safety = admittingSafety();
    const browser = createBrowserSessionFake();
    const input = {
      ...request(),
      [coordinate]: Symbol(coordinate),
    } as unknown as DriverRequest;

    assert.deepEqual(
      await createFieldDriver(browser.port, safety.port).drive(
        input,
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "driver_intent_invalid", retryable: false },
      },
    );
    assert.deepEqual(safety.calls, []);
    assert.deepEqual(browser.calls, []);
  }
});

test("oversized Unicode text and identifiers fail before admission", async () => {
  const oversized = "\u{1F642}".repeat(100_000);
  const cases = [
    request({ ...contractFixtures.intent, value: oversized }),
    { ...request(), journeyId: oversized },
    { ...request(), sessionId: oversized },
    { ...request(), operationId: oversized },
  ] as unknown as DriverRequest[];

  for (const input of cases) {
    const safety = admittingSafety();
    const browser = createBrowserSessionFake();

    assert.deepEqual(
      await createFieldDriver(browser.port, safety.port).drive(
        input,
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "driver_intent_invalid", retryable: false },
      },
    );
    assert.deepEqual(safety.calls, []);
    assert.deepEqual(browser.calls, []);
  }
});

test("pre-effect cancellation makes zero dependency calls", async () => {
  const safety = admittingSafety();
  const browser = createBrowserSessionFake();

  assert.deepEqual(
    await createFieldDriver(browser.port, safety.port).drive(
      request(),
      AbortSignal.abort(),
    ),
    {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    },
  );
  assert.deepEqual(safety.calls, []);
  assert.deepEqual(browser.calls, []);
});

test("in-flight abort reaches SafetyGuard and browser and cannot later succeed", async () => {
  const controller = new AbortController();
  let safetySignal: AbortSignal | undefined;
  let browserSignal: AbortSignal | undefined;
  let browserStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    browserStarted = resolve;
  });
  const safety = createSafetyGuardFake({
    admit: (input, signal) => {
      safetySignal = signal;
      return admitContractSnapshot(
        input.input,
        "safety",
        input.binding,
      ) as never;
    },
  });
  const browser = createBrowserSessionFake({
    mutate: async (_input, signal) => {
      browserSignal = signal;
      browserStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        error: { code: "operation_cancelled", retryable: false },
      };
    },
  });
  const pending = createFieldDriver(browser.port, safety.port).drive(
    request(),
    controller.signal,
  );

  await started;
  controller.abort();

  assert.deepEqual(await pending, {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.strictEqual(safetySignal, controller.signal);
  assert.strictEqual(browserSignal, controller.signal);
  assert.equal(safety.calls.length, 1);
  assert.equal(browser.calls.length, 1);
  await Promise.resolve();
  assert.equal(browser.calls.length, 1);
});

test("an operation can be dispatched only once", async () => {
  const safety = admittingSafety();
  const browser = createBrowserSessionFake();
  const driver = createFieldDriver(browser.port, safety.port);
  const input = request();

  assert.equal(
    (await driver.drive(input, new AbortController().signal)).ok,
    true,
  );
  assert.deepEqual(
    await driver.drive(input, new AbortController().signal),
    {
      ok: false,
      error: { code: "driver_operation_replayed", retryable: false },
    },
  );
  assert.equal(safety.calls.length, 1);
  assert.equal(browser.calls.length, 1);
});

test("preserves exact F11 denials and makes no browser call", async () => {
  for (const error of [
    providerError("policy_override_forbidden"),
    providerError("admission_stale"),
  ] as const) {
    const safety = createSafetyGuardFake({
      admit: { ok: false, error },
    });
    const browser = createBrowserSessionFake();

    assert.deepEqual(
      await createFieldDriver(browser.port, safety.port).drive(
        request(),
        new AbortController().signal,
      ),
      { ok: false, error },
    );
    assert.equal(safety.calls.length, 1);
    assert.deepEqual(browser.calls, []);
  }
});

test("rejects a SafetyGuard result bound to a different operation", async () => {
  const safety = createSafetyGuardFake({
    admit: { ok: true, value: contractFixtures.safetyAdmission },
  });
  const browser = createBrowserSessionFake();

  assert.deepEqual(
    await createFieldDriver(browser.port, safety.port).drive(
      {
        ...request(),
        operationId: generatedOperationId("operation_9999999999999999"),
      },
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "admission_mismatch", retryable: false },
    },
  );
  assert.deepEqual(browser.calls, []);
});

test("preserves every exact browser effect error", async () => {
  const errors = [
    providerError("browser_target_invalid"),
    providerError("browser_page_owned"),
    providerError("browser_session_missing"),
    providerError("browser_target_stale"),
    providerError("browser_target_ambiguous"),
    providerError("browser_operation_replayed"),
    providerError("browser_timeout"),
    providerError("browser_effect_uncertain"),
    providerError("browser_session_invalidated"),
    providerError("artifact_changed"),
    providerError("artifact_already_consumed"),
    providerError("artifact_handle_invalid"),
    providerError("admission_invalid"),
    providerError("admission_stale"),
    providerError("admission_consumed"),
    providerError("admission_mismatch"),
    providerError("operation_cancelled"),
  ] as const satisfies readonly (BrowserEffectError | CancellationError)[];

  for (const [index, error] of errors.entries()) {
    const safety = admittingSafety();
    const browser = createBrowserSessionFake({
      mutate: { ok: false, error },
    });
    const input = {
      ...request(),
      operationId: generatedOperationId(
        `operation_${String(index).padStart(16, "0")}`,
      ),
    };

    assert.deepEqual(
      await createFieldDriver(browser.port, safety.port).drive(
        input,
        new AbortController().signal,
      ),
      { ok: false, error },
    );
    assert.equal(safety.calls.length, 1);
    assert.equal(browser.calls.length, 1);
  }
});
