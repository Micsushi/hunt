import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type AdmissionDecision,
  admissionDecisionPolicy,
  type CancellationError,
  type FixtureRuntime,
  inProcessCancellationPolicy,
} from "../../src/contracts/index.ts";

test("privacy and safety denial use only the port error channel", () => {
  const admitted = {
    kind: "admitted",
    policyRevision: "policy-1",
  } satisfies AdmissionDecision;

  const denied: AdmissionDecision = {
    // @ts-expect-error a denial is a PrivacyDenial/SafetyDenial port error
    kind: "denied",
    policyRevision: "policy-1",
    code: "submit_forbidden",
  };

  assert.equal(admitted.kind, "admitted");
  assert.equal(denied.kind, "denied");
  assert.deepEqual(admissionDecisionPolicy, {
    admitted: "result",
    denied: "error",
  });
});

test("every in-process operation requires one shared cancellation contract", () => {
  const cancellation = {
    code: "operation_cancelled",
    retryable: false,
  } satisfies CancellationError;

  declareFixtureCalls();
  assert.deepEqual(inProcessCancellationPolicy, {
    signal: "required",
    outcome: "result_error",
    error: cancellation,
  });
  assert.doesNotMatch(
    readFileSync("src/contracts/ports.ts", "utf8"),
    /signal\?\s*:\s*AbortSignal/,
  );
});

function declareFixtureCalls(): void {
  if (false) {
    const fixture = null as unknown as FixtureRuntime;
    // @ts-expect-error AbortSignal is required for every port operation
    void fixture.start({ fixtureRunId: "fixture-1" });
    void fixture.start(
      { fixtureRunId: "fixture-1" },
      AbortSignal.abort(),
    );
  }
}
