import assert from "node:assert/strict";
import { test } from "node:test";

import { livePortNames } from "../../../src/contracts/live/index.ts";
import {
  assertLiveProviderConformance,
  liveConformanceRegistry,
  liveFakeFactories,
  liveOperationCases,
  livePortOperations,
  liveProviderFactories,
  withLiveProvider,
} from "../../../src/testing/live/index.ts";

const expectedOperations = {
  PersistentBrowserSession: ["open", "reconcile", "close"],
  SecretStore: ["inspect", "revoke"],
  CredentialMutationAdapter: ["mutate"],
  PrivilegedGmailAuthExecutor: ["query"],
  MailboxProvider: ["poll"],
  VerificationArtifact: ["inspect", "invalidate"],
  PrivilegedVerificationNavigator: ["navigate"],
  LiveCheckpointStore: ["load", "save", "remove"],
  LiveEvidenceSink: ["seal", "cleanupPartials"],
} as const;

test("every frozen live port and operation has one fake, factory, and mandatory runner", () => {
  const names = [...livePortNames];
  assert.deepEqual(Object.keys(liveOperationCases), names);
  assert.deepEqual(Object.keys(livePortOperations), names);
  assert.deepEqual(Object.keys(liveFakeFactories), names);
  assert.deepEqual(Object.keys(liveProviderFactories), names);
  assert.deepEqual(livePortOperations, expectedOperations);
  assert.deepEqual(
    liveConformanceRegistry,
    names.map((name) => ({
      name,
      operations: expectedOperations[name],
      skip: false,
    })),
  );
});

test("every deterministic live fake passes the same result and cancellation contract", async () => {
  for (const name of livePortNames) {
    const fake = liveFakeFactories[name]();
    await assertLiveProviderConformance(name, fake.port);
    assert.deepEqual(
      fake.calls.map(({ operation }) => operation),
      expectedOperations[name].flatMap((operation) => [operation, operation]),
    );
  }
});

test("live provider factories isolate state and always clean their lease", async () => {
  const factory = liveProviderFactories.PersistentBrowserSession;
  const first = factory.create();
  const second = factory.create();
  assert.notEqual(first.provider, second.provider);
  assert.notEqual(first.calls, second.calls);
  await first.cleanup();
  await first.cleanup();
  assert.equal(first.cleaned, true);

  let captured: typeof second | undefined;
  await assert.rejects(
    withLiveProvider(factory, (_provider, lease) => {
      captured = lease;
      throw new Error("synthetic consumer failure");
    }),
    /synthetic consumer failure/u,
  );
  assert.equal(captured?.cleaned, true);
  await second.cleanup();
});
