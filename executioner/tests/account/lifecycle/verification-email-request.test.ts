import assert from "node:assert/strict";
import { test } from "node:test";

import { createVerificationEmailRequestAdapter } from "../../../src/composition/private/s2-verification-email-request.ts";
import { operation, lifecycleInput } from "./support.ts";

function harness(options: {
  readonly cardinality?: number;
  readonly actionable?: boolean;
  readonly activation?: { readonly ok: false; readonly error: { readonly code: "browser_effect_uncertain"; readonly retryable: false } };
} = {}) {
  const input = lifecycleInput();
  const scopes: unknown[] = [];
  const actions: string[] = [];
  const provider = {
    async withOwnedAccountPageAccess(
      request: unknown,
      _signal: AbortSignal,
      use: (access: unknown) => Promise<void>,
    ) {
      scopes.push(request);
      await use({
        inspectAction: async (action: string) => {
          actions.push(`inspect:${action}`);
          return {
            ok: true,
            value: {
              cardinality: options.cardinality ?? 1,
              actionable: options.actionable ?? true,
            },
          };
        },
        activate: async (action: string) => {
          actions.push(`activate:${action}`);
          return options.activation ?? { ok: true, value: undefined };
        },
      } as never);
      return { ok: true, value: undefined } as const;
    },
  };
  const binding = {
    approvalId: input.approvalId,
    journeyId: input.journeyId,
    operationId: input.operations.requestVerificationEmail,
    sessionId: input.session.sessionId,
    target: input.target,
  };
  const request = {
    schemaVersion: 1 as const,
    ...binding,
    now: input.now,
  };
  return {
    input,
    scopes,
    actions,
    request,
    adapter: createVerificationEmailRequestAdapter({ accountPage: provider as never, binding }),
  };
}

test("verification-email requester binds approval, journey, operation, session, and target once", async () => {
  const value = harness();
  assert.deepEqual(
    await value.adapter.request(value.request, new AbortController().signal),
    { ok: true, value: { kind: "sent", independentlyObserved: true } },
  );
  assert.deepEqual(value.actions, [
    "inspect:request_verification_email",
    "activate:request_verification_email",
  ]);
  assert.deepEqual(value.scopes, [{
    schemaVersion: 1,
    journeyId: value.request.journeyId,
    operationId: value.request.operationId,
    sessionId: value.request.sessionId,
    target: value.request.target,
    now: value.request.now,
  }]);
  assert.deepEqual(
    await value.adapter.request(value.request, new AbortController().signal),
    { ok: false, error: { code: "browser_effect_uncertain", retryable: false } },
  );
  assert.equal(value.scopes.length, 1);
  assert.doesNotMatch(JSON.stringify(value.actions), /submit/iu);
});

test("verification-email requester fails closed on binding drift before page access", async () => {
  const base = harness();
  const cases = [
    { approvalId: "approval_otherabcdefghijkl" },
    { journeyId: "journey_otherabcdefghijkl" as never },
    { operationId: operation("other-request") },
    { sessionId: "live_session_otherabcdef" as never },
    { target: { ...base.request.target, postingId: "posting_otherabcdefghijkl" as never } },
    { now: "not-a-time" },
  ];
  for (const changed of cases) {
    const value = harness();
    assert.deepEqual(
      await value.adapter.request({ ...value.request, ...changed }, new AbortController().signal),
      { ok: false, error: { code: "browser_target_invalid", retryable: false } },
    );
    assert.equal(value.scopes.length, 0);
  }
});

test("verification-email requester does not activate absent, ambiguous, non-actionable, failed, or cancelled requests", async () => {
  for (const options of [
    { cardinality: 0, actionable: false },
    { cardinality: 0, actionable: true },
    { cardinality: 2, actionable: false },
    { cardinality: 1, actionable: false },
    { activation: { ok: false, error: { code: "browser_effect_uncertain", retryable: false } } as const },
  ]) {
    const value = harness(options);
    const result = await value.adapter.request(value.request, new AbortController().signal);
    if (options.cardinality === 0 && options.actionable === true) {
      assert.deepEqual(result, { ok: true, value: { kind: "not_required" } });
    } else {
      assert.equal(result.ok, false);
    }
    assert.equal(value.actions.filter((action) => action.startsWith("activate:")).length,
      options.cardinality === 0 || options.cardinality === 2 || options.actionable === false ? 0 : 1);
  }

  const cancelled = harness();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await cancelled.adapter.request(cancelled.request, controller.signal), {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.equal(cancelled.scopes.length, 0);
});
