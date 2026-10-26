import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readWindowsProcessAudit } from "../../../src/live/evidence/windows-process-audit.ts";

test("Windows process audit admits only exact zero-descendant cleanup evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-process-audit-"));
  try {
    const audit = {
      schemaVersion: 1,
      evidenceRevision: "s2-windows-process-audit-v1",
      status: "pass",
      jobCloseApplied: true,
      membersObservedBeforeClose: 2,
      membersAliveAfterClose: 0,
      checkedAt: "2026-08-03T20:00:00.000Z",
    };
    writeFileSync(join(root, "process-audit.json"), `${JSON.stringify(audit)}\n`);
    assert.deepEqual(readWindowsProcessAudit(root), audit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows process audit rejects surviving members", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-process-audit-"));
  try {
    writeFileSync(join(root, "process-audit.json"), JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-windows-process-audit-v1",
      status: "failed",
      jobCloseApplied: true,
      membersObservedBeforeClose: 1,
      membersAliveAfterClose: 1,
      checkedAt: "2026-08-03T20:00:00.000Z",
    }));
    assert.throws(() => readWindowsProcessAudit(root), /process audit denied/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows process audit admits exact production-bound Review cleanup evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-process-audit-"));
  try {
    const audit = {
      schemaVersion: 1,
      evidenceRevision: "s2-windows-process-audit-v2",
      status: "pass",
      runKey: "run_20260810_processbindingxx",
      journeyId: "journey_abcdefghijklmnop",
      targetHandleId: "target_ref_abcdefghijklmnop",
      configSha256: "a".repeat(64),
      processLiveNonceSha256: "b".repeat(64),
      processIssuedAt: "2026-08-10T11:59:00.000Z",
      processOwnerPid: 4242,
      processOwnerStartedAt: "2026-08-10T11:59:00.100Z",
      processExitObservedAt: "2026-08-10T12:00:59.000Z",
      jobCloseApplied: true,
      membersObservedBeforeClose: 2,
      membersAliveAfterClose: 0,
      monitorFileCount: 40,
      monitorChainSha256: "c".repeat(64),
      checkedAt: "2026-08-10T12:01:00.000Z",
    } as const;
    writeFileSync(join(root, "process-audit.json"), `${JSON.stringify(audit)}\n`);
    assert.deepEqual(readWindowsProcessAudit(root), audit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows process audit bounds dynamic monitor ledgers", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-process-audit-"));
  try {
    writeFileSync(join(root, "process-audit.json"), JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-windows-process-audit-v2",
      status: "pass",
      runKey: "run_20260810_processbindingxx",
      journeyId: "journey_abcdefghijklmnop",
      targetHandleId: "target_ref_abcdefghijklmnop",
      configSha256: "a".repeat(64),
      processLiveNonceSha256: "b".repeat(64),
      processIssuedAt: "2026-08-10T11:59:00.000Z",
      processOwnerPid: 4242,
      processOwnerStartedAt: "2026-08-10T11:59:00.100Z",
      processExitObservedAt: "2026-08-10T12:00:59.000Z",
      jobCloseApplied: true,
      membersObservedBeforeClose: 2,
      membersAliveAfterClose: 0,
      monitorFileCount: 2049,
      monitorChainSha256: "c".repeat(64),
      checkedAt: "2026-08-10T12:01:00.000Z",
    }));
    assert.throws(() => readWindowsProcessAudit(root), /process audit denied/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
