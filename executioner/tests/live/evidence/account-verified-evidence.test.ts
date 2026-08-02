import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeAccountVerifiedEvidence } from "../../../src/live/evidence/account-verified-evidence.ts";

function packet() {
  return {
    schemaVersion: 1 as const,
    evidenceRevision: "s2-account-verified-acceptance-v1" as const,
    checkpoint: "account_verified" as const,
    status: "passed" as const,
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop",
    targetHandleId: "target_ref_abcdefghijklmnop",
    accountState: "application_ready" as const,
    independentlyObservedVerifiedState: true as const,
    provider: "gmail-api-v1" as const,
    consumedCandidateCount: 1 as const,
    messageBodyRetained: false as const,
    submitActivated: false as const,
    privacyScan: "pass" as const,
    cleanup: "pass" as const,
  };
}

test("account-verified evidence writes one exact atomic value-free packet", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-verified-"));
  try {
    await writeAccountVerifiedEvidence({ root, acceptance: packet(), sensitiveValues: [] });
    assert.deepEqual(readdirSync(root), ["acceptance.json"]);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "acceptance.json"), "utf8")), packet());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account-verified evidence rejects widened, unverified, and sensitive packets", async () => {
  const cases = [
    { ...packet(), independentlyObservedVerifiedState: false },
    { ...packet(), consumedCandidateCount: 0 },
    { ...packet(), submitActivated: true },
    { ...packet(), rawUrl: "https://private.invalid/token" },
  ];
  for (const value of cases) {
    const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-verified-denied-"));
    try {
      await assert.rejects(
        writeAccountVerifiedEvidence({
          root,
          acceptance: value as never,
          sensitiveValues: ["https://private.invalid/token"],
        }),
      );
      assert.deepEqual(readdirSync(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
