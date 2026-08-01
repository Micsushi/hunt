import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { requiredFieldFlowCases } from "../../../src/testing/contracts/field-flow-cases.ts";
import {
  MAX_ACCEPTANCE_REPORT_BYTES,
  runDeterministicAcceptance,
} from "./t2-support.ts";
import { privateSentinels } from "./journey/support.ts";

const fixtureRoot = resolve("fixtures/workday/s1");

test("three clean happy and fault runs have identical sanitized projections", async () => {
  const result = await runDeterministicAcceptance({
    candidate: "1".repeat(40),
    fixtureRoot,
  });

  assert.equal(result.runs.happy.length, 3);
  assert.equal(result.runs.fault.length, 3);
  for (const scenario of [result.runs.happy, result.runs.fault]) {
    assert.deepEqual(scenario[1], scenario[0]);
    assert.deepEqual(scenario[2], scenario[0]);
    assert.equal(scenario[0]!.terminalCount, 1);
    assert.equal(scenario[0]!.progress.monotonic, true);
    assert.equal(scenario[0]!.privacy.sentinelsAbsent, true);
    assert.equal(scenario[0]!.privacy.resumeBytesDisposed, true);
    assert.equal(scenario[0]!.cleanupVerified, true);
  }

  const expectedFields = requiredFieldFlowCases.map(({ fieldId, behavior }) => ({
    fieldId,
    behavior,
    verification: "verified" as const,
  }));
  const happy = result.runs.happy[0]!;
  assert.deepEqual(happy.terminal, {
    status: "review_reached",
    completedPages: 3,
  });
  assert.equal(happy.progress.status, "review_reached");
  assert.deepEqual(happy.verifiedFields, expectedFields);
  assert.equal(happy.finalPage, "review");
  assert.equal(happy.submitTouched, false);
  assert.equal(happy.failure, null);

  const fault = result.runs.fault[0]!;
  assert.deepEqual(fault.terminal, {
    status: "failed",
    completedPages: 0,
    errorCode: "browser_target_invalid",
  });
  assert.equal(fault.progress.status, "failed");
  assert.deepEqual(fault.verifiedFields, []);
  assert.equal(fault.finalPage, null);
  assert.equal(fault.submitTouched, false);
  assert.deepEqual(fault.failure, {
    component: "F3",
    phase: "browser",
    step: "observe",
    code: "browser_target_invalid",
    retryable: false,
  });
  assert.deepEqual(fault.browserEffects, {
    observeCalls: 1,
    mutations: 0,
    navigations: 0,
  });

  const serialized = JSON.stringify(result.report);
  assert.ok(Buffer.byteLength(serialized) <= MAX_ACCEPTANCE_REPORT_BYTES);
  for (const sentinel of privateSentinels) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
});
