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
      contractPortOperations[name],
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
