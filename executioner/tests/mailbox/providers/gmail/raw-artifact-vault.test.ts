import assert from "node:assert/strict";
import test from "node:test";

import { liveFixtures } from "../../../../src/testing/live/index.ts";
import { GmailRawArtifactVault } from "../../../../src/mailbox/providers/gmail/private/raw-artifact-vault.ts";

const signal = () => new AbortController().signal;

test("failed admission clears raw bytes and an admitted artifact resolves once", async () => {
  const rawTarget = Uint8Array.from([11, 13, 17, 19]);
  const vault = new GmailRawArtifactVault();
  const pending = vault.stage([{
    metadata: liveFixtures.verificationArtifact,
    target: rawTarget,
  }]);
  assert.equal(pending.commit(liveFixtures.verificationArtifact.handleId), true);

  let invoked = false;
  assert.equal(
    await vault.useForNavigator(
      { ...liveFixtures.verificationArtifact, journeyId: liveFixtures.otherJourneyId },
      liveFixtures.issuedAt,
      signal(),
      async () => {
        invoked = true;
        return { kind: "target_unavailable" };
      },
    ),
    null,
  );
  assert.equal(invoked, false);
  assert.deepEqual([...rawTarget], [0, 0, 0, 0]);
  assert.equal(vault.committedCount, 0);

  const admittedTarget = Uint8Array.from([11, 13, 17, 19]);
  assert.equal(vault.stage([{
    metadata: liveFixtures.verificationArtifact,
    target: admittedTarget,
  }]).commit(liveFixtures.verificationArtifact.handleId), true);

  let callbackView: Readonly<Uint8Array> | undefined;
  assert.deepEqual(
    await vault.useForNavigator(
      liveFixtures.verificationArtifact,
      liveFixtures.issuedAt,
      signal(),
      async (target) => {
        callbackView = target;
        assert.deepEqual([...target], [11, 13, 17, 19]);
        return { kind: "navigated", accountState: "verified" };
      },
    ),
    { kind: "navigated", accountState: "verified" },
  );
  assert.deepEqual([...(callbackView ?? [])], [0, 0, 0, 0]);
  assert.equal(vault.committedCount, 0);
  assert.equal(
    await vault.useForNavigator(
      liveFixtures.verificationArtifact,
      liveFixtures.issuedAt,
      signal(),
      async () => ({ kind: "target_unavailable" }),
    ),
    null,
  );
});

test("expiry clears a committed raw target before any navigator callback", async () => {
  const rawTarget = Uint8Array.from([41, 43]);
  const vault = new GmailRawArtifactVault();
  assert.equal(vault.stage([{
    metadata: liveFixtures.verificationArtifact,
    target: rawTarget,
  }]).commit(liveFixtures.verificationArtifact.handleId), true);
  let invoked = false;
  assert.equal(
    await vault.useForNavigator(
      liveFixtures.verificationArtifact,
      liveFixtures.verificationArtifact.expiresAt,
      signal(),
      async () => {
        invoked = true;
        return { kind: "target_unavailable" };
      },
    ),
    null,
  );
  assert.equal(invoked, false);
  assert.deepEqual([...rawTarget], [0, 0]);
  assert.equal(vault.committedCount, 0);
});

test("a pending ambiguous batch cannot commit and clears every raw target", () => {
  const first = Uint8Array.from([23, 29]);
  const second = Uint8Array.from([31, 37]);
  const vault = new GmailRawArtifactVault();
  const pending = vault.stage([
    { metadata: liveFixtures.verificationArtifact, target: first },
    {
      metadata: {
        ...liveFixtures.verificationArtifact,
        handleId: "verification_handle_fedcba9876543210" as never,
      },
      target: second,
    },
  ]);
  assert.equal(pending.commit(liveFixtures.verificationArtifact.handleId), false);
  assert.deepEqual([...first], [0, 0]);
  assert.deepEqual([...second], [0, 0]);
  assert.equal(vault.committedCount, 0);
});
