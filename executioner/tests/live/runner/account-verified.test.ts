import assert from "node:assert/strict";
import test from "node:test";

import {
  runStage2AccountVerified,
  type Stage2AccountVerifiedInput,
} from "../../../src/live/runner/account-verified.ts";

function input(): Stage2AccountVerifiedInput {
  return {
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop" as never,
    targetHandleId: "target_ref_abcdefghijklmnop",
  };
}

const verified = {
  ok: true as const,
  cleanup: "pass" as const,
  value: {
    kind: "account_ready" as const,
    path: "verified_account" as const,
    independentlyObserved: true as const,
    verificationCandidateCount: 1 as const,
    verificationConsumed: true as const,
  },
};

test("account-verified runner seals only one independently observed consumed verification", async () => {
  let written: unknown;
  const result = await runStage2AccountVerified(input(), {
    lifecycle: { run: async () => verified },
    evidence: { write: async (value) => { written = value; } },
  }, new AbortController().signal);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.acceptance, {
    schemaVersion: 1,
    evidenceRevision: "s2-account-verified-acceptance-v2",
    checkpoint: "account_verified",
    status: "passed",
    sourceRevision: input().sourceRevision,
    revisionId: input().revisionId,
    approvalId: input().approvalId,
    journeyId: input().journeyId,
    targetHandleId: input().targetHandleId,
    accountState: "application_ready",
    independentlyObservedVerifiedState: true,
    verificationProof: "gmail_candidate_consumed",
    provider: "gmail-api-v1",
    consumedCandidateCount: 1,
    messageBodyRetained: false,
    submitActivated: false,
    privacyScan: "pass",
    cleanup: "pass",
  });
  assert.deepEqual(written, result.acceptance);
  assert.doesNotMatch(JSON.stringify(result), /https?:|password|token|oauth|raw|verification_handle/iu);
});

test("account-verified runner accepts an independently re-observed existing-account sign-in", async () => {
  let written: unknown;
  const result = await runStage2AccountVerified(input(), {
    lifecycle: { run: async () => ({
      ok: true,
      cleanup: "pass",
      value: {
        ...verified.value,
        path: "reused_account",
        verificationCandidateCount: 0,
        verificationConsumed: false,
      },
    }) },
    evidence: { write: async (value) => { written = value; } },
  }, new AbortController().signal);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.acceptance.verificationProof, "credential_sign_in");
  assert.equal(result.acceptance.provider, "workday-auth");
  assert.equal(result.acceptance.consumedCandidateCount, 0);
  assert.deepEqual(written, result.acceptance);
});

test("account-verified runner accepts a fresh-create route that authenticates by sign-in", async () => {
  const result = await runStage2AccountVerified(input(), {
    lifecycle: { run: async () => ({
      ok: true,
      cleanup: "pass",
      value: {
        ...verified.value,
        path: "created_account",
        verificationCandidateCount: 0,
        verificationConsumed: false,
      },
    }) },
    evidence: { write: async () => undefined },
  }, new AbortController().signal);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.acceptance.verificationProof, "credential_sign_in");
  assert.equal(result.acceptance.provider, "workday-auth");
  assert.equal(result.acceptance.consumedCandidateCount, 0);
});

test("an independently observed application page is ready without forcing authentication", async () => {
  const result = await runStage2AccountVerified(input(), {
    lifecycle: { run: async () => ({
      ok: true,
      cleanup: "pass",
      value: {
        ...verified.value,
        path: "already_ready",
        verificationCandidateCount: 0,
        verificationConsumed: false,
      },
    }) },
    evidence: { write: async () => undefined },
  }, new AbortController().signal);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.acceptance.verificationProof, "application_state_observed");
  assert.equal(result.acceptance.provider, "workday-state");
  assert.equal(result.acceptance.consumedCandidateCount, 0);
});

test("account-verified runner rejects unproved ready paths and widened successes", async () => {
  for (const value of [
    { ...verified.value, independentlyObserved: false },
    { ...verified.value, verificationCandidateCount: 2 },
    { ...verified.value, verificationConsumed: false },
    { ...verified.value, extra: "widened" },
  ]) {
    let writes = 0;
    const result = await runStage2AccountVerified(input(), {
      lifecycle: { run: async () => ({ ok: true, value } as never) },
      evidence: { write: async () => { writes += 1; } },
    }, new AbortController().signal);
    assert.deepEqual(result, { ok: false, code: "account_proof_invalid" });
    assert.equal(writes, 0);
  }
});

test("account-verified runner requires cleanup proof and rejects secret-shaped dependency errors", async () => {
  assert.deepEqual(await runStage2AccountVerified(input(), {
    lifecycle: { run: async () => ({ ok: true, value: verified.value } as never) },
    evidence: { write: async () => undefined },
  }, new AbortController().signal), { ok: false, code: "account_proof_invalid" });

  for (const cleanup of [undefined, "failed"] as const) {
    assert.deepEqual(await runStage2AccountVerified(input(), {
      lifecycle: { run: async () => ({
        ok: true,
        ...(cleanup === undefined ? {} : { cleanup }),
        value: {
          kind: "blocked",
          factualOutcome: {
            source: "mailbox_verification",
            result: { kind: "mailbox_none" },
          },
        },
      } as never) },
      evidence: { write: async () => undefined },
    }, new AbortController().signal), { ok: false, code: "account_proof_invalid" });
  }

  assert.deepEqual(await runStage2AccountVerified(input(), {
    lifecycle: { run: async () => ({
      ok: false,
      error: { code: "https://private.invalid/?token=secret" },
    }) },
    evidence: { write: async () => undefined },
  }, new AbortController().signal), { ok: false, code: "account_proof_invalid" });
});

test("account-verified runner admits only exact source-owned factual outcomes", async () => {
  const manual = await runStage2AccountVerified(input(), {
    lifecycle: { run: async () => ({
      ok: true,
      cleanup: "pass",
      value: {
        kind: "blocked",
        factualOutcome: {
          source: "account_access",
          result: { kind: "manual_intervention", reason: "captcha" },
        },
      },
    }) },
    evidence: { write: async () => undefined },
  }, new AbortController().signal);
  assert.deepEqual(manual, {
    ok: false,
    code: "manual_intervention",
    fact: { kind: "manual_intervention", reason: "captcha" },
  });

  for (const value of [
    {
      kind: "blocked",
      factualOutcome: { source: "account_access", result: { kind: "mailbox_none" } },
    },
    {
      kind: "blocked",
      factualOutcome: {
        source: "account_access",
        result: { kind: "manual_intervention", reason: "private" },
      },
    },
  ]) {
    assert.deepEqual(await runStage2AccountVerified(input(), {
      lifecycle: { run: async () => ({ ok: true, cleanup: "pass", value } as never) },
      evidence: { write: async () => undefined },
    }, new AbortController().signal), { ok: false, code: "account_proof_invalid" });
  }
});

test("account-verified runner preserves exact errors, factual stops, cancellation, and evidence failure", async () => {
  const failed = await runStage2AccountVerified(input(), {
    lifecycle: { run: async () => ({ ok: false, error: { code: "browser_timeout", retryable: true } }) },
    evidence: { write: async () => undefined },
  }, new AbortController().signal);
  assert.deepEqual(failed, { ok: false, code: "browser_timeout" });

  const blocked = await runStage2AccountVerified(input(), {
    lifecycle: { run: async () => ({
      ok: true,
      cleanup: "pass",
      value: {
        kind: "blocked",
        factualOutcome: { source: "mailbox_verification", result: { kind: "mailbox_none" } },
      },
    }) },
    evidence: { write: async () => undefined },
  }, new AbortController().signal);
  assert.deepEqual(blocked, { ok: false, code: "mailbox_none" });

  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await runStage2AccountVerified(input(), {
    lifecycle: { run: async () => verified },
    evidence: { write: async () => undefined },
  }, controller.signal), { ok: false, code: "operation_cancelled" });

  assert.deepEqual(await runStage2AccountVerified(input(), {
    lifecycle: { run: async () => verified },
    evidence: { write: async () => { throw new Error("denied"); } },
  }, new AbortController().signal), { ok: false, code: "evidence_unavailable" });
});
