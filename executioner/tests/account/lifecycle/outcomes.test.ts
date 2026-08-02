import assert from "node:assert/strict";
import { test } from "node:test";

import { AccountVerificationLifecycle } from "../../../src/account/lifecycle/index.ts";
import {
  createCredentialMutationAdapterFake,
  createMailboxProviderFake,
  createPrivilegedVerificationNavigatorFake,
  createVerificationArtifactFake,
  liveFixtures,
} from "../../../src/testing/live/index.ts";
import { accountObserver, lifecycleInput } from "./support.ts";

test("target observations remain exact factual outcomes with zero effects", async () => {
  const cases = [
    [
      { kind: "target_mismatch", dimension: "host" },
      { kind: "target_mismatch", dimension: "host" },
    ],
    [
      { kind: "target_ambiguous" },
      { kind: "target_ambiguous" },
    ],
    [
      { kind: "posting_unavailable", reason: "removed" },
      { kind: "posting_unavailable", reason: "removed" },
    ],
  ] as const;
  for (const [observation, expected] of cases) {
    const credential = createCredentialMutationAdapterFake();
    const mailbox = createMailboxProviderFake();
    const artifacts = createVerificationArtifactFake();
    const navigator = createPrivilegedVerificationNavigatorFake();
    const accountState = accountObserver(observation as never);
    const lifecycle = new AccountVerificationLifecycle({
      credentialMutation: credential.port,
      mailbox: mailbox.port,
      artifacts: artifacts.port,
      navigator: navigator.port,
      accountState: accountState.port,
    });

    const result = await lifecycle.run(lifecycleInput(), new AbortController().signal);

    assert.deepEqual(result, {
      ok: true,
      value: {
        kind: "blocked",
        factualOutcome: { source: "target_identity", result: expected },
      },
    });
    assert.equal(credential.calls.length, 0);
    assert.equal(mailbox.calls.length, 0);
    assert.equal(artifacts.calls.length, 0);
    assert.equal(navigator.calls.length, 0);
  }
});

test("mailbox none, ambiguity, expiry, and consumed facts stop before artifact use", async () => {
  const cases = [
    [
      {
        ...liveFixtures.mailboxAvailable,
        candidateCount: 0,
        verificationHandle: null,
        receivedTimeBucket: null,
        expiresAt: null,
      },
      "mailbox_none",
    ],
    [
      { ...liveFixtures.mailboxAvailable, candidateCount: 2, verificationHandle: null },
      "mailbox_ambiguous",
    ],
    [
      { ...liveFixtures.mailboxAvailable, expiresAt: liveFixtures.pastAt },
      "mailbox_expired",
    ],
    [
      { ...liveFixtures.mailboxAvailable, verificationHandle: null },
      "mailbox_consumed",
    ],
  ] as const;
  for (const [mailboxResult, kind] of cases) {
    const credential = createCredentialMutationAdapterFake();
    const mailbox = createMailboxProviderFake({ result: mailboxResult });
    const artifacts = createVerificationArtifactFake();
    const navigator = createPrivilegedVerificationNavigatorFake();
    const accountState = accountObserver("verification_required");
    const lifecycle = new AccountVerificationLifecycle({
      credentialMutation: credential.port,
      mailbox: mailbox.port,
      artifacts: artifacts.port,
      navigator: navigator.port,
      accountState: accountState.port,
    });

    const result = await lifecycle.run(lifecycleInput(), new AbortController().signal);

    assert.deepEqual(result, {
      ok: true,
      value: {
        kind: "blocked",
        factualOutcome: {
          source: "mailbox_verification",
          result: { kind },
        },
      },
    });
    assert.equal(artifacts.calls.length, 0, kind);
    assert.equal(navigator.calls.length, 0, kind);
  }
});

test("an independently observed challenge remains an exact account-access fact", async () => {
  const credential = createCredentialMutationAdapterFake();
  const mailbox = createMailboxProviderFake();
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = accountObserver({
    kind: "classified_account",
    state: {
      kind: "manual_intervention",
      reason: "mfa",
      classificationId: "classification_account_mfa_v1",
      sourceRevisionId: "classification_revision_test_v1",
    },
    classificationId: "classification_account_mfa_v1",
    sourceRevisionId: "classification_revision_test_v1",
    snapshotId: "live_entry_snapshot_test_v1",
    documentGenerationId: "live_entry_document_test_v1",
  } as never);
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: mailbox.port,
    artifacts: artifacts.port,
    navigator: navigator.port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run(lifecycleInput(), new AbortController().signal);

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "blocked",
      factualOutcome: {
        source: "account_access",
        result: { kind: "manual_intervention", reason: "mfa" },
      },
    },
  });
  assert.equal(credential.calls.length, 0);
  assert.equal(mailbox.calls.length, 0);
});

test("ATS and Workday page classification stops keep their exact factual owner", async () => {
  const cases = [
    ["ats_unsupported", "ats_family"],
    ["ats_unknown", "ats_family"],
    ["ats_ambiguous", "ats_family"],
    ["workday_page_unknown", "workday_page_type"],
    ["workday_page_ambiguous", "workday_page_type"],
  ] as const;
  for (const [outcome, source] of cases) {
    const accountState = accountObserver({
      kind: "classification_stopped",
      outcome,
      classificationId: null,
      sourceRevisionId: "classification_revision_test_v1",
      snapshotId: "live_entry_snapshot_test_v1",
      documentGenerationId: "live_entry_document_test_v1",
    } as never);
    const lifecycle = new AccountVerificationLifecycle({
      credentialMutation: createCredentialMutationAdapterFake().port,
      mailbox: createMailboxProviderFake().port,
      artifacts: createVerificationArtifactFake().port,
      navigator: createPrivilegedVerificationNavigatorFake().port,
      accountState: accountState.port,
    });

    const result = await lifecycle.run(lifecycleInput(), new AbortController().signal);

    assert.deepEqual(result, {
      ok: true,
      value: {
        kind: "blocked",
        factualOutcome: { source, result: { kind: outcome } },
      },
    });
  }
});
