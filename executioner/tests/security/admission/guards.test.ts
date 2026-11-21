import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindAdmissionRequest,
  consumeAdmissionPermit,
  generatedOperationId,
  guardRevision,
  type PrivacyAdmissionRequest,
  type SafetyAdmissionRequest,
} from "../../../src/contracts/index.ts";
import {
  createPrivacyGuard,
  createSafetyGuard,
} from "../../../src/safety/guards.ts";
import {
  contractFixtures,
  contractOperationCases,
} from "../../../src/testing/contracts/index.ts";

const liveSignal = new AbortController().signal;
const binding = {
  journeyId: contractFixtures.journeyState.journeyId,
  attemptId: generatedOperationId("operation_f11a11a11a11a11a"),
  guardRevision: guardRevision("policy-s1"),
} as const;

function privacyRequest(
  semanticPayload: Record<string, unknown>,
): PrivacyAdmissionRequest {
  return {
    binding,
    purpose: "privacy",
    input: { policyRevision: binding.guardRevision, semanticPayload },
  };
}

test("privacy denies forbidden keys and PII-shaped values without retaining them", async () => {
  const guard = createPrivacyGuard();
  assert.deepEqual(
    await guard.admit(privacyRequest({ requestId: "request_0123456789abcdef" }), AbortSignal.abort()),
    { ok: false, error: { code: "operation_cancelled", retryable: false } },
  );

  const marker = "person@example.invalid";
  const cases = [
    ["password", marker, "credential_forbidden"],
    ["clientSecret", marker, "credential_forbidden"],
    ["accessToken", marker, "token_forbidden"],
    ["emailBody", marker, "raw_text_forbidden"],
    ["rawPageText", marker, "raw_text_forbidden"],
    ["selector", marker, "selector_forbidden"],
    ["targetToken", marker, "selector_forbidden"],
    ["policyOverride", marker, "policy_override_forbidden"],
    ["submit", true, "submit_forbidden"],
    ["jobId", marker, "raw_text_forbidden"],
    ["sourceId", marker, "raw_text_forbidden"],
  ] as const;

  for (const [key, value, code] of cases) {
    const result = await guard.admit(
      privacyRequest({ [key]: value }),
      liveSignal,
    );
    assert.deepEqual(result, {
      ok: false,
      error: { code, retryable: false },
    });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(marker, "u"));
  }
});

test("privacy rejects inherited, hidden, symbol, array-extra, accessor, and proxy graphs without executing code", async () => {
  const guard = createPrivacyGuard();
  let getterReads = 0;
  const accessor = Object.defineProperty({}, "requestId", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "request_0123456789abcdef";
    },
  });
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        traps += 1;
        return Object.prototype;
      },
      ownKeys() {
        traps += 1;
        return [];
      },
    },
  );
  const hidden = Object.defineProperty({}, "requestId", {
    enumerable: false,
    value: "request_0123456789abcdef",
  });
  const symbol = { [Symbol("hidden")]: true };
  const inherited = Object.assign(Object.create({ requestId: "hidden" }), {
    method: "journey_status",
  });
  const arrayWithExtra = Object.assign([], { extra: true });

  for (const semanticPayload of [
    accessor,
    proxy,
    hidden,
    symbol,
    inherited,
    arrayWithExtra,
  ]) {
    assert.deepEqual(
      await guard.admit(
        privacyRequest(semanticPayload as Record<string, unknown>),
        liveSignal,
      ),
      {
        ok: false,
        error: { code: "admission_graph_invalid", retryable: false },
      },
    );
  }
  assert.equal(getterReads, 0);
  assert.equal(traps, 0);
});

test("safety grants exact field and navigation effects after rejecting cancelled and malformed requests", async () => {
  const guard = createSafetyGuard();
  const mutation = contractOperationCases.SafetyGuard.admit.request;
  assert.deepEqual(await guard.admit(mutation, AbortSignal.abort()), {
    ok: false, error: { code: "operation_cancelled", retryable: false },
  });
  const cases = [
    [{ ...mutation, capability: "submit" }, "submit_forbidden"],
    [{ ...mutation, selector: "#next" }, "selector_forbidden"],
    [{ ...mutation, policyOverride: true }, "policy_override_forbidden"],
    [{ ...mutation, capability: "observe" }, "policy_override_forbidden"],
    [
      {
        ...mutation,
        input: { ...mutation.input, capability: "navigate_next" },
      },
      "admission_shape_invalid",
    ],
  ] as const;

  for (const [request, code] of cases) {
    assert.deepEqual(
      await guard.admit(request as unknown as SafetyAdmissionRequest, liveSignal),
      { ok: false, error: { code, retryable: false } },
    );
  }

  const mutationResult = await guard.admit(mutation, liveSignal);
  assert.equal(mutationResult.ok, true);
  if (mutationResult.ok) {
    assert.deepEqual(mutationResult.value.snapshot, mutation.input);
    assert.equal(
      consumeAdmissionPermit(bindAdmissionRequest(mutationResult.value)).ok,
      true,
    );
  }

  const navigation = {
    binding: {
      ...binding,
      attemptId: generatedOperationId("operation_f11b11b11b11b11b"),
    },
    policyRevision: binding.guardRevision,
    capability: "navigate_next",
    input: {
      policyRevision: binding.guardRevision,
      capability: "navigate_next",
      effect: {
        kind: "browser_navigation",
        sessionId: "browser_session_0123456789abcdef",
        pageId: "page-questionnaire",
        operationId: generatedOperationId("operation_f11b11b11b11b11b"),
        action: "next",
      },
    },
  } as unknown as SafetyAdmissionRequest;
  assert.equal((await guard.admit(navigation, liveSignal)).ok, true);
});
