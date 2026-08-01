import assert from "node:assert/strict";
import { test } from "node:test";

import { generatedOperationId } from "../../../src/contracts/index.ts";
import { runSecureAccountSkeleton } from "../../../src/control/orchestrator/live/index.ts";
import {
  createCredentialMutationAdapterFake,
  createLiveCheckpointStoreFake,
  createMailboxProviderFake,
  createPrivilegedGmailAuthExecutorFake,
  createPrivilegedVerificationNavigatorFake,
  createVerificationArtifactFake,
  liveFixtures,
} from "../../../src/testing/live/index.ts";

const op = (suffix: string) => generatedOperationId(`operation_${suffix.padStart(16, "0")}`);

function input(mode: "fresh" | "restart" = "fresh") {
  return {
    schemaVersion: 1 as const,
    mode,
    journeyId: liveFixtures.journeyId,
    sessionId: liveFixtures.session.sessionId,
    target: liveFixtures.target,
    credential: liveFixtures.accountSecret,
    mailboxRequest: liveFixtures.mailboxPollRequest,
    revisionId: liveFixtures.checkpoint.revisionId,
    checkpointId: liveFixtures.checkpoint.checkpointId,
    leaseExpiresAt: liveFixtures.expiresAt,
    now: liveFixtures.issuedAt,
    operations: { mutate: op("31"), save: op("32"), navigate: op("33"), invalidate: op("34"), remove: op("35") },
  };
}

function setup(mailbox = liveFixtures.mailboxAvailable) {
  const credential = createCredentialMutationAdapterFake();
  const provider = createMailboxProviderFake({ result: mailbox });
  const artifact = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const checkpoints = createLiveCheckpointStoreFake();
  return { credential, provider, artifact, navigator, checkpoints, dependencies: {
    credentialMutation: credential.port,
    mailbox: provider.port,
    artifacts: artifact.port,
    navigator: navigator.port,
    checkpoints: checkpoints.port,
  } };
}

test("secure account flow stays value-blind and never invokes Gmail auth", async () => {
  const fixture = setup();
  const gmail = createPrivilegedGmailAuthExecutorFake();
  const result = await runSecureAccountSkeleton(fixture.dependencies, input(), new AbortController().signal);
  assert.deepEqual(result, { ok: true, value: { kind: "verification_complete" } });
  assert.deepEqual(fixture.credential.calls.map(({ operation }) => operation), ["mutate"]);
  assert.deepEqual(fixture.provider.calls.map(({ operation }) => operation), ["poll"]);
  assert.deepEqual(fixture.artifact.calls.map(({ operation }) => operation), ["inspect", "invalidate"]);
  assert.deepEqual(fixture.navigator.calls.map(({ operation }) => operation), ["navigate"]);
  assert.equal(gmail.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /https?:|password|token|oauth|raw/i);
});

test("mailbox and navigation factual outcomes remain exact and never retry", async () => {
  const cases = [
    [{ ...liveFixtures.mailboxAvailable, candidateCount: 0, verificationHandle: null, receivedTimeBucket: null, expiresAt: null }, "mailbox_none"],
    [{ ...liveFixtures.mailboxAvailable, candidateCount: 2, verificationHandle: null }, "mailbox_ambiguous"],
    [{ ...liveFixtures.mailboxAvailable, expiresAt: liveFixtures.pastAt }, "mailbox_expired"],
    [{ ...liveFixtures.mailboxAvailable, verificationHandle: null }, "mailbox_consumed"],
  ] as const;
  for (const [mailbox, kind] of cases) {
    const fixture = setup(mailbox);
    const result = await runSecureAccountSkeleton(fixture.dependencies, input(), new AbortController().signal);
    assert.deepEqual(result, { ok: true, value: { kind: "blocked", factualOutcome: { source: "mailbox_verification", result: { kind } } } });
    assert.equal(fixture.provider.calls.length, 1, kind);
    assert.equal(fixture.navigator.calls.length, 0, kind);
  }

  const unavailable = setup();
  unavailable.dependencies.navigator = createPrivilegedVerificationNavigatorFake({
    navigate: { ok: true, value: { kind: "target_unavailable" } },
  }).port;
  const result = await runSecureAccountSkeleton(unavailable.dependencies, input(), new AbortController().signal);
  assert.deepEqual(result, { ok: true, value: { kind: "blocked", factualOutcome: { source: "verification_navigation", result: { kind: "verification_target_unavailable" } } } });
});

test("restart re-queries mailbox, ignores persisted handle, and replay/cross-journey fail exact", async () => {
  const restart = setup();
  const result = await runSecureAccountSkeleton(restart.dependencies, input("restart"), new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(restart.credential.calls.length, 0);
  assert.equal(restart.provider.calls.length, 1);
  const saved = restart.checkpoints.calls.find(({ operation }) => operation === "save")?.request as { checkpoint: { verificationHandle: unknown } };
  assert.equal(saved.checkpoint.verificationHandle, null);

  const replay = setup();
  replay.dependencies.artifacts = createVerificationArtifactFake({ responses: {
    inspect: { ok: false, error: { code: "verification_artifact_replayed", retryable: false } },
  } }).port;
  const replayed = await runSecureAccountSkeleton(replay.dependencies, input(), new AbortController().signal);
  assert.equal(replayed.ok, false);
  if (!replayed.ok) assert.equal(replayed.error.code, "verification_artifact_replayed");

  const foreign = setup();
  const crossed = await runSecureAccountSkeleton(foreign.dependencies, { ...input(), journeyId: liveFixtures.otherJourneyId }, new AbortController().signal);
  assert.equal(crossed.ok, false);
  if (!crossed.ok) assert.equal(crossed.error.code, "secret_handle_mismatched");
});

test("uncertain credential effects fail exactly and never reach mailbox", async () => {
  const fixture = setup();
  fixture.dependencies.credentialMutation = createCredentialMutationAdapterFake({
    mutate: { ok: false, error: { code: "credential_effect_uncertain", retryable: false } },
  }).port;
  const result = await runSecureAccountSkeleton(fixture.dependencies, input(), new AbortController().signal);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.error, { code: "credential_effect_uncertain", retryable: false });
  assert.equal(fixture.provider.calls.length, 0);
});
