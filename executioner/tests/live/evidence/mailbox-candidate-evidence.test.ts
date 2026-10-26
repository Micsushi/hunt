import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  writeMailboxCandidateEvidence,
  type MailboxCandidateAcceptanceV1,
} from "../../../src/live/evidence/mailbox-candidate-evidence.ts";

function packet(): MailboxCandidateAcceptanceV1 {
  return {
    schemaVersion: 1,
    evidenceRevision: "s2-mailbox-candidate-acceptance-v1",
    checkpoint: "mailbox_candidate",
    status: "passed",
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop",
    targetHandleId: "target_ref_abcdefghijklmnop",
    provider: "gmail-api-v1",
    candidateCount: 1,
    messageBodyRetained: false,
    submitActivated: false,
    privacyScan: "pass",
    cleanup: "pass",
  };
}

test("mailbox-candidate evidence is exact, atomic, and value-free", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-mailbox-evidence-"));
  try {
    await writeMailboxCandidateEvidence({
      root,
      acceptance: packet(),
      sensitiveValues: [
        "sender@example.invalid",
        "https://tenant.example.invalid/verify?token=private",
        "opaque-artifact-privatevalue",
        join(root, "private"),
      ],
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "acceptance.json"), "utf8")),
      packet(),
    );
    assert.deepEqual(readdirSync(root), ["acceptance.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mailbox evidence never overwrites and removes denied partials", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-mailbox-evidence-"));
  try {
    writeFileSync(join(root, "acceptance.json"), "sealed\n", { flag: "wx" });
    await assert.rejects(
      writeMailboxCandidateEvidence({ root, acceptance: packet(), sensitiveValues: [] }),
      /mailbox-candidate evidence unavailable/u,
    );
    assert.equal(readFileSync(join(root, "acceptance.json"), "utf8"), "sealed\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const deniedRoot = mkdtempSync(join(tmpdir(), "hunt-s2-mailbox-evidence-"));
  try {
    await assert.rejects(
      writeMailboxCandidateEvidence({
        root: deniedRoot,
        acceptance: { ...packet(), approvalId: "approval_privateabcdefghijklmnop" },
        sensitiveValues: ["private"],
      }),
      /mailbox-candidate evidence denied/u,
    );
    assert.deepEqual(readdirSync(deniedRoot), []);
  } finally {
    rmSync(deniedRoot, { recursive: true, force: true });
  }
});
