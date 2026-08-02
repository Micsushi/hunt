import assert from "node:assert/strict";
import test from "node:test";

import { generatedOperationId } from "../../../../src/contracts/index.ts";
import type { VerificationArtifact } from "../../../../src/contracts/live/index.ts";
import { liveFixtures } from "../../../../src/testing/live/index.ts";
import { GmailAtomicArtifactConsumer } from "../../../../src/mailbox/providers/gmail/private/atomic-artifact-consumer.ts";
import { GmailRawArtifactVault } from "../../../../src/mailbox/providers/gmail/private/raw-artifact-vault.ts";
import { GmailSafeArtifactRegistry } from "../../../../src/mailbox/providers/gmail/safe-artifact-registry.ts";

const signal = () => new AbortController().signal;
const policyHost = () => new TextEncoder().encode("tenant.example.invalid");
const policyTenant = () => new TextEncoder().encode("example-tenant");
const rawTarget = () => new TextEncoder().encode(
  "https://tenant.example.invalid/verify?token=private",
);

function request() {
  return {
    operationId: liveFixtures.operationIds.verificationNavigation,
    journeyId: liveFixtures.journeyId,
    recipientBindingId: liveFixtures.verificationArtifact.recipientBindingId,
    target: liveFixtures.target,
    handleId: liveFixtures.verificationArtifact.handleId,
    now: liveFixtures.issuedAt,
    artifact: liveFixtures.verificationArtifact,
  } as const;
}

function harness(options: { readonly inspectError?: Error } = {}) {
  const rawVault = new GmailRawArtifactVault();
  const registry = new GmailSafeArtifactRegistry();
  const delegate: VerificationArtifact = {
    async inspect() {
      if (options.inspectError !== undefined) throw options.inspectError;
      return { ok: true, value: liveFixtures.verificationArtifact };
    },
    async invalidate() {
      return { ok: true, value: undefined };
    },
  };
  const target = rawTarget();
  const host = policyHost();
  const tenant = policyTenant();
  const pending = rawVault.stage([{
    metadata: liveFixtures.verificationArtifact,
    operationId: liveFixtures.operationIds.verificationNavigation,
    target,
    policy: { host, tenant },
  }]);
  assert.equal(pending.commit(liveFixtures.verificationArtifact.handleId), true);
  assert.equal(
    registry.register(
      liveFixtures.verificationArtifact.handleId,
      delegate,
      () => rawVault.invalidate(liveFixtures.verificationArtifact.handleId),
    ),
    true,
  );
  return {
    rawVault,
    registry,
    target,
    host,
    tenant,
    consumer: new GmailAtomicArtifactConsumer({
      rawVault,
      artifacts: registry,
    }),
  };
}

test("atomic consume removes safe and raw state, clears bytes, and replays one exact receipt", async () => {
  const current = harness();
  let callbackCalls = 0;
  let views: readonly Readonly<Uint8Array>[] = [];
  const first = await current.consumer.consume(
    request(),
    signal(),
    async (values) => {
      callbackCalls += 1;
      views = values;
      assert.equal(new TextDecoder().decode(values[0]), new TextDecoder().decode(rawTarget()));
      assert.equal(new TextDecoder().decode(values[1]), "tenant.example.invalid");
      assert.equal(new TextDecoder().decode(values[2]), "example-tenant");
      return {
        ok: true,
        value: { kind: "navigated", accountState: "verified" },
      } as const;
    },
  );
  assert.deepEqual(first, {
    ok: true,
    value: { kind: "navigated" },
  });
  assert.equal(callbackCalls, 1);
  assert.deepEqual(views.map((value) => [...value]), [
    new Array(current.target.length).fill(0),
    new Array(current.host.length).fill(0),
    new Array(current.tenant.length).fill(0),
  ]);
  assert.equal(current.rawVault.committedCount, 0);

  assert.deepEqual(
    await current.registry.port.inspect(
      {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        handleId: liveFixtures.verificationArtifact.handleId,
        expectedRecipientBindingId: liveFixtures.verificationArtifact.recipientBindingId,
        expectedTarget: liveFixtures.target,
      },
      signal(),
    ),
    {
      ok: false,
      error: { code: "verification_artifact_replayed", retryable: false },
    },
  );

  const cancelledReplay = new AbortController();
  cancelledReplay.abort();
  assert.deepEqual(
    await current.consumer.consume(request(), cancelledReplay.signal, async () => {
      callbackCalls += 1;
      return { ok: true, value: { kind: "target_unavailable" } } as const;
    }),
    first,
  );
  assert.deepEqual(
    await current.consumer.consume(
      { ...request(), now: "2026-08-01T12:00:00.001Z" },
      cancelledReplay.signal,
      async () => ({ ok: true, value: { kind: "target_unavailable" } } as const),
    ),
    {
      ok: false,
      error: { code: "verification_artifact_replayed", retryable: false },
    },
  );

  assert.deepEqual(
    await current.consumer.consume(request(), signal(), async () => {
      callbackCalls += 1;
      return { ok: true, value: { kind: "target_unavailable" } } as const;
    }),
    first,
  );
  assert.equal(callbackCalls, 1);
  assert.deepEqual(
    await current.consumer.consume(
      { ...request(), now: "2026-08-01T12:00:00.001Z" },
      signal(),
      async () => ({ ok: true, value: { kind: "target_unavailable" } } as const),
    ),
    {
      ok: false,
      error: { code: "verification_artifact_replayed", retryable: false },
    },
  );
});

test("different operation, expiry, and every cross-scope admission clear both stores", async () => {
  const cases = [
    { operationId: generatedOperationId("operation_fedcba9876543210") },
    { journeyId: liveFixtures.otherJourneyId },
    { recipientBindingId: "recipient_fedcba9876543210" as never },
    { target: liveFixtures.otherTarget },
    { handleId: "verification_handle_fedcba9876543210" as never },
    { now: liveFixtures.verificationArtifact.expiresAt },
  ] as const;
  for (const mismatch of cases) {
    const current = harness();
    let invoked = false;
    assert.deepEqual(
      await current.consumer.consume(
        { ...request(), ...mismatch },
        signal(),
        async () => {
          invoked = true;
          return { ok: true, value: { kind: "target_unavailable" } } as const;
        },
      ),
      {
        ok: false,
        error: { code: "verification_artifact_replayed", retryable: false },
      },
    );
    assert.equal(invoked, false);
    assert.equal(current.rawVault.committedCount, 0);
    assert.deepEqual([...current.target], new Array(current.target.length).fill(0));
    assert.deepEqual([...current.host], new Array(current.host.length).fill(0));
    assert.deepEqual([...current.tenant], new Array(current.tenant.length).fill(0));
    assert.deepEqual(
      await current.registry.port.inspect(
        {
          schemaVersion: 1,
          journeyId: liveFixtures.journeyId,
          handleId: liveFixtures.verificationArtifact.handleId,
          expectedRecipientBindingId:
            liveFixtures.verificationArtifact.recipientBindingId,
          expectedTarget: liveFixtures.target,
        },
        signal(),
      ),
      {
        ok: false,
        error: { code: "verification_artifact_replayed", retryable: false },
      },
    );
  }
});

test("callback failure and cancellation clear all bytes and expose no private detail", async () => {
  for (const cancelled of [false, true]) {
    const current = harness();
    const controller = new AbortController();
    if (cancelled) controller.abort();
    let callbackCalls = 0;
    const result = await current.consumer.consume(
      request(),
      controller.signal,
      async () => {
        callbackCalls += 1;
        throw new Error("synthetic-private-callback-detail");
      },
    );
    assert.deepEqual(result, cancelled
      ? {
        ok: false,
        error: { code: "operation_cancelled", retryable: false },
      }
      : {
        ok: false,
        error: { code: "verification_artifact_replayed", retryable: false },
      });
    assert.equal(callbackCalls, cancelled ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private/u);
    assert.equal(current.rawVault.committedCount, 0);
    assert.deepEqual([...current.target], new Array(current.target.length).fill(0));
    assert.deepEqual([...current.host], new Array(current.host.length).fill(0));
    assert.deepEqual([...current.tenant], new Array(current.tenant.length).fill(0));
  }
});

test("safe admission failure clears both stores and cannot escape its detail", async () => {
  const current = harness({
    inspectError: new Error("synthetic-private-inspection-detail"),
  });
  const result = await current.consumer.consume(
    request(),
    signal(),
    async () => ({ ok: true, value: { kind: "target_unavailable" } } as const),
  );
  assert.deepEqual(result, {
    ok: false,
    error: { code: "verification_artifact_replayed", retryable: false },
  });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private/u);
  assert.equal(current.rawVault.committedCount, 0);
  assert.deepEqual([...current.target], new Array(current.target.length).fill(0));
  assert.deepEqual([...current.host], new Array(current.host.length).fill(0));
  assert.deepEqual([...current.tenant], new Array(current.tenant.length).fill(0));
});

test("atomic consume preserves an exact downstream navigation failure after clearing bytes", async () => {
  const current = harness();
  let views: readonly Readonly<Uint8Array>[] = [];

  const result = await current.consumer.consume(
    request(),
    signal(),
    async (values) => {
      views = values;
      return {
        ok: false,
        error: { code: "browser_timeout", retryable: true },
      } as const;
    },
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_timeout", retryable: true },
  });
  assert.deepEqual(
    views.map((value) => [...value]),
    [
      new Array(current.target.length).fill(0),
      new Array(current.host.length).fill(0),
      new Array(current.tenant.length).fill(0),
    ],
  );
  assert.equal(current.rawVault.committedCount, 0);
  assert.deepEqual(
    await current.consumer.consume(
      request(),
      signal(),
      async () => ({ ok: true, value: { kind: "navigated" } } as const),
    ),
    {
      ok: false,
      error: { code: "verification_artifact_replayed", retryable: false },
    },
  );
});

test("atomic consume rejects a malformed downstream success instead of minting a safe receipt", async () => {
  const current = harness();
  assert.deepEqual(
    await current.consumer.consume(
      request(),
      signal(),
      async () => ({ ok: true, value: { kind: "unknown" } } as never),
    ),
    {
      ok: false,
      error: { code: "verification_artifact_replayed", retryable: false },
    },
  );
  assert.equal(current.rawVault.committedCount, 0);
  assert.deepEqual(
    await current.consumer.consume(
      request(),
      signal(),
      async () => ({ ok: true, value: { kind: "navigated" } } as const),
    ),
    {
      ok: false,
      error: { code: "verification_artifact_replayed", retryable: false },
    },
  );
});
