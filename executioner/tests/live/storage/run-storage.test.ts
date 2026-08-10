import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discardStage2RunStorage,
  finalizeStage2RunStorage,
  prepareStage2RunStorage,
  inventoryStage2RunStorage,
  readStage2StorageCatalog,
  rebuildStage2StorageCatalog,
  sweepExpiredStage2RetainedStorage,
} from "../../../src/composition/private/s2-run-storage.ts";
import { WindowsCurrentUserAclAdmission } from "../../../src/live/preflight/private/windows-acl.ts";

const noProtection = { protect: async () => undefined };

test("native preparation seals every live-run path for only the current Windows user and SYSTEM", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows ACL contract");
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-storage-acl-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260803_aclsealedfixture",
    });
    assert.deepEqual(new WindowsCurrentUserAclAdmission().admit({
      runtime: layout.runtimeRoot,
      secrets: layout.secretsRoot,
      evidence: layout.evidenceRoot,
      ownerConfig: layout.ownerConfigPath,
    }), { ok: true });
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("run storage physically separates disposable state from retained evidence and catalogs the target", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-storage-"));
  try {
    const layout = await prepareStage2RunStorage(
      { storageRoot, runKey: "run_20260803_abcdefghijklmnop" },
      noProtection,
    );
    assert.equal(layout.transientRoot.startsWith(join(storageRoot, "transient")), true);
    assert.equal(layout.evidenceRoot.startsWith(join(storageRoot, "retained")), true);
    assert.equal(layout.evidenceRoot.startsWith(layout.transientRoot), false);
    assert.equal(existsSync(layout.ownerConfigPath), true);
    assert.equal(
      layout.verificationConsumptionRoot,
      join(storageRoot, "bindings", "verification-consumption"),
    );
    assert.equal(existsSync(layout.verificationConsumptionRoot), true);

    writeOwnerConfig(layout, "blackrock.wd1.myworkdayjobs.com", "blackrock", "R265422");
    writeCompletedEvidence(layout.evidenceRoot, "2026-08-03T22:00:00.000Z");

    const result = await finalizeStage2RunStorage({
      storageRoot,
      ownerConfigPath: layout.ownerConfigPath,
      evidenceRoot: layout.evidenceRoot,
    });

    assert.equal(result.transientCleanup, "pass");
    assert.equal(existsSync(layout.transientRoot), false);
    assert.equal(existsSync(layout.evidenceRoot), true);
    assert.equal(existsSync(join(layout.evidenceRoot, "storage-manifest.json")), true);
    assert.equal(existsSync(join(layout.evidenceRoot, "disposal-audit.json")), true);

    const catalog = readStage2StorageCatalog(storageRoot);
    assert.equal(catalog.entries.length, 1);
    assert.deepEqual(catalog.entries[0]?.target, {
      host: "blackrock.wd1.myworkdayjobs.com",
      tenant: "blackrock",
      posting: "R265422",
    });
    assert.equal(catalog.entries[0]?.runStatus, "passed");
    assert.equal(catalog.entries[0]?.retainUntil, "2026-09-02T22:00:00.000Z");

    const retained = [
      readFileSync(join(layout.evidenceRoot, "storage-manifest.json"), "utf8"),
      readFileSync(join(storageRoot, "retained", "catalog.json"), "utf8"),
    ].join("\n");
    assert.doesNotMatch(retained, /https:\/\//u);
    assert.doesNotMatch(retained, /secret_handle_/u);
    assert.doesNotMatch(retained, /owner-input\.json/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("run preparation reuses one protected opaque recipient binding without retaining an address", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-storage-"));
  try {
    const first = await prepareStage2RunStorage(
      { storageRoot, runKey: "run_20260803_recipientfirstxx" },
      noProtection,
    );
    const second = await prepareStage2RunStorage(
      { storageRoot, runKey: "run_20260803_recipientsecondx" },
      noProtection,
    );

    assert.match(first.recipientBindingId, /^recipient_[a-f0-9]{32}$/u);
    assert.equal(second.recipientBindingId, first.recipientBindingId);
    const retainedBinding = readFileSync(
      join(storageRoot, "bindings", "recipient-binding.json"),
      "utf8",
    );
    assert.match(retainedBinding, /"bindingRevision":"s2-recipient-binding-v1"/u);
    assert.match(retainedBinding, new RegExp(first.recipientBindingId, "u"));
    assert.doesNotMatch(retainedBinding, /@/u);
    assert.doesNotMatch(retainedBinding, /gmail|email|address/iu);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("storage inventory separates what stays, what goes, and what needs operator action", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-storage-inventory-"));
  try {
    const unfinished = await prepareStage2RunStorage(
      { storageRoot, runKey: "run_20260803_unfinishedrunxxx" },
      noProtection,
    );
    const ready = await prepareStage2RunStorage(
      { storageRoot, runKey: "run_20260803_readyfinalizexxx" },
      noProtection,
    );
    writeOwnerConfig(ready, "ready.wd1.myworkdayjobs.com", "ready", "READY123");
    writeCompletedEvidence(ready.evidenceRoot, "2026-08-03T22:00:00.000Z");
    const finalized = await preparedAndFinalized(
      storageRoot,
      "run_20260803_finalizedrunxxxx",
      "final.wd1.myworkdayjobs.com",
      "final",
      "FINAL123",
      "2026-08-03T23:00:00.000Z",
    );

    const inventory = inventoryStage2RunStorage(storageRoot);
    assert.deepEqual(inventory.counts, {
      finalized: 1,
      readyToFinalize: 1,
      unfinished: 1,
      legacyRetained: 0,
      invalid: 0,
      unmanagedEntries: 0,
    });
    assert.deepEqual(inventory.runs, [
      { runKey: finalized.runKey, disposition: "finalized_stays" },
      { runKey: ready.runKey, disposition: "ready_to_finalize" },
      { runKey: unfinished.runKey, disposition: "unfinished_goes_after_exact_discard" },
    ]);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("finalization fails closed without deleting transient state when completion or layout does not agree", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-storage-"));
  try {
    const layout = await prepareStage2RunStorage(
      { storageRoot, runKey: "run_20260803_qrstuvwxyzabcdef" },
      noProtection,
    );
    writeOwnerConfig(layout, "example.wd1.myworkdayjobs.com", "example", "P123456");

    await assert.rejects(
      finalizeStage2RunStorage({
        storageRoot,
        ownerConfigPath: layout.ownerConfigPath,
        evidenceRoot: layout.evidenceRoot,
      }),
      /storage finalization denied/u,
    );
    assert.equal(existsSync(layout.transientRoot), true);
    assert.equal(readStage2StorageCatalog(storageRoot).entries.length, 0);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("retention sweep removes only expired retained runs and updates the human-searchable catalog", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-storage-"));
  try {
    const expired = await preparedAndFinalized(
      storageRoot,
      "run_20260601_abcdefghijklmnop",
      "oldco.wd1.myworkdayjobs.com",
      "oldco",
      "OLD123",
      "2026-06-01T12:00:00.000Z",
    );
    const current = await preparedAndFinalized(
      storageRoot,
      "run_20260801_qrstuvwxyzabcdef",
      "newco.wd1.myworkdayjobs.com",
      "newco",
      "NEW456",
      "2026-08-01T12:00:00.000Z",
    );

    const sweep = sweepExpiredStage2RetainedStorage({
      storageRoot,
      now: "2026-08-03T12:00:00.000Z",
    });
    assert.equal(sweep.removed, 1);
    assert.equal(sweep.replayClaimsRemoved, 0);
    assert.equal(sweep.replayClaimsRetained, 0);
    assert.equal(existsSync(expired.retainedRunRoot), false);
    assert.equal(existsSync(current.retainedRunRoot), true);
    assert.deepEqual(
      readStage2StorageCatalog(storageRoot).entries.map(({ target }) => target.posting),
      ["NEW456"],
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("catalog can be rebuilt from retained manifests without owner configs or remembered run IDs", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-storage-"));
  try {
    await preparedAndFinalized(
      storageRoot,
      "run_20260803_catalogrebuildxx",
      "visa.wd1.myworkdayjobs.com",
      "visa",
      "R123456",
      "2026-08-03T21:00:00.000Z",
    );
    rmSync(join(storageRoot, "retained", "catalog.json"));

    const rebuilt = rebuildStage2StorageCatalog(storageRoot);
    assert.equal(rebuilt.entries.length, 1);
    assert.equal(rebuilt.entries[0]?.target.host, "visa.wd1.myworkdayjobs.com");
    assert.deepEqual(readStage2StorageCatalog(storageRoot), rebuilt);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("discard removes only an exact unfinished run and refuses completed evidence", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-storage-"));
  try {
    const unfinished = await prepareStage2RunStorage(
      { storageRoot, runKey: "run_20260804_discardfixturexx" },
      noProtection,
    );
    writeOwnerConfig(unfinished, "blackrock.wd1.myworkdayjobs.com", "blackrock", "R265422");
    writeFileSync(join(unfinished.secretsRoot, "secret_handle_0123456789abcdef0123456789abcdef.s2secret"), "opaque");
    writeFileSync(join(unfinished.evidenceRoot, "diagnostics.json"), "{}");
    assert.deepEqual(discardStage2RunStorage({
      storageRoot,
      ownerConfigPath: unfinished.ownerConfigPath,
      evidenceRoot: unfinished.evidenceRoot,
    }), {
      runKey: unfinished.runKey,
      transientCleanup: "pass",
      retainedCleanup: "pass",
    });
    assert.equal(existsSync(unfinished.transientRoot), false);
    assert.equal(existsSync(unfinished.retainedRunRoot), false);

    const completed = await prepareStage2RunStorage(
      { storageRoot, runKey: "run_20260804_completedrunxxxx" },
      noProtection,
    );
    writeOwnerConfig(completed, "blackrock.wd1.myworkdayjobs.com", "blackrock", "R265422");
    writeFileSync(join(completed.evidenceRoot, "completion-audit.json"), "{}");
    assert.throws(() => discardStage2RunStorage({
      storageRoot,
      ownerConfigPath: completed.ownerConfigPath,
      evidenceRoot: completed.evidenceRoot,
    }), /storage discard denied/u);
    assert.equal(existsSync(completed.transientRoot), true);
    assert.equal(existsSync(completed.retainedRunRoot), true);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("storage finalizes a fully monitored account-verified checkpoint", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-storage-"));
  try {
    const layout = await prepareStage2RunStorage(
      { storageRoot, runKey: "run_20260804_verifiedcheckpnt" },
      noProtection,
    );
    writeOwnerConfig(layout, "blackrock.wd1.myworkdayjobs.com", "blackrock", "R265422");
    writeFileSync(join(layout.evidenceRoot, "completion-audit.json"), JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-account-verified-completion-v2",
      status: "pass",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      journeyId: "journey_abcdefghijklmnop",
      runStatus: "passed",
      acceptance: "present",
      monitor: "acknowledged",
      monitorClassification: "application_ready",
      verificationProof: "credential_sign_in",
      provider: "workday-auth",
      consumedCandidateCount: 0,
      processCleanup: "pass",
      privacyScan: "pass",
      messageBodyRetained: false,
      submitActivated: false,
    }));
    writeFileSync(join(layout.evidenceRoot, "process-audit.json"), JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-windows-process-audit-v1",
      status: "pass",
      jobCloseApplied: true,
      membersObservedBeforeClose: 1,
      membersAliveAfterClose: 0,
      checkedAt: "2026-08-04T12:01:00.000Z",
    }));

    await finalizeStage2RunStorage({
      storageRoot,
      ownerConfigPath: layout.ownerConfigPath,
      evidenceRoot: layout.evidenceRoot,
    });
    const entry = readStage2StorageCatalog(storageRoot).entries[0];
    assert.equal(entry?.runStatus, "passed");
    assert.equal(entry?.monitorClassification, "application_ready");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("legacy account finalization rejects Review-only retained files", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-storage-"));
  try {
    const layout = await prepareStage2RunStorage(
      { storageRoot, runKey: "run_20260810_legacyreviewfile" },
      noProtection,
    );
    writeOwnerConfig(layout, "blackrock.wd1.myworkdayjobs.com", "blackrock", "R265422");
    writeCompletedEvidence(layout.evidenceRoot, "2026-08-10T12:00:00.000Z");
    writeFileSync(join(layout.evidenceRoot, "application-walk-acceptance.json"), "{}\n");

    await assert.rejects(finalizeStage2RunStorage({
      storageRoot,
      ownerConfigPath: layout.ownerConfigPath,
      evidenceRoot: layout.evidenceRoot,
    }), /storage finalization denied/u);
    assert.equal(existsSync(layout.transientRoot), true);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

type Layout = Awaited<ReturnType<typeof prepareStage2RunStorage>>;

function writeOwnerConfig(
  layout: Layout,
  host: string,
  tenant: string,
  posting: string,
): void {
  writeFileSync(layout.ownerConfigPath, JSON.stringify({
    target: {
      url: `https://${host}/en-US/BlackRock_Professional/job/location/title_${posting}`,
      host,
      tenant,
      posting,
    },
    roots: {
      runtime: { path: layout.runtimeRoot },
      secrets: { path: layout.secretsRoot },
      evidence: { path: layout.evidenceRoot },
    },
    policy: { cleanupLeaseHours: 24, retentionDays: 30 },
  }));
}

function writeCompletedEvidence(root: string, checkedAt: string): void {
  writeFileSync(join(root, "completion-audit.json"), JSON.stringify({
    schemaVersion: 1,
    evidenceRevision: "s2-account-access-completion-v1",
    status: "pass",
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    journeyId: "journey_abcdefghijklmnop",
    runStatus: "passed",
    acceptance: "present",
    monitor: "acknowledged",
    monitorClassification: "application_ready",
    mcpStatus: "running",
    mcpResult: "journey_busy",
    processCleanup: "pass",
    privacyScan: "pass",
    submitActivated: false,
  }));
  writeFileSync(join(root, "process-audit.json"), JSON.stringify({
    schemaVersion: 1,
    evidenceRevision: "s2-windows-process-audit-v1",
    status: "pass",
    jobCloseApplied: true,
    membersObservedBeforeClose: 0,
    membersAliveAfterClose: 0,
    checkedAt,
  }));
}

async function preparedAndFinalized(
  storageRoot: string,
  runKey: string,
  host: string,
  tenant: string,
  posting: string,
  checkedAt: string,
): Promise<Layout> {
  const layout = await prepareStage2RunStorage({ storageRoot, runKey }, noProtection);
  writeOwnerConfig(layout, host, tenant, posting);
  writeCompletedEvidence(layout.evidenceRoot, checkedAt);
  await finalizeStage2RunStorage({
    storageRoot,
    ownerConfigPath: layout.ownerConfigPath,
    evidenceRoot: layout.evidenceRoot,
  });
  return layout;
}
