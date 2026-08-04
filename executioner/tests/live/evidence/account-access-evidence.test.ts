import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readAccountAccessEvidence,
  writeAccountAccessEvidence,
  type AccountAccessAcceptanceV1,
} from "../../../src/live/evidence/account-access-evidence.ts";

function packet(): AccountAccessAcceptanceV1 {
  return {
    schemaVersion: 1,
    evidenceRevision: "s2-account-access-acceptance-v1",
    checkpoint: "account_access",
    status: "passed",
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop",
    targetHandleId: "target_ref_abcdefghijklmnop",
    verifiedTargetDimensions: ["host", "tenant", "posting"],
    accountMode: "fresh_create",
    accountOutcome: "verification_required",
    independentlyVerifiedFields: ["email", "password"],
    submitActivated: false,
    privacyScan: "pass",
    cleanup: "pass",
  };
}

test("account-access evidence is atomically sealed with an exact value-free schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-evidence-"));
  try {
    await writeAccountAccessEvidence({
      root,
      acceptance: packet(),
      sensitiveValues: [
        "https://tenant.wd5.myworkdayjobs.com/en-US/jobs/job/title_R123",
        "exampletenant.wd5.myworkdayjobs.com",
        "exampletenant",
        "R123",
        join(root, "private"),
      ],
    });
    const value = JSON.parse(readFileSync(join(root, "acceptance.json"), "utf8"));
    assert.deepEqual(value, packet());
    assert.deepEqual(readAccountAccessEvidence(root), packet());
    assert.deepEqual(readdirSync(root), ["acceptance.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct application access retains an exact empty credential-verification set", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-evidence-"));
  try {
    const direct = {
      ...packet(),
      accountOutcome: "application_ready" as const,
      independentlyVerifiedFields: [] as const,
    };
    await writeAccountAccessEvidence({ root, acceptance: direct, sensitiveValues: [] });
    assert.deepEqual(readAccountAccessEvidence(root), direct);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account-access evidence never overwrites a sealed packet", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-evidence-"));
  try {
    writeFileSync(join(root, "acceptance.json"), "sealed\n", { flag: "wx" });
    await assert.rejects(
      writeAccountAccessEvidence({ root, acceptance: packet(), sensitiveValues: [] }),
      /account-access evidence unavailable/u,
    );
    assert.equal(readFileSync(join(root, "acceptance.json"), "utf8"), "sealed\n");
    assert.deepEqual(readdirSync(root), ["acceptance.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy denial removes only the current unsealed partial", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-evidence-"));
  try {
    const unsafe = {
      ...packet(),
      approvalId: "approval_tenantnameabcdefghijklmnop",
    };
    await assert.rejects(
      writeAccountAccessEvidence({
        root,
        acceptance: unsafe,
        sensitiveValues: ["tenantname"],
      }),
      /account-access evidence denied/u,
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
