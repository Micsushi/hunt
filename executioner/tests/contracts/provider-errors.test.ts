import assert from "node:assert/strict";
import test from "node:test";

import {
  createGeneratedIdAllocator,
  generatedJourneyId,
  generatedOperationId,
  parseErrorEnvelope,
  providerCause,
  providerError,
  stableErrorPolicy,
  type FailureContext,
  type OrchestratorError,
  type BrowserSessionError,
  type BrowserEffectError,
  type DriverError,
  type AnswerResolutionError,
  type VerificationError,
  type EvidenceError,
  type PrivacyDenial,
  type SafetyDenial,
  type JourneyInputError,
} from "../../src/contracts/index.ts";

test("stable error policy owns provider attribution and literal retryability", () => {
  assert.deepEqual(stableErrorPolicy.browser_timeout, {
    owner: "F3",
    retryable: true,
  });
  assert.deepEqual(stableErrorPolicy.profile_query_invalid, {
    owner: "F4",
    retryable: false,
  });
  assert.deepEqual(stableErrorPolicy.journey_state_unavailable, {
    owner: "F4",
    retryable: true,
  });
  assert.deepEqual(providerError("browser_timeout"), {
    code: "browser_timeout",
    retryable: true,
  });
  assert.deepEqual(providerError("browser_effect_uncertain"), {
    code: "browser_effect_uncertain",
    retryable: false,
  });
});

test("F3 and F9 provider surfaces can return allocator failures without remapping", () => {
  const session: BrowserSessionError = providerError("session_identity_collision");
  const journey: OrchestratorError = providerError("journey_identity_source_invalid");
  const operation: OrchestratorError = providerError("operation_identity_collision");
  assert.deepEqual([session.code, journey.code, operation.code], [
    "session_identity_collision",
    "journey_identity_source_invalid",
    "operation_identity_collision",
  ]);
});

test("admission failures stay truthful on every admitting and consuming port", () => {
  const privacy: PrivacyDenial = providerError("admission_invalid");
  const safety: SafetyDenial = providerError("admission_stale");
  const evidence: EvidenceError = providerError("admission_consumed");
  const browser: BrowserEffectError = providerError("admission_mismatch");
  assert.deepEqual([privacy, safety, evidence, browser], [
    { code: "admission_invalid", retryable: false },
    { code: "admission_stale", retryable: false },
    { code: "admission_consumed", retryable: false },
    { code: "admission_mismatch", retryable: false },
  ]);
});

test("artifact failures remain truthful at F4 capture and F3 upload boundaries", () => {
  const size: JourneyInputError = providerError("artifact_size_invalid");
  const digest: JourneyInputError = providerError("artifact_digest_mismatch");
  const changed: BrowserEffectError = providerError("artifact_changed");
  const consumed: BrowserEffectError = providerError("artifact_already_consumed");
  const invalid: BrowserEffectError = providerError("artifact_handle_invalid");
  assert.deepEqual(
    [size.code, digest.code, changed.code, consumed.code, invalid.code],
    [
      "artifact_size_invalid",
      "artifact_digest_mismatch",
      "artifact_changed",
      "artifact_already_consumed",
      "artifact_handle_invalid",
    ],
  );
});

test("driver dependency failures preserve their exact F11 and F3 ownership", () => {
  const pageOwned: DriverError = providerError("browser_page_owned");
  const timeout: DriverError = providerError("browser_timeout");
  const denied: DriverError = providerError("policy_override_forbidden");

  assert.deepEqual([pageOwned, timeout, denied], [
    { code: "browser_page_owned", retryable: false },
    { code: "browser_timeout", retryable: true },
    { code: "policy_override_forbidden", retryable: false },
  ]);
  assert.equal(stableErrorPolicy[pageOwned.code].owner, "F3");
  assert.equal(stableErrorPolicy[timeout.code].owner, "F3");
  assert.equal(stableErrorPolicy[denied.code].owner, "F11");
});

test("answer resolution passes through exact profile query failures", () => {
  const malformed: AnswerResolutionError = providerError("profile_query_invalid");
  const missing: AnswerResolutionError = providerError("profile_missing");
  const revision: AnswerResolutionError = providerError("profile_revision_mismatch");

  assert.deepEqual([malformed, missing, revision], [
    { code: "profile_query_invalid", retryable: false },
    { code: "profile_missing", retryable: false },
    { code: "profile_revision_mismatch", retryable: false },
  ]);
  assert.deepEqual(
    [malformed, missing, revision].map(({ code }) => stableErrorPolicy[code].owner),
    ["F4", "F4", "F4"],
  );
});

test("verification distinguishes exact browser failures from exhausted polling", () => {
  const browser: VerificationError = providerError("browser_session_missing");
  const timeout: VerificationError = providerError("browser_timeout");
  const exhausted: VerificationError = providerError(
    "verification_timeout",
    providerCause("browser_timeout", {
      kind: "operation",
      id: generatedOperationId("operation_2222222222222222"),
    }),
  );

  assert.deepEqual(browser, {
    code: "browser_session_missing",
    retryable: false,
  });
  assert.deepEqual(timeout, { code: "browser_timeout", retryable: true });
  assert.equal(exhausted.code, "verification_timeout");
  assert.equal(exhausted.cause?.code, "browser_timeout");
  assert.equal(exhausted.cause?.owner, "F3");
});

test("orchestration failure preserves a closed nested provider cause", () => {
  const source = {
    kind: "operation" as const,
    id: generatedOperationId("operation_0123456789abcdef"),
  };
  const error: OrchestratorError = providerError(
    "journey_retry_exhausted",
    providerCause("browser_timeout", source),
  );

  assert.deepEqual(error, {
    code: "journey_retry_exhausted",
    retryable: false,
    cause: {
      code: "browser_timeout",
      owner: "F3",
      retryable: true,
      source,
    },
  });
});

test("journey coordinates remain bounded while errors remain closed", () => {
  assert.deepEqual(
    generatedJourneyId(
      createGeneratedIdAllocator({ next: () => "fedcba9876543210" }),
    ),
    { ok: true, value: "journey_fedcba9876543210" },
  );
  if (false) {
    // @ts-expect-error arbitrary provider error strings are not public contract errors
    providerError("invented_provider_failure");
  }
});

test("serialized errors cannot remap provider ownership or retryability", () => {
  const base = {
    schemaVersion: 2,
    code: "browser_timeout",
    component: "F3",
    phase: "browser",
    step: "observe",
    retryable: true,
    source: { kind: "operation", id: "operation_0123456789abcdef" },
  };
  assert.equal(parseErrorEnvelope(base).component, "F3");
  assert.throws(
    () => parseErrorEnvelope({ ...base, component: "F9" }),
    /invalid_value/u,
  );
  assert.throws(
    () => parseErrorEnvelope({ ...base, retryable: false }),
    /invalid_value/u,
  );
});

test("failure context derives owner and retryability from its error code", () => {
  const context: FailureContext = {
    journeyId: (() => {
      const result = generatedJourneyId(createGeneratedIdAllocator({ next: () => "0123456789abcdef" }));
      if (!result.ok) throw new Error("test id allocation failed");
      return result.value;
    })(),
    component: "F3",
    phase: "browser",
    step: "observe",
    code: "browser_timeout",
    retryable: true,
    source: { kind: "operation", id: generatedOperationId("operation_0123456789abcdef") },
  };
  assert.equal(context.component, "F3");
  if (false) {
    // @ts-expect-error browser_timeout is owned by F3
    const invalid: FailureContext = {
      ...context,
      component: "F9",
    };
    void invalid;
  }
});
