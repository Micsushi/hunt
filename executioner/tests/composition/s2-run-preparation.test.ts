import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareStage2LiveRun } from "../../src/composition/s2-run-preparation.ts";
import { admitRealRunPreflight } from "../../src/live/preflight/admit.ts";

const noProtection = { protect: async () => undefined };

test("live run preparation writes an admitted disposable owner config with the durable recipient binding", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-preparation-"));
  try {
    const prepared = await prepareStage2LiveRun({
      storageRoot,
      targetUrl: "https://blackrock.wd1.myworkdayjobs.com/en-US/BlackRock_Professional/job/New-York-NY/Senior-Data-Warehouse-Developer---PFS_R265422",
      accountMode: "sign_in",
      now: "2026-08-04T12:00:00.000Z",
    }, noProtection);
    const owner = JSON.parse(readFileSync(prepared.ownerConfigPath, "utf8"));

    assert.equal(owner.recipientBindingId, prepared.recipientBindingId);
    assert.deepEqual(owner.target, {
      handleId: owner.target.handleId,
      url: "https://blackrock.wd1.myworkdayjobs.com/en-US/BlackRock_Professional/job/New-York-NY/Senior-Data-Warehouse-Developer---PFS_R265422",
      host: "blackrock.wd1.myworkdayjobs.com",
      tenant: "blackrock",
      posting: "R265422",
    });
    assert.equal(owner.accountMode, "sign_in");
    assert.equal(owner.approval.approvedAt, "2026-08-04T12:00:00.000Z");
    assert.equal(owner.approval.expiresAt, "2026-08-04T12:30:00.000Z");
    assert.equal(owner.accountSecret.expiresAt, owner.approval.expiresAt);
    assert.equal(owner.gmailAuthorization.expiresAt, owner.approval.expiresAt);
    assert.equal(
      Date.parse(owner.gmailAuthorization.expiresAt) - Date.parse(owner.approval.approvedAt),
      30 * 60 * 1_000,
    );
    assert.equal(owner.roots.runtime.path, prepared.runtimeRoot);
    assert.equal(owner.roots.secrets.path, prepared.secretsRoot);
    assert.equal(owner.roots.evidence.path, prepared.evidenceRoot);
    assert.equal(admitRealRunPreflight(owner, {
      now: "2026-08-04T12:00:01.000Z",
      forbiddenRoots: [process.cwd()],
    }).ok, true);

    const bindingFile = readFileSync(
      join(storageRoot, "bindings", "recipient-binding.json"),
      "utf8",
    );
    assert.doesNotMatch(bindingFile, /blackrock|R265422|@/iu);
    assert.equal(prepared.ownerConfigPath.startsWith(prepared.transientRoot), true);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("sequential live runs keep recipient identity but rotate all run-scoped authority", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-preparation-"));
  try {
    const request = {
      storageRoot,
      targetUrl: "https://blackrock.wd1.myworkdayjobs.com/en-US/Careers/job/Test_R265422",
      accountMode: "sign_in" as const,
      now: "2026-08-04T12:00:00.000Z",
    };
    const first = await prepareStage2LiveRun(request, noProtection);
    const second = await prepareStage2LiveRun(request, noProtection);
    const firstOwner = JSON.parse(readFileSync(first.ownerConfigPath, "utf8"));
    const secondOwner = JSON.parse(readFileSync(second.ownerConfigPath, "utf8"));

    assert.equal(first.recipientBindingId, second.recipientBindingId);
    for (const field of ["revisionId", "journeyId", "profileRef", "resumeRef"] as const) {
      assert.notEqual(firstOwner[field], secondOwner[field]);
    }
    assert.notEqual(firstOwner.target.handleId, secondOwner.target.handleId);
    assert.notEqual(firstOwner.accountSecret.handleId, secondOwner.accountSecret.handleId);
    assert.notEqual(firstOwner.gmailAuthorization.handleId, secondOwner.gmailAuthorization.handleId);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("live run preparation rejects malformed or non-Workday targets before creating run state", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-preparation-"));
  try {
    await assert.rejects(prepareStage2LiveRun({
      storageRoot,
      targetUrl: "https://example.com/job/Test_R265422",
      accountMode: "sign_in",
      now: "2026-08-04T12:00:00.000Z",
    }, noProtection), /run preparation denied/u);
    assert.equal(existsSync(join(storageRoot, "transient")), false);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});
