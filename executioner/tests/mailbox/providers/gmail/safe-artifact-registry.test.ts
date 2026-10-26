import assert from "node:assert/strict";
import test from "node:test";

import type { VerificationArtifact } from "../../../../src/contracts/live/index.ts";
import { liveFixtures } from "../../../../src/testing/live/index.ts";
import { GmailSafeArtifactRegistry } from "../../../../src/mailbox/providers/gmail/safe-artifact-registry.ts";

const signal = () => new AbortController().signal;

test("delegates only an admitted opaque artifact and rejects unknown or duplicate handles", async () => {
  let inspectCalls = 0;
  let invalidateCalls = 0;
  const delegate: VerificationArtifact = {
    async inspect() {
      inspectCalls += 1;
      return { ok: true, value: liveFixtures.verificationArtifact };
    },
    async invalidate() {
      invalidateCalls += 1;
      return { ok: true, value: undefined };
    },
  };
  const registry = new GmailSafeArtifactRegistry();
  let cleanupCalls = 0;

  assert.equal(
    registry.register(
      liveFixtures.verificationArtifact.handleId,
      delegate,
      () => { cleanupCalls += 1; },
    ),
    true,
  );
  assert.equal(
    registry.register(liveFixtures.verificationArtifact.handleId, delegate),
    false,
  );
  assert.deepEqual(
    await registry.port.inspect(
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
    { ok: true, value: liveFixtures.verificationArtifact },
  );
  assert.deepEqual(
    await registry.port.invalidate(
      {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: liveFixtures.operationIds.artifactInvalidate,
        handleId: liveFixtures.verificationArtifact.handleId,
      },
      signal(),
    ),
    { ok: true, value: undefined },
  );
  assert.equal(inspectCalls, 1);
  assert.equal(invalidateCalls, 1);
  assert.equal(cleanupCalls, 1);

  assert.deepEqual(
    await registry.port.inspect(
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
  assert.equal(inspectCalls, 1);
  assert.equal(cleanupCalls, 1);

  assert.deepEqual(
    await new GmailSafeArtifactRegistry().port.inspect(
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
});
