import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditStage2AccountAccessCompletion } from "../../../src/composition/private/s2-completion-audit.ts";
import { writeAccountAccessDiagnostics } from "../../../src/live/evidence/account-access-diagnostics.ts";
import { writeAccountAccessEvidence } from "../../../src/live/evidence/account-access-evidence.ts";
import {
  MONITOR_SCREENSHOT_FILE,
  writeOperatorMonitorAcknowledgement,
} from "../../../src/live/evidence/operator-monitor-ack.ts";

const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
const journey = "journey_abcdefghijklmnop" as never;

test("completion audit requires acceptance, MCP, monitor, privacy, Submit safety, and cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-completion-"));
  try {
    await writeAccountAccessEvidence({
      root,
      acceptance: {
        schemaVersion: 1,
        evidenceRevision: "s2-account-access-acceptance-v1",
        checkpoint: "account_access",
        status: "passed",
        sourceRevision,
        revisionId: "revision_abcdefghijklmnop",
        approvalId: "approval_abcdefghijklmnop",
        journeyId: journey,
        targetHandleId: "target_ref_abcdefghijklmnop",
        verifiedTargetDimensions: ["host", "tenant", "posting"],
        accountMode: "sign_in",
        accountOutcome: "application_ready",
        independentlyVerifiedFields: ["email", "password"],
        submitActivated: false,
        privacyScan: "pass",
        cleanup: "pass",
      },
      sensitiveValues: [],
    });
    await writeAccountAccessDiagnostics({
      root,
      diagnostics: {
        schemaVersion: 1,
        evidenceRevision: "s2-account-access-diagnostics-v1",
        checkpoint: "account_access",
        sourceRevision,
        revisionId: "revision_abcdefghijklmnop",
        journeyId: journey,
        status: "passed",
        completedSteps: 0,
        events: [],
        terminal: null,
        submitActivated: false,
        privacyScan: "pass",
        cleanup: "pass",
      },
      sensitiveValues: [],
    });
    writeFileSync(join(root, MONITOR_SCREENSHOT_FILE), Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
    writeOperatorMonitorAcknowledgement({
      root,
      classification: "application_ready",
      observedAt: "2026-08-03T20:00:00.000Z",
    });
    writeFileSync(join(root, "process-audit.json"), JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-windows-process-audit-v1",
      status: "pass",
      jobCloseApplied: true,
      membersObservedBeforeClose: 0,
      membersAliveAfterClose: 0,
      checkedAt: "2026-08-03T20:01:00.000Z",
    }));

    const audit = await auditStage2AccountAccessCompletion(root);
    assert.deepEqual(audit, {
      schemaVersion: 1,
      evidenceRevision: "s2-account-access-completion-v1",
      status: "pass",
      sourceRevision,
      journeyId: journey,
      runStatus: "passed",
      acceptance: "present",
      monitor: "acknowledged",
      monitorClassification: "application_ready",
      mcpStatus: "running",
      mcpResult: "journey_busy",
      processCleanup: "pass",
      privacyScan: "pass",
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

test("completion audit fails closed when monitoring evidence is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-completion-"));
  try {
    await assert.rejects(
      auditStage2AccountAccessCompletion(root),
      /completion audit denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completion audit preserves a monitored unavailable posting as MCP terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-completion-"));
  try {
    await writeAccountAccessDiagnostics({
      root,
      diagnostics: {
        schemaVersion: 1,
        evidenceRevision: "s2-account-access-diagnostics-v1",
        checkpoint: "account_access",
        sourceRevision,
        revisionId: "revision_abcdefghijklmnop",
        journeyId: journey,
        status: "blocked",
        completedSteps: 0,
        events: [],
        terminal: {
          schemaVersion: 4,
          journeyId: journey,
          status: "blocked",
          completedPages: 0,
          factualOutcome: {
            source: "target_identity",
            result: { kind: "posting_unavailable", reason: "not_found" },
          },
        },
        submitActivated: false,
        privacyScan: "pass",
        cleanup: "pass",
      },
      sensitiveValues: [],
    });
    writeFileSync(join(root, MONITOR_SCREENSHOT_FILE), Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
    writeOperatorMonitorAcknowledgement({
      root,
      classification: "posting_unavailable",
      observedAt: "2026-08-03T20:00:00.000Z",
    });
    writeFileSync(join(root, "process-audit.json"), JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-windows-process-audit-v1",
      status: "pass",
      jobCloseApplied: true,
      membersObservedBeforeClose: 0,
      membersAliveAfterClose: 0,
      checkedAt: "2026-08-03T20:01:00.000Z",
    }));

    const audit = await auditStage2AccountAccessCompletion(root);
    assert.equal(audit.runStatus, "blocked");
    assert.equal(audit.acceptance, "not_applicable");
    assert.equal(audit.mcpStatus, "blocked");
    assert.equal(audit.mcpResult, "terminal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
