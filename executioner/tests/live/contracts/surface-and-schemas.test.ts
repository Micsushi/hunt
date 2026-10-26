import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as publicLive from "../../../src/contracts/live/index.ts";
import {
  ContractParseError,
  liveContractSchemas,
  liveContractVersions,
  livePortEffectCancellationPolicy,
  livePortOwnership,
  livePortNames,
  parseLiveBrowserSession,
  parseLiveCheckpoint,
  parseLiveEvidenceSeal,
  parseCredentialMutationResult,
  parseMailboxPollResult,
  parseSecretHandleMetadata,
  parseTargetIdentity,
  parseVerificationArtifactMetadata,
} from "../../../src/contracts/index.ts";
import {
  useEphemeralByteBatch,
  useEphemeralBytes,
  type EphemeralPrivilegedResult,
} from "../../../src/contracts/live/private/privileged-capabilities.ts";

const journeyId = "journey_0123456789abcdef";
const issuedAt = "2026-08-01T00:00:00.000Z";
const expiresAt = "2026-08-01T00:15:00.000Z";

function expectCode(
  run: () => unknown,
  code: ContractParseError["code"],
  path?: string,
): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof ContractParseError &&
      error.code === code &&
      (path === undefined || error.path === path),
  );
}

const target = {
  schemaVersion: 1,
  atsFamily: "workday",
  hostId: "host_0123456789abcdef",
  tenantId: "tenant_0123456789abcdef",
  postingId: "posting_0123456789abcdef",
} as const;

const session = {
  schemaVersion: 1,
  journeyId,
  sessionId: "live_session_0123456789abcdef",
  profileLeaseId: "profile_lease_0123456789abcdef",
  target,
  leaseExpiresAt: expiresAt,
} as const;

const accountSecret = {
  schemaVersion: 1,
  handleId: "secret_handle_0123456789abcdef",
  journeyId,
  provider: "windows_dpapi_current_user_v1",
  purpose: "account_credentials",
  consumer: "credential_mutation_adapter",
  issuedAt,
  expiresAt,
  state: "active",
} as const;

const gmailSecret = {
  ...accountSecret,
  handleId: "secret_handle_fedcba9876543210",
  purpose: "gmail_oauth",
  consumer: "gmail_auth_executor",
} as const;

const artifact = {
  schemaVersion: 1,
  handleId: "verification_handle_0123456789abcdef",
  journeyId,
  provider: "gmail_api_v1",
  recipientBindingId: "recipient_0123456789abcdef",
  target,
  issuedAt,
  expiresAt,
  state: "available",
} as const;

test("Stage 2 exposes only the nine frozen cancellable live ports", () => {
  assert.deepEqual(livePortNames, [
    "PersistentBrowserSession",
    "SecretStore",
    "CredentialMutationAdapter",
    "PrivilegedGmailAuthExecutor",
    "MailboxProvider",
    "VerificationArtifact",
    "PrivilegedVerificationNavigator",
    "LiveCheckpointStore",
    "LiveEvidenceSink",
  ]);
  assert.deepEqual(liveContractVersions, {
    targetIdentity: 1,
    persistentBrowserSession: 1,
    secretHandleMetadata: 1,
    mailboxPollResult: 1,
    verificationArtifact: 1,
    liveCheckpoint: 1,
    liveEvidence: 1,
  });

  const publicNames = Object.keys(publicLive);
  assert.equal(publicNames.includes("useEphemeralBytes"), false);
  assert.equal(publicNames.some((name) => /resolver|plaintext|raw|private/iu.test(name)), false);
  assert.doesNotMatch(
    readFileSync(new URL("../../../src/contracts/live/index.ts", import.meta.url), "utf8"),
    /private\/privileged-capabilities/iu,
  );
  assert.deepEqual(livePortEffectCancellationPolicy, {
    beforeEffect: "operation_cancelled",
    persistentBrowserAfterPossibleEffect: "browser_effect_uncertain",
    credentialMutationAfterPossibleEffect: "credential_effect_uncertain",
    verificationNavigationAfterPossibleEffect: "browser_effect_uncertain",
  });
});

test("live ownership is additive and plaintext resolution has two consumers", () => {
  assert.deepEqual(
    livePortOwnership.map(({ port, owner }) => [port, owner]),
    [
      ["PersistentBrowserSession", "F3"],
      ["SecretStore", "S2_SECRET_STORE"],
      ["CredentialMutationAdapter", "S2_CREDENTIAL_MUTATION"],
      ["PrivilegedGmailAuthExecutor", "S2_GMAIL_AUTH"],
      ["MailboxProvider", "S2_MAILBOX_PROVIDER"],
      ["VerificationArtifact", "S2_MAILBOX_PROVIDER"],
      ["PrivilegedVerificationNavigator", "S2_VERIFICATION_NAVIGATOR"],
      ["LiveCheckpointStore", "S2_RECOVERY_CHECKPOINT"],
      ["LiveEvidenceSink", "F11"],
    ],
  );
  assert.deepEqual(
    livePortOwnership.flatMap(({ privilegedValueConsumers }) =>
      privilegedValueConsumers,
    ),
    ["CredentialMutationAdapter", "PrivilegedGmailAuthExecutor"],
  );
});

test("ordinary mailbox and account requests carry only their least-authority handles", () => {
  const source = readFileSync(
    new URL("../../../src/contracts/live/types.ts", import.meta.url),
    "utf8",
  );
  const mailboxPoll = source.match(
    /export interface MailboxPollRequest \{(?<body>[\s\S]*?)\n\}/u,
  )?.groups?.body;
  const privilegedQueryPattern = new RegExp(
    "export interface PrivilegedGmailQueryRequest extends " +
      "MailboxPollRequest \\{(?<body>[\\s\\S]*?)\\n\\}",
    "u",
  );
  const privilegedQuery = source.match(privilegedQueryPattern)?.groups?.body;
  const credentialMutation = source.match(
    /export interface CredentialMutationRequest \{(?<body>[\s\S]*?)\n\}/u,
  )?.groups?.body;

  assert.ok(mailboxPoll);
  assert.doesNotMatch(mailboxPoll, /authorization|oauth|secret/iu);
  assert.match(privilegedQuery ?? "", /authorization: ActiveGmailSecretHandle/u);
  assert.match(credentialMutation ?? "", /credential: ActiveAccountSecretHandle/u);
  assert.match(
    credentialMutation ?? "",
    /fields: readonly \("email" \| "password"\)\[\]/u,
  );
  assert.doesNotMatch(source, /interface CredentialFieldHandle/u);
});

test("target and browser session parsers preserve only opaque exact identity", () => {
  assert.deepEqual(parseTargetIdentity(target), target);
  assert.deepEqual(parseLiveBrowserSession(session), session);
  assert.equal(liveContractSchemas.targetIdentity.additionalProperties, false);
  assert.equal(liveContractSchemas.persistentBrowserSession.additionalProperties, false);
  assert.equal(
    liveContractSchemas.targetIdentity.properties.hostId.pattern,
    "^host_[A-Za-z0-9_-]{16,64}$",
  );
  assert.equal(
    liveContractSchemas.persistentBrowserSession.properties.sessionId.pattern,
    "^live_session_[A-Za-z0-9_-]{16,64}$",
  );

  for (const [key, value] of [
    ["url", "https://invalid.test/path?token=private"],
    ["path", "/candidate/home"],
    ["query", "token=private"],
    ["fragment", "private"],
    ["selector", "#private"],
  ] as const) {
    expectCode(
      () => parseTargetIdentity({ ...target, [key]: value }),
      "extra_key",
      `$.${key}`,
    );
  }
  for (const hostId of [
    "https://invalid.test",
    "C:\\private\\profile",
    "person@example.invalid",
  ]) {
    expectCode(
      () => parseTargetIdentity({ ...target, hostId }),
      "invalid_value",
      "$.hostId",
    );
  }
  expectCode(
    () => parseLiveBrowserSession({ ...session, journeyId: "wrong" }),
    "invalid_value",
    "$.journeyId",
  );
  expectCode(
    () => parseLiveBrowserSession({ ...session, leaseExpiresAt: "not-a-time" }),
    "invalid_value",
    "$.leaseExpiresAt",
  );
});

test("secret metadata closes provider, consumer, purpose, journey, and time", () => {
  assert.deepEqual(parseSecretHandleMetadata(accountSecret), accountSecret);
  assert.deepEqual(parseSecretHandleMetadata(gmailSecret), gmailSecret);
  assert.equal(liveContractSchemas.secretHandleMetadata.additionalProperties, false);

  const rejected = [
    [{ ...accountSecret, provider: "plaintext_file_v1" }, "$.provider"],
    [{ ...accountSecret, consumer: "generic_driver" }, "$.consumer"],
    [{ ...accountSecret, purpose: "gmail_oauth" }, "$.consumer"],
    [{ ...accountSecret, journeyId: "wrong" }, "$.journeyId"],
    [{ ...accountSecret, expiresAt: issuedAt }, "$.expiresAt"],
    [{ ...accountSecret, state: "consumed" }, "$.state"],
  ] as const;
  for (const [value, path] of rejected) {
    expectCode(() => parseSecretHandleMetadata(value), "invalid_value", path);
  }
  for (const key of ["password", "secret", "token", "ciphertext", "path"] as const) {
    expectCode(
      () => parseSecretHandleMetadata({ ...accountSecret, [key]: "private" }),
      "extra_key",
      `$.${key}`,
    );
  }
});

test("mailbox poll returns exactly the safe five fields", () => {
  const result = {
    provider: "gmail_api_v1",
    receivedTimeBucket: "2026-08-01T00:00Z",
    expiresAt,
    candidateCount: 1,
    verificationHandle: artifact.handleId,
  } as const;
  assert.deepEqual(parseMailboxPollResult(result), result);
  assert.deepEqual(Object.keys(result), [
    "provider",
    "receivedTimeBucket",
    "expiresAt",
    "candidateCount",
    "verificationHandle",
  ]);
  assert.equal(liveContractSchemas.mailboxPollResult.additionalProperties, false);

  for (const key of [
    "subject",
    "sender",
    "recipient",
    "messageId",
    "threadId",
    "headers",
    "url",
    "token",
    "body",
    "oauth",
  ] as const) {
    expectCode(
      () => parseMailboxPollResult({ ...result, [key]: "private" }),
      "extra_key",
      `$.${key}`,
    );
  }
  expectCode(
    () => parseMailboxPollResult({ ...result, provider: "imap_v1" }),
    "invalid_value",
    "$.provider",
  );
  expectCode(
    () => parseMailboxPollResult({ ...result, candidateCount: 0 }),
    "invalid_value",
    "$.verificationHandle",
  );

  const consumed = { ...result, verificationHandle: null };
  assert.deepEqual(parseMailboxPollResult(consumed), consumed);
  assert.deepEqual(
    parseMailboxPollResult({ ...result, candidateCount: 0, verificationHandle: null }),
    { ...result, candidateCount: 0, verificationHandle: null },
  );
  assert.deepEqual(
    parseMailboxPollResult({
      ...result,
      candidateCount: 2,
      receivedTimeBucket: null,
      expiresAt: null,
      verificationHandle: null,
    }),
    {
      ...result,
      candidateCount: 2,
      receivedTimeBucket: null,
      expiresAt: null,
      verificationHandle: null,
    },
  );

  for (const invalid of [
    { ...result, candidateCount: 0 },
    { ...result, candidateCount: 2 },
  ]) {
    expectCode(
      () => parseMailboxPollResult(invalid),
      "invalid_value",
    );
  }
});

test("credential mutation result preserves exact account and manual states", () => {
  const attemptedFields = ["email", "password"] as const;
  for (const kind of [
    "existing_account",
    "create_account",
    "verification_required",
    "application_ready",
  ] as const) {
    const value = { kind, attemptedFields };
    assert.deepEqual(parseCredentialMutationResult(value), value);
  }
  for (const reason of ["captcha", "mfa", "access_control"] as const) {
    const value = { kind: "manual_intervention" as const, reason, attemptedFields };
    assert.deepEqual(parseCredentialMutationResult(value), value);
  }
  assert.equal(
    liveContractSchemas.credentialMutationResult.additionalProperties,
    false,
  );
  for (const invalid of [
    { kind: "unknown", attemptedFields },
    { kind: "manual_intervention", attemptedFields },
    { kind: "application_ready", reason: "captcha", attemptedFields },
    { kind: "existing_account", attemptedFields: ["email"] },
  ]) {
    assert.throws(() => parseCredentialMutationResult(invalid), ContractParseError);
  }
});

test("verification artifacts preserve factual state while replay stays explicit", () => {
  assert.deepEqual(parseVerificationArtifactMetadata(artifact), artifact);
  assert.deepEqual(
    parseVerificationArtifactMetadata({ ...artifact, state: "consumed" }),
    { ...artifact, state: "consumed" },
  );
  assert.equal(liveContractSchemas.verificationArtifact.additionalProperties, false);

  expectCode(
    () => parseVerificationArtifactMetadata({ ...artifact, provider: "imap_v1" }),
    "invalid_value",
    "$.provider",
  );
  expectCode(
    () => parseVerificationArtifactMetadata({ ...artifact, state: "replayed" }),
    "invalid_value",
    "$.state",
  );
  expectCode(
    () => parseVerificationArtifactMetadata({ ...artifact, expiresAt: issuedAt }),
    "invalid_value",
    "$.expiresAt",
  );
  for (const key of ["url", "token", "messageId", "recipient"] as const) {
    expectCode(
      () => parseVerificationArtifactMetadata({ ...artifact, [key]: "private" }),
      "extra_key",
      `$.${key}`,
    );
  }
});

test("checkpoint and evidence parsers keep only value-blind admitted state", () => {
  const checkpoint = {
    schemaVersion: 1,
    journeyId,
    checkpointId: "checkpoint_0123456789abcdef",
    revisionId: "revision_0123456789abcdef",
    phase: "mailbox_verification",
    target,
    sessionId: session.sessionId,
    profileLeaseId: session.profileLeaseId,
    verificationHandle: artifact.handleId,
    leaseExpiresAt: expiresAt,
  } as const;
  const evidence = {
    schemaVersion: 1,
    journeyId,
    evidenceId: "live_evidence_0123456789abcdef",
    manifestId: "manifest_0123456789abcdef",
    recordCount: 3,
    sealedAt: issuedAt,
  } as const;
  assert.deepEqual(parseLiveCheckpoint(checkpoint), checkpoint);
  assert.deepEqual(parseLiveEvidenceSeal(evidence), evidence);
  assert.equal(liveContractSchemas.liveCheckpoint.additionalProperties, false);
  assert.equal(liveContractSchemas.liveEvidence.additionalProperties, false);

  for (const key of ["sessionId", "profileLeaseId"] as const) {
    expectCode(
      () => parseLiveCheckpoint({ ...checkpoint, [key]: null }),
      "invalid_value",
      `$.${key}`,
    );
  }

  for (const key of ["url", "dom", "screenshot", "password", "rawValue"] as const) {
    expectCode(
      () => parseLiveCheckpoint({ ...checkpoint, [key]: "private" }),
      "extra_key",
      `$.${key}`,
    );
    expectCode(
      () => parseLiveEvidenceSeal({ ...evidence, [key]: "private" }),
      "extra_key",
      `$.${key}`,
    );
  }
});

test("private one-call bytes are zeroed after success and failure", async () => {
  const successBytes = new Uint8Array([11, 22, 33]);
  const success = await useEphemeralBytes(successBytes, async (value) => {
    assert.deepEqual([...value], [11, 22, 33]);
    return { kind: "completed" } satisfies EphemeralPrivilegedResult;
  });
  assert.deepEqual(success, { kind: "completed" });
  assert.deepEqual([...successBytes], [0, 0, 0]);

  const failedBytes = new Uint8Array([44, 55, 66]);
  await assert.rejects(
    useEphemeralBytes(failedBytes, async () => {
      throw new Error("synthetic provider failure");
    }),
    /synthetic provider failure/,
  );
  assert.deepEqual([...failedBytes], [0, 0, 0]);

  const batch = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const batchResult = await useEphemeralByteBatch(batch, async (values) => {
    assert.deepEqual(values.map((value) => [...value]), [[1, 2], [3, 4]]);
    return { kind: "completed" } satisfies EphemeralPrivilegedResult;
  });
  assert.deepEqual(batchResult, { kind: "completed" });
  assert.deepEqual(batch.map((value) => [...value]), [[0, 0], [0, 0]]);
});
