import assert from "node:assert/strict";
import { test } from "node:test";

import { generatedOperationId } from "../../../src/contracts/index.ts";
import type { LiveCheckpointV1 } from "../../../src/contracts/live/index.ts";
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
const secureCheckpoint: LiveCheckpointV1 = {
  ...liveFixtures.checkpoint,
  phase: "mailbox_verification",
};

function input(
  mode: "fresh" | "restart" = "fresh",
  accountMode: "create_account" | "sign_in" = "create_account",
) {
  return {
    schemaVersion: 1 as const,
    mode,
    accountMode,
    journeyId: liveFixtures.journeyId,
    session: liveFixtures.session,
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

test("secure account forwards the admitted account mode without hardcoding create", async () => {
  const fixture = setup();
  await runSecureAccountSkeleton(
    fixture.dependencies,
    input("fresh", "sign_in"),
    new AbortController().signal,
  );
  const mutation = fixture.credential.calls[0]?.request as { readonly mode: string };
  assert.equal(mutation.mode, "sign_in");
});

function setup(mailbox = liveFixtures.mailboxAvailable) {
  const credential = createCredentialMutationAdapterFake();
  const provider = createMailboxProviderFake({ result: mailbox });
  const artifact = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const checkpoints = createLiveCheckpointStoreFake({
    load: { ok: true, value: secureCheckpoint },
  });
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

test("account access preserves every successful state and polls only after verification is required", async () => {
  const attemptedFields = ["email", "password"] as const;
  for (const kind of ["existing_account", "create_account", "application_ready"] as const) {
    const fixture = setup();
    fixture.dependencies.credentialMutation = createCredentialMutationAdapterFake({
      mutate: { ok: true, value: { kind, attemptedFields } },
    }).port;
    const result = await runSecureAccountSkeleton(
      fixture.dependencies,
      input(),
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      ok: true,
      value: { kind: "account_state", result: { kind, attemptedFields } },
    });
    assert.equal(fixture.provider.calls.length, 0, kind);
    assert.equal(fixture.checkpoints.calls.length, 0, kind);
  }

  const manual = setup();
  manual.dependencies.credentialMutation = createCredentialMutationAdapterFake({
    mutate: {
      ok: true,
      value: {
        kind: "manual_intervention",
        reason: "captcha",
        attemptedFields,
      },
    } as never,
  }).port;
  assert.deepEqual(
    await runSecureAccountSkeleton(
      manual.dependencies,
      input(),
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "blocked",
        factualOutcome: {
          source: "account_access",
          result: { kind: "manual_intervention", reason: "captcha" },
        },
      },
    },
  );
  assert.equal(manual.provider.calls.length, 0);
  assert.equal(manual.checkpoints.calls.length, 0);
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

  const removeFailure = setup();
  removeFailure.dependencies.navigator = createPrivilegedVerificationNavigatorFake({
    navigate: { ok: true, value: { kind: "target_unavailable" } },
  }).port;
  removeFailure.dependencies.checkpoints = createLiveCheckpointStoreFake({
    remove: {
      ok: false,
      error: { code: "recovery_checkpoint_cleanup_failed", retryable: false },
    },
  }).port;
  assert.deepEqual(
    await runSecureAccountSkeleton(
      removeFailure.dependencies,
      input(),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "recovery_checkpoint_cleanup_failed", retryable: false },
    },
  );
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

test("secure restart and nested requests require exact outer checkpoint and session bindings", async () => {
  const invalidCheckpoints: readonly LiveCheckpointV1[] = [
    { ...secureCheckpoint, checkpointId: "checkpoint_fedcba9876543210" as never },
    { ...secureCheckpoint, revisionId: "revision_fedcba9876543210" as never },
    { ...secureCheckpoint, phase: "account_access" },
    { ...secureCheckpoint, journeyId: liveFixtures.otherJourneyId },
    { ...secureCheckpoint, target: liveFixtures.otherTarget },
    { ...secureCheckpoint, sessionId: "live_session_fedcba9876543210" as never },
    { ...secureCheckpoint, profileLeaseId: "profile_lease_fedcba9876543210" as never },
    { ...secureCheckpoint, leaseExpiresAt: liveFixtures.pastAt },
  ];
  for (const checkpoint of invalidCheckpoints) {
    const fixture = setup();
    fixture.dependencies.checkpoints = createLiveCheckpointStoreFake({
      load: { ok: true, value: checkpoint },
    }).port;
    const result = await runSecureAccountSkeleton(
      fixture.dependencies,
      input("restart"),
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      ok: false,
      error: { code: "recovery_state_ambiguous", retryable: false },
    });
    assert.equal(fixture.provider.calls.length, 0);
  }

  for (const invalidInput of [
    {
      ...input(),
      session: { ...liveFixtures.session, target: liveFixtures.otherTarget },
    },
    {
      ...input(),
      mailboxRequest: {
        ...liveFixtures.mailboxPollRequest,
        journeyId: liveFixtures.otherJourneyId,
      },
    },
    {
      ...input(),
      mailboxRequest: {
        ...liveFixtures.mailboxPollRequest,
        target: liveFixtures.otherTarget,
      },
    },
    {
      ...input(),
      mailboxRequest: {
        ...liveFixtures.mailboxPollRequest,
        notBefore: liveFixtures.expiresAt,
        notAfter: liveFixtures.issuedAt,
      },
    },
  ]) {
    const fixture = setup();
    const result = await runSecureAccountSkeleton(
      fixture.dependencies,
      invalidInput,
      new AbortController().signal,
    );
    assert.equal(result.ok, false);
    assert.equal(fixture.credential.calls.length, 0);
    assert.equal(fixture.provider.calls.length, 0);
    assert.equal(fixture.checkpoints.calls.length, 0);
  }
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

test("unparsed invalid provider successes cannot satisfy the secure skeleton", async () => {
  const mutation = setup();
  mutation.dependencies.credentialMutation = createCredentialMutationAdapterFake({
    mutate: {
      ok: true,
      value: { kind: "application_ready", attemptedFields: ["email"] },
    } as never,
  }).port;
  assert.deepEqual(
    await runSecureAccountSkeleton(
      mutation.dependencies,
      input(),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "credential_mutation_denied", retryable: false },
    },
  );
  assert.equal(mutation.provider.calls.length, 0);

  const mailbox = setup();
  mailbox.dependencies.mailbox = createMailboxProviderFake({
    responses: {
      poll: {
        ok: true,
        value: {
          ...liveFixtures.mailboxAvailable,
          receivedTimeBucket: null,
          expiresAt: null,
        },
      } as never,
    },
  }).port;
  assert.deepEqual(
    await runSecureAccountSkeleton(
      mailbox.dependencies,
      input(),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "mailbox_query_invalid", retryable: false },
    },
  );
  assert.equal(mailbox.artifact.calls.length, 0);

  const navigation = setup();
  navigation.dependencies.navigator = createPrivilegedVerificationNavigatorFake({
    navigate: { ok: true, value: { kind: "unknown" } } as never,
  }).port;
  assert.deepEqual(
    await runSecureAccountSkeleton(
      navigation.dependencies,
      input(),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "verification_navigation_denied", retryable: false },
    },
  );

  const checkpoint = setup();
  checkpoint.dependencies.checkpoints = createLiveCheckpointStoreFake({
    load: { ok: true, value: { ...secureCheckpoint, raw: "forbidden" } } as never,
  }).port;
  assert.deepEqual(
    await runSecureAccountSkeleton(
      checkpoint.dependencies,
      input("restart"),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "recovery_checkpoint_invalid", retryable: false },
    },
  );
});
