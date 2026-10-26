import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { livePortNames } from "../../../src/contracts/live/index.ts";
import {
  createLiveCheckpointStoreFake,
  createMailboxProviderFake,
  createPersistentBrowserSessionFake,
  createSecretStoreFake,
  createVerificationArtifactFake,
  createPrivilegedVerificationNavigatorFake,
  executeLiveScenarioRegistry,
  findLivePrivacyViolations,
  liveFixtures,
  liveScenarioRegistry,
  runEphemeralSentinelProof,
} from "../../../src/testing/live/index.ts";

const expectedScenarios = [
  ["persistent-browser-lifecycle", "PersistentBrowserSession"],
  ["secret-handle-scope", "SecretStore"],
  ["credential-mutation-idempotency", "CredentialMutationAdapter"],
  ["gmail-auth-cancellation", "PrivilegedGmailAuthExecutor"],
  ["mailbox-factual-preservation", "MailboxProvider"],
  ["verification-artifact-single-use", "VerificationArtifact"],
  ["verification-navigation-idempotency", "PrivilegedVerificationNavigator"],
  ["checkpoint-restart", "LiveCheckpointStore"],
  ["evidence-cleanup-idempotency", "LiveEvidenceSink"],
] as const;

test("one mandatory stateful scenario owns every live port without a second scheduler", async () => {
  assert.deepEqual(
    liveScenarioRegistry.map(({ name, port, skip }) => [name, port, skip]),
    expectedScenarios.map(([name, port]) => [name, port, false]),
  );
  assert.deepEqual(
    liveScenarioRegistry.map(({ port }) => port),
    [...livePortNames],
  );

  const reports = await executeLiveScenarioRegistry();
  assert.deepEqual(
    reports.map(({ name, ports }) => [name, ports]),
    expectedScenarios.map(([name, port]) => [name, [port]]),
  );
  assert.equal(reports.every(({ edges }) => edges.length > 0), true);

  const source = [
    "fakes.ts",
    "scenarios.ts",
    "registry.ts",
  ].map((file) => readFileSync(new URL(`../../../src/testing/live/${file}`, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(source, /\b(?:setTimeout|setInterval|queueMicrotask)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:scheduleRetry|retryLoop|backoff)\b/u);
});

test("secret metadata fails closed for provider, consumer, scope, journey, state, and time", async () => {
  const signal = new AbortController().signal;
  const cases = [
    ["provider", { metadata: { ...liveFixtures.accountSecret, provider: "synthetic_wrong_provider" } }, "secret_handle_mismatched"],
    ["consumer", {}, "secret_consumer_forbidden", { expectedConsumer: "gmail_auth_executor" }],
    ["scope", {}, "secret_handle_mismatched", { expectedPurpose: "gmail_oauth" }],
    ["journey", {}, "secret_handle_mismatched", { journeyId: liveFixtures.otherJourneyId }],
    ["state", { metadata: { ...liveFixtures.accountSecret, state: "revoked" } }, "secret_handle_invalid"],
    ["time", { metadata: { ...liveFixtures.accountSecret, expiresAt: liveFixtures.pastAt } }, "secret_handle_expired"],
  ] as const;

  for (const [label, options, code, requestOverride = {}] of cases) {
    const fake = createSecretStoreFake(options as never);
    const result = await fake.port.inspect(
      { ...liveFixtures.secretInspectRequest, ...requestOverride } as never,
      signal,
    );
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.error.code, code, label);
  }
});

test("mailbox fakes preserve none, ambiguous, and available facts exactly", async () => {
  const signal = new AbortController().signal;
  for (const expected of liveFixtures.mailboxFactualResults) {
    const fake = createMailboxProviderFake({ result: expected });
    const result = await fake.port.poll(liveFixtures.mailboxPollRequest, signal);
    assert.deepEqual(result, { ok: true, value: expected });
  }
});

test("browser and artifact boundaries reject every wrong target and scope dimension exactly", async () => {
  const signal = new AbortController().signal;
  const browser = createPersistentBrowserSessionFake();
  const dimensions = ["host", "tenant", "posting"] as const;
  for (const dimension of dimensions) {
    const expectedTarget = {
      ...liveFixtures.target,
      [`${dimension}Id`]: liveFixtures.otherTarget[`${dimension}Id`],
    };
    const result = await browser.port.reconcile(
      {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: liveFixtures.operationIds.browserReconcile,
        session: liveFixtures.session,
        expectedTarget,
      },
      signal,
    );
    assert.deepEqual(result, {
      ok: true,
      value: { kind: "target_mismatch", dimension },
    });
  }

  const artifactCases = [
    ["journey", { journeyId: liveFixtures.otherJourneyId }, "verification_artifact_replayed"],
    ["recipient", { expectedRecipientBindingId: "recipient_fedcba9876543210" }, "verification_artifact_replayed"],
    ["host", { expectedTarget: { ...liveFixtures.target, hostId: "host_fedcba9876543210" } }, "mailbox_query_invalid"],
    ["tenant", { expectedTarget: { ...liveFixtures.target, tenantId: "tenant_fedcba9876543210" } }, "mailbox_query_invalid"],
    ["posting", { expectedTarget: liveFixtures.otherTarget }, "mailbox_query_invalid"],
  ] as const;
  for (const [label, override, code] of artifactCases) {
    const artifact = createVerificationArtifactFake();
    const result = await artifact.port.inspect(
      {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        handleId: liveFixtures.verificationArtifact.handleId,
        expectedRecipientBindingId: liveFixtures.verificationArtifact.recipientBindingId,
        expectedTarget: liveFixtures.target,
        ...override,
      } as never,
      signal,
    );
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.error.code, code, label);
  }
});

test("mailbox query replay is stable, invalid time fails closed, and expired navigation cannot run", async () => {
  const signal = new AbortController().signal;
  const mailbox = createMailboxProviderFake();
  const first = await mailbox.port.poll(liveFixtures.mailboxPollRequest, signal);
  const replay = await mailbox.port.poll(liveFixtures.mailboxPollRequest, signal);
  assert.deepEqual(replay, first);
  const invalidTime = await mailbox.port.poll(
    {
      ...liveFixtures.mailboxPollRequest,
      notBefore: liveFixtures.expiresAt,
      notAfter: liveFixtures.issuedAt,
    },
    signal,
  );
  assert.deepEqual(invalidTime, {
    ok: false,
    error: { code: "mailbox_query_invalid", retryable: false },
  });

  const navigator = createPrivilegedVerificationNavigatorFake();
  const expired = await navigator.port.navigate(
    {
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      operationId: liveFixtures.operationIds.verificationNavigation,
      sessionId: liveFixtures.session.sessionId,
      artifact: { ...liveFixtures.verificationArtifact, state: "expired" },
    } as never,
    signal,
  );
  assert.deepEqual(expired, {
    ok: false,
    error: { code: "verification_artifact_replayed", retryable: false },
  });
});

test("checkpoint removal clears durable fake state", async () => {
  const signal = new AbortController().signal;
  const checkpoint = createLiveCheckpointStoreFake();
  assert.deepEqual(
    await checkpoint.port.remove(
      {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: liveFixtures.operationIds.checkpointRemove,
        checkpointId: liveFixtures.checkpoint.checkpointId,
      },
      signal,
    ),
    { ok: true, value: undefined },
  );
  assert.deepEqual(
    await checkpoint.port.load(
      {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        expectedRevisionId: liveFixtures.checkpoint.revisionId,
      },
      signal,
    ),
    { ok: true, value: null },
  );
});

test("private values are callback-only, cleared in finally, and absent from every observable graph", async () => {
  const proof = await runEphemeralSentinelProof();
  assert.deepEqual(proof, {
    callbacksObservedNonzeroBytes: 3,
    clearedBuffers: 4,
  });

  const reports = await executeLiveScenarioRegistry();
  const observable = {
    fixtures: liveFixtures.publicSnapshot,
    reports,
    calls: liveScenarioRegistry.map(({ inspectCalls }) => inspectCalls()),
  };
  assert.deepEqual(findLivePrivacyViolations(observable), []);
  assert.deepEqual(findLivePrivacyViolations(JSON.parse(JSON.stringify(observable))), []);
  assert.deepEqual(
    Object.keys(liveFixtures.mailboxAvailable),
    ["provider", "receivedTimeBucket", "expiresAt", "candidateCount", "verificationHandle"],
  );
});

test("privacy scanner rejects raw links, messages, credentials, and non-synthetic PII at any depth", () => {
  const unsafe = {
    nested: {
      password: "forbidden",
      messageBody: "forbidden",
      target: "https://example.invalid/path?token=forbidden",
      recipient: ["person", "example", "com"].join("@").replace("@com", ".com"),
    },
  };
  assert.deepEqual(findLivePrivacyViolations(unsafe), [
    "$.nested.messageBody:email_body",
    "$.nested.password:credential",
    "$.nested.recipient:pii",
    "$.nested.target:raw_url",
  ]);
});
