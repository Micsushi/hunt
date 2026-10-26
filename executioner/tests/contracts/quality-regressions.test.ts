import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fieldId,
  fixturePageId,
  fixtureRunId,
  generatedOperationId,
  type FixtureFault,
  type FixtureFaultRequest,
  type FixtureRunState,
  type MutationReceipt,
  serializedContractCoverage,
} from "../../src/contracts/index.ts";

test("mutation receipts represent attempts only", () => {
  const attempted = {
    operationId: generatedOperationId("operation_0123456789abcdef"),
    fieldId: fieldId("field-1"),
    behavior: "text",
    attempted: true,
  } satisfies MutationReceipt;

  const notAttempted: MutationReceipt = {
    operationId: generatedOperationId("operation_fedcba9876543210"),
    fieldId: fieldId("field-2"),
    behavior: "text",
    // @ts-expect-error non-attempt is a DriverError, never a receipt
    attempted: false,
  };

  assert.equal(attempted.attempted, true);
  assert.equal(notAttempted.attempted, false);
});

test("fixture state and request share one closed fault type", () => {
  const fault = "component_failure" satisfies FixtureFault;
  const request = {
    fixtureRunId: fixtureRunId("fixture-1"),
    fault,
  } satisfies FixtureFaultRequest;
  const state = {
    fixtureRunId: fixtureRunId("fixture-1"),
    pageId: fixturePageId("account"),
    enabledFault: fault,
  } satisfies FixtureRunState;

  const invalid: FixtureRunState = {
    fixtureRunId: fixtureRunId("fixture-1"),
    pageId: fixturePageId("account"),
    // @ts-expect-error undeclared fixture faults are not representable
    enabledFault: "another_fault",
  };

  assert.equal(request.fault, state.enabledFault);
  assert.equal(invalid.enabledFault, "another_fault");
});

test("serialized runtime tuples exhaust their TypeScript unions", () => {
  assert.deepEqual(serializedContractCoverage, {
    componentIds: true,
    stableErrorCodes: true,
  });
});
