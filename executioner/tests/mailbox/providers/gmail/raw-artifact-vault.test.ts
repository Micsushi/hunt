import assert from "node:assert/strict";
import test from "node:test";

import { liveFixtures } from "../../../../src/testing/live/index.ts";
import { GmailRawArtifactVault } from "../../../../src/mailbox/providers/gmail/private/raw-artifact-vault.ts";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    metadata: liveFixtures.verificationArtifact,
    operationId: liveFixtures.operationIds.verificationNavigation,
    target: Uint8Array.from([11, 13]),
    policy: {
      host: Uint8Array.from([17, 19]),
      tenant: Uint8Array.from([23, 29]),
    },
    ...overrides,
  };
}

test("takes exact target and policy bytes once without leaving committed state", () => {
  const current = entry();
  const vault = new GmailRawArtifactVault();
  assert.equal(vault.stage([current]).commit(current.metadata.handleId), true);
  assert.deepEqual(
    vault.takeForAtomicConsume(
      current.operationId,
      current.metadata,
      liveFixtures.issuedAt,
    ),
    [current.target, current.policy.host, current.policy.tenant],
  );
  assert.equal(vault.committedCount, 0);
  assert.equal(
    vault.takeForAtomicConsume(
      current.operationId,
      current.metadata,
      liveFixtures.issuedAt,
    ),
    null,
  );
});

test("operation, scope, or expiry mismatch clears every byte", () => {
  const mismatches = [
    {
      operationId: "operation_fedcba9876543210" as never,
      metadata: liveFixtures.verificationArtifact,
      now: liveFixtures.issuedAt,
    },
    {
      operationId: liveFixtures.operationIds.verificationNavigation,
      metadata: {
        ...liveFixtures.verificationArtifact,
        journeyId: liveFixtures.otherJourneyId,
      },
      now: liveFixtures.issuedAt,
    },
    {
      operationId: liveFixtures.operationIds.verificationNavigation,
      metadata: liveFixtures.verificationArtifact,
      now: liveFixtures.verificationArtifact.expiresAt,
    },
  ] as const;
  for (const mismatch of mismatches) {
    const current = entry();
    const vault = new GmailRawArtifactVault();
    assert.equal(vault.stage([current]).commit(current.metadata.handleId), true);
    assert.equal(
      vault.takeForAtomicConsume(
        mismatch.operationId,
        mismatch.metadata,
        mismatch.now,
      ),
      null,
    );
    assert.deepEqual([...current.target], [0, 0]);
    assert.deepEqual([...current.policy.host], [0, 0]);
    assert.deepEqual([...current.policy.tenant], [0, 0]);
    assert.equal(vault.committedCount, 0);
  }
});

test("an ambiguous pending batch cannot commit and clears target plus policy bytes", () => {
  const first = entry();
  const second = entry({
    metadata: {
      ...liveFixtures.verificationArtifact,
      handleId: "verification_handle_fedcba9876543210" as never,
    },
  });
  const vault = new GmailRawArtifactVault();
  assert.equal(vault.stage([first, second]).commit(first.metadata.handleId), false);
  for (const current of [first, second]) {
    assert.deepEqual([...current.target], [0, 0]);
    assert.deepEqual([...current.policy.host], [0, 0]);
    assert.deepEqual([...current.policy.tenant], [0, 0]);
  }
  assert.equal(vault.committedCount, 0);
});
