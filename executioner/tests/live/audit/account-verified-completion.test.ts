import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditStage2AccountVerifiedCompletion } from "../../../src/composition/private/s2-account-verified-completion-audit.ts";
import { writeAccountVerifiedEvidence } from "../../../src/live/evidence/account-verified-evidence.ts";
import {
  MONITOR_SCREENSHOT_FILE,
  writeOperatorMonitorAcknowledgement,
  writeOperatorMonitorRequest,
} from "../../../src/live/evidence/operator-monitor-ack.ts";

const journeyId = "journey_abcdefghijklmnop";
const targetHandleId = "target_ref_abcdefghijklmnop";

test("account-verified completion binds Gmail acceptance, monitor target, screenshot, cleanup, and Submit safety", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-verified-audit-"));
  try {
    await evidence(root, targetHandleId);
    writeMonitor(root, targetHandleId);
    writeProcessAudit(root);

    const audit = await auditStage2AccountVerifiedCompletion(root);
    assert.deepEqual(audit, {
      schemaVersion: 1,
      evidenceRevision: "s2-account-verified-completion-v2",
      status: "pass",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      journeyId,
      runStatus: "passed",
      acceptance: "present",
      monitor: "acknowledged",
      monitorClassification: "application_ready",
      verificationProof: "gmail_candidate_consumed",
      provider: "gmail-api-v1",
      consumedCandidateCount: 1,
      processCleanup: "pass",
      privacyScan: "pass",
      messageBodyRetained: false,
      submitActivated: false,
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "completion-audit.json"), "utf8")),
      audit,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account-verified completion rejects a valid monitor acknowledgement crossed from another target", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-verified-audit-"));
  try {
    await evidence(root, targetHandleId);
    writeMonitor(root, "target_ref_qrstuvwxyzabcdef");
    writeProcessAudit(root);
    await assert.rejects(
      auditStage2AccountVerifiedCompletion(root),
      /account-verified completion audit denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function evidence(root: string, target: string): Promise<void> {
  await writeAccountVerifiedEvidence({
    root,
    acceptance: {
      schemaVersion: 1,
      evidenceRevision: "s2-account-verified-acceptance-v2",
      checkpoint: "account_verified",
      status: "passed",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      revisionId: "revision_abcdefghijklmnop",
      approvalId: "approval_abcdefghijklmnop",
      journeyId,
      targetHandleId: target,
      accountState: "application_ready",
      independentlyObservedVerifiedState: true,
      verificationProof: "gmail_candidate_consumed",
      provider: "gmail-api-v1",
      consumedCandidateCount: 1,
      messageBodyRetained: false,
      submitActivated: false,
      privacyScan: "pass",
      cleanup: "pass",
    },
    sensitiveValues: [],
  });
}

function writeMonitor(root: string, target: string): void {
  writeFileSync(join(root, MONITOR_SCREENSHOT_FILE), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]));
  const request = writeOperatorMonitorRequest({
    root,
    journeyId,
    targetHandleId: target,
    host: "blackrock.wd1.myworkdayjobs.com",
    tenant: "blackrock",
    posting: "R265422",
  });
  writeOperatorMonitorAcknowledgement({
    root,
    monitorRequestPath: request.path,
    classification: "application_ready",
    observedAt: "2026-08-04T12:00:00.000Z",
  });
}

function writeProcessAudit(root: string): void {
  writeFileSync(join(root, "process-audit.json"), JSON.stringify({
    schemaVersion: 1,
    evidenceRevision: "s2-windows-process-audit-v1",
    status: "pass",
    jobCloseApplied: true,
    membersObservedBeforeClose: 1,
    membersAliveAfterClose: 0,
    checkedAt: "2026-08-04T12:01:00.000Z",
  }));
}
