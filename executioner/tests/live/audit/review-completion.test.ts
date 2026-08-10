import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { writeStage2AcceptanceManifest, writeStage2ReviewAcceptance } from "../../../src/acceptance/s2-local.ts";
import { auditStage2Completion } from "../../../src/composition/private/s2-any-completion-audit.ts";
import {
  finalizeStage2RunStorage,
  prepareStage2RunStorage,
} from "../../../src/composition/private/s2-run-storage.ts";
import { fieldId, questionId, upstreamResumeId } from "../../../src/contracts/index.ts";
import { writeLiveEvidencePacket } from "../../../src/evidence/live/packet.ts";
import { writeAccountVerifiedEvidence } from "../../../src/live/evidence/account-verified-evidence.ts";
import { writeApplicationWalkEvidence } from "../../../src/live/evidence/application-walk-evidence.ts";

const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
const revisionId = "revision_abcdefghijklmnop";
const approvalId = "approval_abcdefghijklmnop";
const journeyId = "journey_abcdefghijklmnop";
const targetHandleId = "target_ref_abcdefghijklmnop";
const noProtection = { protect: async () => undefined };

test("Review completion reconciles the exact gate, walk, browser truth, process cleanup, privacy, and Submit guard", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewauditxxxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);

    const audit = await auditStage2Completion(layout.evidenceRoot);
    assert.deepEqual(audit, {
      schemaVersion: 1,
      evidenceRevision: "s2-review-completion-v1",
      status: "pass",
      sourceRevision,
      journeyId,
      runStatus: "passed",
      acceptance: "present",
      applicationWalk: "present",
      acceptanceGate: "present",
      realEvidence: "validated",
      accountVerification: "present",
      processBinding: "production_bound",
      processAuditSha256: digest(readFileSync(join(layout.evidenceRoot, "process-audit.json"))),
      authMonitor: "external_chain_acknowledged",
      monitor: "external_chain_acknowledged",
      monitorClassification: "review_verified",
      processCleanup: "pass",
      privacyScan: "pass",
      submitPresent: true,
      submitActivated: false,
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(layout.evidenceRoot, "completion-audit.json"), "utf8")),
      audit,
    );
    assert.equal(existsSync(join(layout.evidenceRoot, "review-process-binding.json")), false);
    await finalizeStage2RunStorage({
      storageRoot,
      ownerConfigPath: layout.ownerConfigPath,
      evidenceRoot: layout.evidenceRoot,
    });
    assert.equal(existsSync(layout.transientRoot), false);
    const storageManifest = JSON.parse(
      readFileSync(join(layout.evidenceRoot, "storage-manifest.json"), "utf8"),
    ) as { readonly retainedFiles: readonly { readonly file: string }[] };
    assert.deepEqual(
      storageManifest.retainedFiles.map(({ file }) => file).filter((file) =>
        file.startsWith("real-evidence/")
      ),
      [
        "real-evidence/browser-truth.json",
        "real-evidence/manifest.json",
        "real-evidence/summary.json",
      ],
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects a crossed real-evidence journey binding", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewcrossedxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256, "journey_qrstuvwxyzabcdef");

    await assert.rejects(
      auditStage2Completion(layout.evidenceRoot),
      /completion audit denied/u,
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review finalization rejects an unmanifested real-evidence file without deleting transient state", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewextrafilex",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    await auditStage2Completion(layout.evidenceRoot);
    writeFileSync(join(layout.evidenceRoot, "real-evidence", "private.json"), "{}\n");

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

test("Review completion requires exact bound account-verified evidence", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewnoaccountx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "acceptance.json"));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects account-verified evidence crossed from another journey", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewacctcrossx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const path = join(layout.evidenceRoot, "acceptance.json");
    const acceptance = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({
      ...acceptance,
      journeyId: "journey_qrstuvwxyzabcdef",
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion requires the exact external ordinal monitor chain", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewnomonitorx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion requires the exact authenticated external monitor chain", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewnoauthmonx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "auth-monitor"), { recursive: true });
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review finalization rejects an unvalidated auth-monitor file", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewauthextrax",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    await auditStage2Completion(layout.evidenceRoot);
    writeFileSync(join(layout.evidenceRoot, "auth-monitor", "private.json"), "{}\n");
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

test("Review completion rejects an external monitor ACK crossed from another journey", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewmoncrossxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const path = join(
      layout.evidenceRoot,
      "monitor",
      "0013-review-review_readback.ack.json",
    );
    const ack = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({
      ...ack,
      journeyId: "journey_qrstuvwxyzabcdef",
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects a reviewed structure bound to the wrong page", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewmonwrongpg",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const path = join(
      layout.evidenceRoot,
      "monitor",
      "0013-review-review_readback.ack.json",
    );
    const ack = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({
      ...ack,
      structuralDescriptionIds: ["monitor_structure_profile_v1"],
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects a monitor ACK that claims Submit activation", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewmonsubmitx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const path = join(
      layout.evidenceRoot,
      "monitor",
      "0013-review-review_readback.ack.json",
    );
    const ack = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({
      ...ack,
      submitActivated: true,
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion accepts a bounded monitored recovery and retry sequence", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewretryxxxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    const moments = [...applicationMoments()];
    moments.splice(2, 0,
      ["profile", "recovery_observed", "operation_profile_recovery_01", 1],
      ["profile", "before_mutation", "operation_profile_mutation_02", 2],
      ["profile", "after_readback", "operation_profile_mutation_02", 2],
    );
    writeExternalMonitorChain(
      layout.evidenceRoot,
      "monitor",
      moments,
      "review_verified",
      false,
      configSha256,
    );
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await auditStage2Completion(layout.evidenceRoot);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects an unpaired monitored mutation operation", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewunpairedxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    const moments = applicationMoments().filter((_, index) => index !== 5);
    writeExternalMonitorChain(
      layout.evidenceRoot,
      "monitor",
      moments,
      "review_verified",
      false,
      configSha256,
    );
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects an illegal same-page navigation transition", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewbadnavxxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    const moments = applicationMoments();
    moments[3] = ["profile", "transition", "operation_profile_navigation_01", 1];
    writeExternalMonitorChain(
      layout.evidenceRoot, "monitor", moments, "review_verified", false, configSha256,
    );
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects a monitor chain without the process-derived live token", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewbadtokxxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    writeExternalMonitorChain(
      layout.evidenceRoot,
      "monitor",
      applicationMoments(),
      "review_verified",
      false,
      configSha256,
      "f".repeat(64),
    );
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects signature-only PNGs even when their request hashes agree", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewfakepngxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    rmSync(join(layout.evidenceRoot, "monitor"), { recursive: true });
    writeMonitorChain(layout.evidenceRoot, true, configSha256);
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects an unbound legacy process audit before audit sealing", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewoldprocess",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    writeFileSync(join(layout.evidenceRoot, "process-audit.json"), JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-windows-process-audit-v1",
      status: "pass",
      jobCloseApplied: true,
      membersObservedBeforeClose: 1,
      membersAliveAfterClose: 0,
      checkedAt: "2026-08-10T12:01:00.000Z",
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects a production process audit crossed before audit sealing", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewproccrossx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const path = join(layout.evidenceRoot, "process-audit.json");
    const processAudit = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({
      ...processAudit,
      journeyId: "journey_qrstuvwxyzabcdef",
    }));
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review completion rejects an ACK observed after production process close", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewlateackxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    const ackPath = join(
      layout.evidenceRoot,
      "monitor",
      "0013-review-review_readback.ack.json",
    );
    const ack = JSON.parse(readFileSync(ackPath, "utf8"));
    writeFileSync(ackPath, JSON.stringify({ ...ack, observedAt: "2026-08-10T12:02:00.000Z" }));
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:01:00.000Z", configSha256);
    await assert.rejects(auditStage2Completion(layout.evidenceRoot), /completion audit denied/u);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Review finalization rejects a production-bound process audit changed after completion", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-review-audit-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260810_reviewprocessxxx",
    }, noProtection);
    const configSha256 = writeOwnerConfig(layout);
    await writeReviewEvidence(layout.evidenceRoot, configSha256);
    await auditStage2Completion(layout.evidenceRoot);
    writeProcessAudit(layout.evidenceRoot, "2026-08-10T12:02:00.000Z", configSha256);
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

function writeOwnerConfig(layout: Layout): string {
  const owner = {
    schemaVersion: 1,
    contractRevision: "s2-owner-inputs-v1",
    revisionId,
    journeyId,
    target: {
      handleId: targetHandleId,
      url: "https://bankofamerica.wd1.myworkdayjobs.com/en-US/Careers/job/Business-Manager_26016513",
      host: "bankofamerica.wd1.myworkdayjobs.com",
      tenant: "bankofamerica",
      posting: "26016513",
    },
    approval: { approvalId },
    roots: {
      runtime: { path: layout.runtimeRoot },
      secrets: { path: layout.secretsRoot },
      evidence: { path: layout.evidenceRoot },
    },
    policy: { cleanupLeaseHours: 24, retentionDays: 30 },
  };
  const bytes = Buffer.from(JSON.stringify(owner), "utf8");
  writeFileSync(layout.ownerConfigPath, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeReviewEvidence(
  root: string,
  configSha256: string,
  packetJourneyId = journeyId,
): Promise<void> {
  await writeAccountVerifiedEvidence({
    root,
    acceptance: {
      schemaVersion: 1,
      evidenceRevision: "s2-account-verified-acceptance-v2",
      checkpoint: "account_verified",
      status: "passed",
      sourceRevision,
      revisionId,
      approvalId,
      journeyId,
      targetHandleId,
      accountState: "application_ready",
      independentlyObservedVerifiedState: true,
      verificationProof: "credential_sign_in",
      provider: "workday-auth",
      consumedCandidateCount: 0,
      messageBodyRetained: false,
      submitActivated: false,
      privacyScan: "pass",
      cleanup: "pass",
    },
    sensitiveValues: [],
  });
  await writeApplicationWalkEvidence({
    root,
    acceptance: applicationWalk(),
    sensitiveValues: [],
  });
  writeStage2ReviewAcceptance(root, reviewAcceptance(configSha256), []);
  writeStage2AcceptanceManifest(root, {
    schemaVersion: 1,
    acceptanceRevision: "s2-real-acceptance-gate-v1",
    status: "review_verified",
    sourceRevision,
    configSha256,
    contractRevision: "s2-owner-inputs-v1",
    revisionId,
    approvalId,
    journeyId,
    targetHandleId,
    checkpoint: "review",
    quality: "pass",
    reviewProof: "independently_verified",
    submitPresent: true,
    submitActivated: false,
    privacyScan: "pass",
    cleanup: "pending_exact_finalization",
  });
  writeLiveEvidencePacket({
    schemaVersion: 1,
    packetRevision: "s2-real-evidence-packet-v1",
    root,
    sourceRevision,
    configurationRevisionId: revisionId,
    configurationApprovalId: approvalId,
    journeyId: packetJourneyId,
    sealedAt: "2026-08-10T12:00:00.000Z",
    retentionDays: 30,
    milestones: [
      { kind: "account_verified", status: "verified" },
      { kind: "application_completed", status: "verified" },
      { kind: "review_reached", status: "verified" },
      { kind: "submit_guarded", status: "verified" },
    ],
    verificationSummaries: [
      { kind: "account", status: "verified", verifiedCount: 1 },
      { kind: "resume", status: "verified", verifiedCount: 1 },
      { kind: "required_fields", status: "verified", verifiedCount: 3 },
      { kind: "review", status: "verified", verifiedCount: 1 },
      { kind: "submit_guard", status: "verified", verifiedCount: 1 },
    ],
    errors: [],
    missingEvidence: [],
    browserTruth: {
      schemaVersion: 1,
      observer: "independent_browser",
      page: "review",
      reviewSignatureIds: ["review_signature_workday_review_root_v1"],
      completionEvidenceIds: ["completion_evidence_required_fields_v1"],
      submitStructurallyPresent: true,
      submitActivated: false,
    },
    diagnosticProjection: {
      reviewReached: true,
      requiredFieldsComplete: true,
      submitActivated: false,
    },
    unknownCandidate: null,
    forbiddenTokens: [],
  });
  writeAuthMonitorChain(root, false, configSha256);
  writeMonitorChain(root, false, configSha256);
  writeProcessAudit(root, "2026-08-10T12:01:00.000Z", configSha256);
}

function writeProcessAudit(root: string, checkedAt: string, configSha256: string): void {
  const runKey = root.split(/[\\/]/u).at(-2)!;
  writeFileSync(join(root, "process-audit.json"), JSON.stringify({
    schemaVersion: 1,
    evidenceRevision: "s2-windows-process-audit-v2",
    status: "pass",
    runKey,
    journeyId,
    targetHandleId,
    configSha256,
    processLiveNonceSha256: digest(Buffer.from("live-nonce-for-review-fixture")),
    processIssuedAt: "2026-08-10T11:59:59.000Z",
    processOwnerPid: 4242,
    processOwnerStartedAt: "2026-08-10T11:59:59.100Z",
    processExitObservedAt: "2026-08-10T12:00:59.000Z",
    jobCloseApplied: true,
    membersObservedBeforeClose: 1,
    membersAliveAfterClose: 0,
    monitorFileCount: monitorLedger(root).length,
    monitorChainSha256: monitorChainDigest(root),
    checkedAt,
  }));
}

function writeMonitorChain(root: string, signatureOnly: boolean, configSha256: string): void {
  writeExternalMonitorChain(
    root,
    "monitor",
    applicationMoments(),
    "review_verified",
    signatureOnly,
    configSha256,
  );
}

function applicationMoments(): Array<readonly [string, string, string, number]> {
  return [
    ["profile", "before_mutation", "operation_profile_mutation_01", 1],
    ["profile", "after_readback", "operation_profile_mutation_01", 1],
    ["profile", "before_navigation", "operation_profile_navigation_01", 1],
    ["resume", "transition", "operation_profile_navigation_01", 1],
    ["resume", "before_mutation", "operation_resume_mutation_01", 1],
    ["resume", "after_readback", "operation_resume_mutation_01", 1],
    ["resume", "before_navigation", "operation_resume_navigation_01", 1],
    ["questionnaire", "transition", "operation_resume_navigation_01", 1],
    ["questionnaire", "before_mutation", "operation_question_mutation_01", 1],
    ["questionnaire", "after_readback", "operation_question_mutation_01", 1],
    ["questionnaire", "before_navigation", "operation_question_navigation_01", 1],
    ["review", "transition", "operation_question_navigation_01", 1],
    ["review", "review_readback", "operation_review_readback_01", 1],
  ];
}

function writeAuthMonitorChain(root: string, signatureOnly: boolean, configSha256: string): void {
  writeExternalMonitorChain(root, "auth-monitor", [
    ["account_entry", "before_mutation", "operation_account_mutation_01", 1],
    ["account_entry", "after_readback", "operation_account_mutation_01", 1],
    ["account_entry", "before_navigation", "operation_account_navigation_01", 1],
    ["application_ready", "transition", "operation_account_navigation_01", 1],
    ["application_ready", "state_observed", "operation_application_ready_01", 1],
  ], "account_verified", signatureOnly, configSha256);
}

function writeExternalMonitorChain(
  root: string,
  directory: "auth-monitor" | "monitor",
  moments: readonly (readonly [string, string, string, number])[],
  finalClassification: "account_verified" | "review_verified",
  signatureOnly: boolean,
  configSha256: string,
  monitorLiveToken = monitorLiveTokenSha256(),
): void {
  const monitorRoot = join(root, directory);
  mkdirSync(monitorRoot);
  let previousAckSha256: string | null = null;
  for (const [index, [page, moment, operationId, attempt]] of moments.entries()) {
    const prefix = `${String(index + 1).padStart(4, "0")}-${page}-${moment}`;
    const screenshotFile = `${prefix}.png`;
    const taxonomyFile = `${prefix}.taxonomy.json`;
    const requestFile = `${prefix}.request.json`;
    const ackFile = `${prefix}.ack.json`;
    const screenshot = signatureOnly
      ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : pngBytes(index);
    writeFileSync(join(monitorRoot, screenshotFile), screenshot);
    const taxonomy = jsonBytes({
      schemaVersion: 1,
      evidenceRevision: "s2-monitor-taxonomy-v1",
      journeyId,
      targetHandleId,
      ordinal: index + 1,
      page,
      moment,
      fieldCount: page === "review" ? 3 : 1,
      requiredFieldCount: 1,
      controlTypes: ["text"],
      questionTypes: ["identity"],
      answerTypes: ["text"],
      validationState: "clear",
      submitPresent: page === "review",
      submitActivated: false,
      privacyScan: "pass",
    });
    writeFileSync(join(monitorRoot, taxonomyFile), taxonomy);
    const request = jsonBytes({
      schemaVersion: 1,
      requestRevision: "s2-external-monitor-request-v1",
      journeyId,
      targetHandleId,
      operationId,
      attempt,
      ordinal: index + 1,
      page,
      moment,
      screenshotFile,
      screenshotSha256: digest(screenshot),
      taxonomyFile,
      taxonomySha256: digest(taxonomy),
      previousAckSha256,
      processLiveNonceSha256: digest(Buffer.from("live-nonce-for-review-fixture")),
      processIssuedAt: "2026-08-10T11:59:59.000Z",
      processInstanceSha256: processInstanceSha256(),
      monitorLiveTokenSha256: monitorLiveToken,
      issuedAt: `2026-08-10T12:00:${String(index).padStart(2, "0")}.000Z`,
      sourceRevision,
      configSha256,
      capturedIdentityDigests: identityDigests(),
    });
    writeFileSync(join(monitorRoot, requestFile), request);
    const ack = jsonBytes({
      schemaVersion: 1,
      evidenceRevision: "s2-external-monitor-ack-v1",
      status: "acknowledged",
      observer: "independent_visual_monitor",
      journeyId,
      targetHandleId,
      operationId,
      attempt,
      ordinal: index + 1,
      page,
      moment,
      requestFile,
      requestSha256: digest(request),
      classification: index === moments.length - 1 ? finalClassification : "safe_to_continue",
      identityReconciliation: "matched",
      identityDimensions: ["host", "posting", "title"],
      observedIdentityDigests: identityDigests(),
      structuralDescriptionIds: [`monitor_structure_${page}_v1`],
      privacyScan: "pass",
      submitPresent: page === "review",
      submitActivated: false,
      observedAt: `2026-08-10T12:00:${String(index).padStart(2, "0")}.000Z`,
    });
    writeFileSync(join(monitorRoot, ackFile), ack);
    previousAckSha256 = digest(ack);
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function identityDigests() {
  return {
    hostSha256: digest(Buffer.from("bankofamerica.wd1.myworkdayjobs.com")),
    tenantSha256: digest(Buffer.from("bankofamerica")),
    postingSha256: digest(Buffer.from("26016513")),
    titleSha256: digest(Buffer.from("Business Manager")),
  };
}

function monitorLiveTokenSha256(): string {
  return digest(Buffer.from(
    `s2-monitor-live-v1\0${digest(Buffer.from("live-nonce-for-review-fixture"))}\0${journeyId}\0${targetHandleId}`,
    "utf8",
  ));
}

function processInstanceSha256(): string {
  return digest(Buffer.from(["s2-process-instance-v1", "4242", "2026-08-10T11:59:59.100Z"].join("\0")));
}

function monitorChainDigest(root: string): string {
  const names = monitorLedger(root);
  const lines = names.map((name) => `${name}:${digest(readFileSync(join(root, name)))}\n`).join("");
  return digest(Buffer.from(lines, "utf8"));
}

function monitorLedger(root: string): string[] {
  return ["auth-monitor", "monitor"].flatMap((directory) => {
    const path = join(root, directory);
    return existsSync(path) ? readdirSync(path).map((name) => `${directory}/${name}`) : [];
  }).sort();
}

function pngBytes(seed: number): Buffer {
  const width = 320;
  const height = 200;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  raw[raw.length - 1] = seed;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function reviewAcceptance(configSha256: string) {
  return {
    schemaVersion: 1 as const,
    evidenceRevision: "s2-review-acceptance-v1" as const,
    sourceRevision,
    configSha256,
    contractRevision: "s2-owner-inputs-v1",
    revisionId,
    approvalId,
    journeyId,
    targetHandleId,
    checkpoint: "review" as const,
    status: "passed" as const,
    reviewProof: "independently_verified" as const,
    submitPresent: true as const,
    submitActivated: false as const,
    privacyScan: "pass" as const,
  };
}

function applicationWalk() {
  const pageChecks = [
    pageCheck("profile", "profile_verified"),
    pageCheck("resume", "resume_verified"),
    pageCheck("questionnaire", "questionnaire_verified"),
  ];
  return {
    schemaVersion: 1 as const,
    evidenceRevision: "s2-application-walk-acceptance-v1" as const,
    checkpoint: "pre_review" as const,
    status: "passed" as const,
    sourceRevision,
    revisionId,
    approvalId,
    journeyId,
    targetHandleId,
    completedPages: 3,
    pageChecks,
    laneAcceptances: [
      {
        schemaVersion: 1 as const,
        checkpoint: "profile_verified" as const,
        pageType: "profile" as const,
        verifiedFields: [{
          fieldId: "identity.given_name",
          questionType: "identity" as const,
          answerType: "text" as const,
          uiBehavior: "text" as const,
          uiVariant: "workday_text_v1",
          provenance: "owner_provided" as const,
        }],
        ownedDuplicateRows: 0 as const,
        independentlyVerified: true as const,
        submitActivated: false as const,
        privacyScan: "pass" as const,
      },
      {
        schemaVersion: 1 as const,
        checkpoint: "resume_verified" as const,
        artifactId: upstreamResumeId("resume_abcdefghijklmnop"),
        sizeBytes: 1024,
        fileType: "pdf" as const,
        browserState: {
          variant: "workday_resume_file_upload_v1" as const,
          inputCardinality: 1 as const,
          uploadedFileCount: 1 as const,
          uploadComplete: true as const,
          requiredErrorVisible: false as const,
          removeControlCardinality: 1 as const,
        },
        independentlyVerified: true as const,
        duplicateUploadAvoided: false,
        replacedExisting: false,
        submitActivated: false as const,
        privacyScan: "pass" as const,
      },
      {
        schemaVersion: 1 as const,
        checkpoint: "questionnaire_verified" as const,
        answers: [{
          fieldId: fieldId("authorization-answer"),
          questionId: questionId("s1-question-work-authorization"),
          provenance: "owner_provided" as const,
          protectedCategory: "authorization" as const,
          templateRevision: null,
          verification: "independent" as const,
        }],
        protectedPlaceholderCount: 0 as const,
        independentlyVerified: true as const,
        submitActivated: false as const,
        privacyScan: "pass" as const,
      },
    ],
    submitActivated: false as const,
    privacyScan: "pass" as const,
    cleanup: "pass" as const,
  };
}

function pageCheck(
  page: "resume" | "profile" | "questionnaire",
  checkpoint: "resume_verified" | "profile_verified" | "questionnaire_verified",
) {
  return {
    page,
    checkpoint,
    independentlyVerified: true as const,
    requiredFields: 1,
    verifiedFields: 1,
    duplicateRows: 0,
  };
}
