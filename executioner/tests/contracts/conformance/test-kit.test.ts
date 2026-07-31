import assert from "node:assert/strict";
import { test } from "node:test";

import { portNames, type FixtureRuntime } from "../../../src/contracts/index.ts";
import {
  assertProviderConformance,
  contractFakeFactories,
  contractPortOperations,
} from "../../../src/testing/contracts/index.ts";

test("the shared kit has one narrow fake for every frozen port", () => {
  assert.deepEqual(Object.keys(contractFakeFactories), portNames);
  assert.deepEqual(Object.keys(contractPortOperations), portNames);

  for (const name of portNames) {
    const harness = contractFakeFactories[name]();
    assert.deepEqual(
      Object.keys(harness.port).sort(),
      [...contractPortOperations[name]].sort(),
      `${name} fake must expose only its declared operations`,
    );
    assert.deepEqual(harness.calls, []);
  }
});

test("every shared fake passes the same provider conformance helper", async () => {
  for (const name of portNames) {
    const harness = contractFakeFactories[name]();
    await assertProviderConformance(name, harness.port);
    assert.deepEqual(
      harness.calls.map(({ operation }) => operation),
      contractPortOperations[name].flatMap((operation) => [
        operation,
        operation,
      ]),
    );
  }
});

test("a provider that violates the result envelope fails conformance", async () => {
  const valid = contractFakeFactories.FixtureRuntime().port;
  const invalid = {
    ...valid,
    start: async () => ({ ok: true }),
  } as unknown as FixtureRuntime;

  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", invalid),
    /FixtureRuntime\.start.*value/u,
  );

  const extraErrorDetail = {
    ...valid,
    start: async () => ({
      ok: false,
      error: {
        code: "fixture_timeout",
        retryable: true,
        detail: "not part of the frozen error",
      },
    }),
  } as unknown as FixtureRuntime;

  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", extraErrorDetail),
    /FixtureRuntime\.start.*only code and retryable/u,
  );
});

test("conformance rejects invented successes and error codes", async () => {
  const valid = contractFakeFactories.FixtureRuntime().port;
  const inventedSuccess = {
    ...valid,
    start: async () => ({ ok: true, value: { invented: true } }),
  } as unknown as FixtureRuntime;
  const inventedError = {
    ...valid,
    start: async () => ({
      ok: false,
      error: { code: "invented_error", retryable: false },
    }),
  } as unknown as FixtureRuntime;

  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", inventedSuccess),
    /FixtureRuntime\.start.*success result/u,
  );
  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", inventedError),
    /FixtureRuntime\.start.*invented_error.*declared/u,
  );
});

test("cancellation is allowed only for an already-aborted signal", async () => {
  const valid = contractFakeFactories.FixtureRuntime().port;
  const cancelsLiveWork = {
    ...valid,
    start: async () => ({
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    }),
  } as unknown as FixtureRuntime;
  const ignoresCancellation = {
    ...valid,
    start: async () => ({
      ok: true,
      value: {
        fixtureRunId: "fixture-run-synthetic",
        origin: "https://fixture.invalid",
        pageId: "fixture-account",
      },
    }),
  } as unknown as FixtureRuntime;

  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", cancelsLiveWork),
    /FixtureRuntime\.start.*live signal.*operation_cancelled/u,
  );
  await assert.rejects(
    () => assertProviderConformance("FixtureRuntime", ignoresCancellation),
    /FixtureRuntime\.start.*aborted signal.*operation_cancelled/u,
  );
});
