import assert from "node:assert/strict";
import test from "node:test";

import type {
  MailboxPollResultV1,
  MailboxProvider,
  TargetIdentityV1,
  VerificationHandleId,
} from "../../../src/contracts/live/index.ts";
import {
  runStage2MailboxCandidate,
  type MailboxCandidateEvidenceWriter,
  type Stage2MailboxCandidateInput,
} from "../../../src/live/runner/mailbox-candidate.ts";

const target = {
  schemaVersion: 1,
  atsFamily: "workday",
  hostId: "host_abcdefghijklmnop",
  tenantId: "tenant_abcdefghijklmnop",
  postingId: "posting_abcdefghijklmnop",
} as TargetIdentityV1;

const handle = "verification_handle_abcdefghijklmnop" as VerificationHandleId;

function input(): Stage2MailboxCandidateInput {
  return {
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop" as never,
    targetHandleId: "target_ref_abcdefghijklmnop",
    recipientBindingId: "recipient_abcdefghijklmnop" as never,
    target,
    notBefore: "2026-08-01T12:00:00.000Z",
    notAfter: "2026-08-01T12:15:00.000Z",
    now: "2026-08-01T12:15:00.000Z",
  };
}

const available: MailboxPollResultV1 = {
  provider: "gmail_api_v1",
  receivedTimeBucket: "2026-08-01T12:05Z",
  expiresAt: "2026-08-01T13:05:00.000Z",
  candidateCount: 1,
  verificationHandle: handle,
};

test("one admitted Gmail candidate is released before value-free evidence is sealed", async () => {
  const order: string[] = [];
  let acceptance: unknown;
  const result = await runStage2MailboxCandidate(input(), {
    mailbox: provider(available, order),
    releaseCandidate(value) {
      order.push("release");
      assert.equal(value, handle);
    },
    evidence: {
      async write(value) {
        order.push("evidence");
        acceptance = value;
      },
    },
    nextQueryId: () => "mailbox_query_abcdefghijklmnop" as never,
  }, new AbortController().signal);

  assert.equal(result.ok, true);
  assert.deepEqual(order, ["poll", "release", "evidence"]);
  assert.deepEqual(acceptance, {
    schemaVersion: 1,
    evidenceRevision: "s2-mailbox-candidate-acceptance-v1",
    checkpoint: "mailbox_candidate",
    status: "passed",
    sourceRevision: input().sourceRevision,
    revisionId: input().revisionId,
    approvalId: input().approvalId,
    journeyId: input().journeyId,
    targetHandleId: input().targetHandleId,
    provider: "gmail-api-v1",
    candidateCount: 1,
    messageBodyRetained: false,
    submitActivated: false,
    privacyScan: "pass",
    cleanup: "pass",
  });
  assert.equal(JSON.stringify(acceptance).includes("verification_handle"), false);
});

test("mailbox candidate preserves exact factual no-match states without evidence", async () => {
  const cases: readonly [MailboxPollResultV1, string][] = [
    [{ ...available, receivedTimeBucket: null, expiresAt: null, candidateCount: 0, verificationHandle: null }, "mailbox_none"],
    [{ ...available, candidateCount: 2, verificationHandle: null }, "mailbox_ambiguous"],
    [{ ...available, expiresAt: input().now, verificationHandle: null }, "mailbox_expired"],
    [{ ...available, verificationHandle: null }, "mailbox_consumed"],
  ];
  for (const [value, code] of cases) {
    let evidenceCalls = 0;
    const result = await runStage2MailboxCandidate(input(), {
      mailbox: provider(value),
      releaseCandidate() { throw new Error("no handle may be released"); },
      evidence: { async write() { evidenceCalls += 1; } },
      nextQueryId: () => "mailbox_query_abcdefghijklmnop" as never,
    }, new AbortController().signal);
    assert.deepEqual(result, { ok: false, code }, code);
    assert.equal(evidenceCalls, 0, code);
  }
});

test("malformed safe success fails closed and provider failures remain exact", async () => {
  const malformed = await runStage2MailboxCandidate(input(), {
    mailbox: provider({ ...available, receivedTimeBucket: null }),
    releaseCandidate() {},
    evidence: quietEvidence(),
    nextQueryId: () => "mailbox_query_abcdefghijklmnop" as never,
  }, new AbortController().signal);
  assert.deepEqual(malformed, { ok: false, code: "mailbox_query_invalid" });

  const failed = await runStage2MailboxCandidate(input(), {
    mailbox: {
      async poll() {
        return { ok: false, error: { code: "gmail_rate_limited", retryable: true } };
      },
    } as MailboxProvider,
    releaseCandidate() {},
    evidence: quietEvidence(),
    nextQueryId: () => "mailbox_query_abcdefghijklmnop" as never,
  }, new AbortController().signal);
  assert.deepEqual(failed, { ok: false, code: "gmail_rate_limited" });
});

function provider(value: MailboxPollResultV1, order: string[] = []): MailboxProvider {
  return {
    async poll(request) {
      order.push("poll");
      assert.equal(request.notBefore, input().notBefore);
      assert.equal(request.notAfter, input().notAfter);
      assert.equal(request.recipientBindingId, input().recipientBindingId);
      return { ok: true, value };
    },
  };
}

function quietEvidence(): MailboxCandidateEvidenceWriter {
  return { async write() {} };
}
