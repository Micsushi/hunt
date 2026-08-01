import assert from "node:assert/strict";
import { test } from "node:test";

import { generatedOperationId } from "../../../src/contracts/index.ts";
import {
  createCredentialMutationAdapterFake,
  createMailboxProviderFake,
  createPrivilegedGmailAuthExecutorFake,
  createPrivilegedVerificationNavigatorFake,
  liveFixtures,
} from "../../../src/testing/live/index.ts";

const signal = () => new AbortController().signal;
const alternateOperation = generatedOperationId("operation_fedcba9876543210");

const credentialRequest = () => ({
  schemaVersion: 1 as const,
  journeyId: liveFixtures.journeyId,
  operationId: liveFixtures.operationIds.credentialMutation,
  sessionId: liveFixtures.session.sessionId,
  target: liveFixtures.target,
  now: liveFixtures.issuedAt,
  mode: "create_account" as const,
  credential: liveFixtures.accountSecret,
  fields: ["email", "password"] as const,
});

const gmailRequest = () => ({
  ...liveFixtures.mailboxPollRequest,
  now: liveFixtures.issuedAt,
  authorization: liveFixtures.gmailSecret,
});

const navigationRequest = () => ({
  schemaVersion: 1 as const,
  journeyId: liveFixtures.journeyId,
  operationId: liveFixtures.operationIds.verificationNavigation,
  sessionId: liveFixtures.session.sessionId,
  expectedRecipientBindingId:
    liveFixtures.verificationArtifact.recipientBindingId,
  expectedTarget: liveFixtures.target,
  now: liveFixtures.issuedAt,
  artifact: liveFixtures.verificationArtifact,
});

test("credential mutation rejects inactive, expired, foreign, unbound, and conflicting replay requests exactly", async () => {
  const cases = [
    [{ credential: { ...liveFixtures.accountSecret, state: "revoked" } }, "secret_handle_invalid"],
    [{ credential: { ...liveFixtures.accountSecret, expiresAt: liveFixtures.pastAt } }, "secret_handle_expired"],
    [{ credential: { ...liveFixtures.accountSecret, provider: "synthetic_wrong_provider" } }, "secret_handle_mismatched"],
    [{ credential: { ...liveFixtures.accountSecret, purpose: "gmail_oauth" } }, "secret_handle_mismatched"],
    [{ credential: { ...liveFixtures.accountSecret, consumer: "gmail_auth_executor" } }, "secret_consumer_forbidden"],
    [{ credential: { ...liveFixtures.accountSecret, journeyId: liveFixtures.otherJourneyId } }, "secret_handle_mismatched"],
    [{ sessionId: "live_session_fedcba9876543210" }, "credential_mutation_denied"],
    [{ target: liveFixtures.otherTarget }, "credential_mutation_denied"],
  ] as const;
  for (const [override, code] of cases) {
    const fake = createCredentialMutationAdapterFake();
    const result = await fake.port.mutate(
      { ...credentialRequest(), ...override } as never,
      signal(),
    );
    assert.equal(result.ok, false, code);
    if (!result.ok) assert.equal(result.error.code, code);
  }

  const replay = createCredentialMutationAdapterFake();
  assert.equal((await replay.port.mutate(credentialRequest(), signal())).ok, true);
  const conflict = await replay.port.mutate(
    { ...credentialRequest(), mode: "sign_in" },
    signal(),
  );
  assert.deepEqual(conflict, {
    ok: false,
    error: { code: "credential_effect_uncertain", retryable: false },
  });
});

test("Gmail and mailbox fakes reject every secret, journey, target, recipient, time, and replay mismatch", async () => {
  const gmailCases = [
    [{ authorization: { ...liveFixtures.gmailSecret, state: "revoked" } }, "secret_handle_invalid"],
    [{ authorization: { ...liveFixtures.gmailSecret, expiresAt: liveFixtures.pastAt } }, "secret_handle_expired"],
    [{ authorization: { ...liveFixtures.gmailSecret, provider: "synthetic_wrong_provider" } }, "secret_handle_mismatched"],
    [{ authorization: { ...liveFixtures.gmailSecret, purpose: "account_credentials" } }, "secret_handle_mismatched"],
    [{ authorization: { ...liveFixtures.gmailSecret, consumer: "credential_mutation_adapter" } }, "secret_consumer_forbidden"],
    [{ authorization: { ...liveFixtures.gmailSecret, journeyId: liveFixtures.otherJourneyId } }, "secret_handle_mismatched"],
    [{ target: liveFixtures.otherTarget }, "mailbox_query_invalid"],
    [{ recipientBindingId: "recipient_fedcba9876543210" }, "mailbox_query_invalid"],
    [{ notBefore: liveFixtures.expiresAt, notAfter: liveFixtures.issuedAt }, "mailbox_query_invalid"],
  ] as const;
  for (const [override, code] of gmailCases) {
    const fake = createPrivilegedGmailAuthExecutorFake();
    const result = await fake.port.query(
      { ...gmailRequest(), ...override } as never,
      signal(),
    );
    assert.equal(result.ok, false, code);
    if (!result.ok) assert.equal(result.error.code, code);
  }

  const mailboxCases = [
    { journeyId: liveFixtures.otherJourneyId },
    { target: liveFixtures.otherTarget },
    { target: { ...liveFixtures.target, hostId: liveFixtures.otherTarget.hostId } },
    { target: { ...liveFixtures.target, tenantId: liveFixtures.otherTarget.tenantId } },
    { recipientBindingId: "recipient_fedcba9876543210" },
    { notBefore: liveFixtures.expiresAt, notAfter: liveFixtures.issuedAt },
  ] as const;
  for (const override of mailboxCases) {
    const fake = createMailboxProviderFake();
    assert.deepEqual(
      await fake.port.poll(
        { ...liveFixtures.mailboxPollRequest, ...override } as never,
        signal(),
      ),
      { ok: false, error: { code: "mailbox_query_invalid", retryable: false } },
    );
  }

  const replay = createMailboxProviderFake();
  assert.equal((await replay.port.poll(liveFixtures.mailboxPollRequest, signal())).ok, true);
  assert.deepEqual(
    await replay.port.poll(
      {
        ...liveFixtures.mailboxPollRequest,
        target: liveFixtures.otherTarget,
      },
      signal(),
    ),
    { ok: false, error: { code: "mailbox_query_invalid", retryable: false } },
  );
});

test("verification navigator independently revalidates admission and permits only idempotent same-operation replay", async () => {
  const admissionCases = [
    { journeyId: liveFixtures.otherJourneyId },
    { sessionId: "live_session_fedcba9876543210" },
    { expectedRecipientBindingId: "recipient_fedcba9876543210" },
    { expectedTarget: liveFixtures.otherTarget },
    { artifact: { ...liveFixtures.verificationArtifact, recipientBindingId: "recipient_fedcba9876543210" } },
    { artifact: { ...liveFixtures.verificationArtifact, target: liveFixtures.otherTarget } },
    { artifact: { ...liveFixtures.verificationArtifact, expiresAt: liveFixtures.pastAt } },
  ] as const;
  for (const override of admissionCases) {
    const fake = createPrivilegedVerificationNavigatorFake();
    assert.deepEqual(
      await fake.port.navigate(
        { ...navigationRequest(), ...override } as never,
        signal(),
      ),
      {
        ok: false,
        error: { code: "verification_navigation_denied", retryable: false },
      },
    );
  }

  const factualReplay = createPrivilegedVerificationNavigatorFake();
  assert.deepEqual(
    await factualReplay.port.navigate(
      {
        ...navigationRequest(),
        artifact: { ...liveFixtures.verificationArtifact, state: "consumed" },
      } as never,
      signal(),
    ),
    {
      ok: false,
      error: { code: "verification_artifact_replayed", retryable: false },
    },
  );

  const replay = createPrivilegedVerificationNavigatorFake();
  const request = navigationRequest();
  assert.equal((await replay.port.navigate(request, signal())).ok, true);
  assert.equal((await replay.port.navigate(request, signal())).ok, true);
  assert.deepEqual(
    await replay.port.navigate(
      { ...request, operationId: alternateOperation },
      signal(),
    ),
    {
      ok: false,
      error: { code: "verification_artifact_replayed", retryable: false },
    },
  );
});
