import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { OperationId } from "../../src/contracts/index.ts";
import type { RealRunOwnerInputsV1 } from "../../src/live/preflight/types.ts";
import { deriveSenderPolicyId } from "../../src/composition/private/s2-gmail-bootstrap-binding.ts";
import { createMailboxCandidateBindings } from "../../src/composition/s2-mailbox-candidate-runner.ts";

const now = "2026-08-02T02:05:29.000Z";
const sourceRevision = "0123456789abcdef0123456789abcdef01234567";

test("mailbox composition binds the current company search to the exact preceding hour", () => {
  const owner = ownerInputs();
  const verificationOperationId = "operation_abcdefghijklmnop" as OperationId;
  const value = createMailboxCandidateBindings(
    owner,
    sourceRevision,
    now,
    verificationOperationId,
  );
  assert.equal(value.input.notBefore, "2026-08-02T01:05:29.000Z");
  assert.equal(value.input.notAfter, now);
  assert.equal(
    Date.parse(value.input.notAfter) - Date.parse(value.input.notBefore),
    60 * 60 * 1_000,
  );
  assert.equal(Date.parse("2026-08-02T01:44:48.000Z") >= Date.parse(value.input.notBefore), true);
  assert.equal(Date.parse("2026-08-02T01:44:48.000Z") <= Date.parse(value.input.notAfter), true);
  assert.notEqual(value.input.notBefore, owner.approval.approvedAt);
  assert.equal(value.input.recipientBindingId, owner.recipientBindingId);
  assert.equal(value.input.targetHandleId, owner.target.handleId);
  assert.deepEqual(value.input.target, value.gmail.target);
  assert.equal(value.gmail.verificationOperationId, verificationOperationId);
  assert.equal(value.gmail.senderPolicyId, deriveSenderPolicyId({
    revisionId: owner.revisionId,
    journeyId: owner.journeyId,
    gmailHandleId: owner.gmailAuthorization.handleId,
    recipientBindingId: owner.recipientBindingId,
  }));
  assert.equal(JSON.stringify(value.input).includes(owner.target.url), false);
});

test("authenticated catalog runbook pins the company-specific preceding-hour query", () => {
  const runbook = readFileSync("docs/authenticated-catalog-testing.md", "utf8");
  assert.match(runbook, /current job's company[\s\S]*preceding hour/u);
  assert.match(runbook, /No sender allowlist is required/u);
  assert.doesNotMatch(
    runbook,
    /sender-policy|exact sender policy|owner-approved exact sender|unknown tenant's exact verification sender/u,
  );
});

function ownerInputs(): RealRunOwnerInputsV1 {
  return {
    schemaVersion: 1,
    contractRevision: "s2-owner-inputs-v1",
    revisionId: "revision_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop",
    accountMode: "fresh_create",
    target: {
      handleId: "target_ref_abcdefghijklmnop",
      url: "https://cmu.wd5.myworkdayjobs.com/en-US/CMU/job/Test_2024584",
      host: "cmu.wd5.myworkdayjobs.com",
      tenant: "cmu",
      posting: "2024584",
    },
    profileRef: "profile_ref_abcdefghijklmnop",
    resumeRef: "resume_ref_abcdefghijklmnop",
    recipientBindingId: "recipient_abcdefghijklmnop",
    roots: {
      runtime: { rootId: "runtime_root_abcdefghijklmnop", path: "C:\\runtime", access: "current_user_only" },
      secrets: { rootId: "secrets_root_abcdefghijklmnop", path: "C:\\secrets", access: "current_user_only" },
      evidence: { rootId: "evidence_root_abcdefghijklmnop", path: "C:\\evidence", access: "current_user_only" },
    },
    policy: { cleanupLeaseHours: 24, retentionDays: 30 },
    approval: {
      schemaVersion: 1,
      approvalId: "approval_abcdefghijklmnop",
      journeyId: "journey_abcdefghijklmnop",
      revisionId: "revision_abcdefghijklmnop",
      approved: true,
      liveAccess: true,
      approvedAt: "2026-08-02T02:00:00.000Z",
      expiresAt: "2026-08-02T02:30:00.000Z",
      ownerId: "owner_abcdefghijklmnop",
      runtimeOperatorId: "owner_abcdefghijklmnop",
      secretCustodianId: "owner_abcdefghijklmnop",
      evidenceCustodianId: "owner_abcdefghijklmnop",
    },
    adapters: { secretStore: "windows-dpapi-current-user-v1", mailboxProvider: "gmail-api-v1" },
    accountSecret: {
      schemaVersion: 1,
      handleId: "secret_handle_accountabcdefghijkl",
      journeyId: "journey_abcdefghijklmnop",
      provider: "windows-dpapi-current-user-v1",
      purpose: "account_credentials",
      consumer: "credential_mutation_adapter",
      scope: "account_access",
      expiresAt: "2026-08-02T02:30:00.000Z",
    },
    gmailAuthorization: {
      schemaVersion: 1,
      handleId: "secret_handle_gmailabcdefghijklxx",
      journeyId: "journey_abcdefghijklmnop",
      provider: "windows-dpapi-current-user-v1",
      purpose: "gmail_oauth",
      consumer: "gmail_auth_executor",
      scope: "mailbox_verification",
      expiresAt: "2026-08-02T02:30:00.000Z",
    },
  };
}
