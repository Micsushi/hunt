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

test("privacy admits the exact value-free F9 MCP payload and freezes a detached snapshot", async () => {
  const guard = createPrivacyGuard();
  const semanticPayload = {
    requestId: "request_0123456789abcdef",
    method: "start_journey",
    jobId: "job-synthetic",
    resumeId: "resume-synthetic",
    profileId: "profile-synthetic",
  };
  const result = await guard.admit(privacyRequest(semanticPayload), liveSignal);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  semanticPayload.jobId = "changed-after-admission";
  assert.equal(result.value.purpose, "privacy");
  assert.equal(result.value.journeyId, binding.journeyId);
  assert.equal(result.value.attemptId, binding.attemptId);
  assert.equal(result.value.guardRevision, binding.guardRevision);
  assert.notEqual(result.value.snapshot, semanticPayload);
  assert.equal(Object.isFrozen(result.value.snapshot), true);
  assert.equal(
    (result.value.snapshot as { semanticPayload: { jobId: string } })
      .semanticPayload.jobId,
    "job-synthetic",
  );

  const bound = bindAdmissionRequest(result.value);
  assert.equal(consumeAdmissionPermit(bound).ok, true);
  assert.deepEqual(consumeAdmissionPermit(bound), {
    ok: false,
    error: { code: "admission_consumed", retryable: false },
  });
});

test("privacy and F9 agree on every live semantic key", async () => {
  const guard = createPrivacyGuard();
  const payloads = [
    {
      requestId: "request_0123456789abcdef",
      method: "start_journey",
      jobId: "job-synthetic",
      resumeId: "resume-synthetic",
      profileId: "profile-synthetic",
    },
    {
      requestId: "request_1123456789abcdef",
      method: "cancel_journey",
      journeyId: binding.journeyId,
    },
    {
      requestId: "request_2123456789abcdef",
      method: "journey_status",
      journeyId: binding.journeyId,
    },
    {
      requestId: "request_3123456789abcdef",
      method: "journey_result",
      journeyId: binding.journeyId,
    },
  ] as const;

  for (const payload of payloads) {
    assert.equal(
      (await guard.admit(privacyRequest({ ...payload }), liveSignal)).ok,
      true,
    );
  }
});

test("privacy denies forbidden keys and PII-shaped values without retaining them", async () => {
  const guard = createPrivacyGuard();
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

test("safety admits only exact field mutation and next-navigation effects", async () => {
  const guard = createSafetyGuard();
  const mutation = contractOperationCases.SafetyGuard.admit.request;
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

test("safety rejects extra binding fields without retaining their values", async () => {
  const guard = createSafetyGuard();
  const baseline = contractOperationCases.SafetyGuard.admit.request;
  const marker = "person@example.invalid";
  const result = await guard.admit(
    {
      ...baseline,
      binding: { ...baseline.binding, forbidden: marker },
    } as unknown as SafetyAdmissionRequest,
    liveSignal,
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: "admission_shape_invalid", retryable: false },
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(marker, "u"));
});

test("safety denies Submit, selectors, policy overrides, and mismatched effect ownership", async () => {
  const guard = createSafetyGuard();
  const baseline = contractOperationCases.SafetyGuard.admit.request;
  const cases = [
    [{ ...baseline, capability: "submit" }, "submit_forbidden"],
    [{ ...baseline, selector: "#next" }, "selector_forbidden"],
    [{ ...baseline, policyOverride: true }, "policy_override_forbidden"],
    [{ ...baseline, capability: "observe" }, "policy_override_forbidden"],
    [
      {
        ...baseline,
        input: { ...baseline.input, capability: "navigate_next" },
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
});

test("both guards return the frozen cancellation result without issuing a permit", async () => {
  assert.deepEqual(
    await createPrivacyGuard().admit(
      privacyRequest({ requestId: "request_0123456789abcdef" }),
      AbortSignal.abort(),
    ),
    {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    },
  );
  assert.deepEqual(
    await createSafetyGuard().admit(
      contractOperationCases.SafetyGuard.admit.request,
      AbortSignal.abort(),
    ),
    {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    },
  );
});

test("Submit is not representable in the safety contract", () => {
  const invalid: SafetyAdmissionRequest = {
    ...contractOperationCases.SafetyGuard.admit.request,
    // @ts-expect-error Submit is intentionally absent from the capability union.
    capability: "submit",
  };
  assert.equal(invalid.capability, "submit");
});
