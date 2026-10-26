import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Stage2AcceptanceArgs } from "../../live/runner/args.ts";
import type { Stage2ApplicationWalkResult } from "../../live/runner/application-walk.ts";
import { readWindowsProcessAudit } from "../../live/evidence/windows-process-audit.ts";
import { writeAtomicJsonEvidence } from "../../live/evidence/private/atomic-json-evidence.ts";

interface PageLocalIdentity {
  readonly revisionId: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly configSha256: string;
}

interface PageLocalPendingTerminal extends PageLocalIdentity {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-page-local-terminal-pending-v1";
  readonly sourceRevision: string;
  readonly requestedCheckpoint: Stage2AcceptanceArgs["checkpoint"];
  readonly status: "passed" | "blocked" | "failed";
  readonly resultCode: string;
  readonly browserCleanup: "pass" | "failed";
  readonly privacyScan: "pass";
  readonly submitActivated: false;
}

export function writePageLocalPendingTerminal(
  args: Stage2AcceptanceArgs,
  sourceRevision: string,
  result: Stage2ApplicationWalkResult,
): void {
  const identity = readIdentity(args.configPath);
  const status = result.ok ? "passed" : result.failure !== undefined ? "blocked" : "failed";
  const pending: PageLocalPendingTerminal = Object.freeze({
    schemaVersion: 1,
    evidenceRevision: "s2-page-local-terminal-pending-v1",
    sourceRevision,
    requestedCheckpoint: args.checkpoint,
    status,
    resultCode: result.ok ? result.acceptance.checkpoint : result.code,
    ...identity,
    browserCleanup: !result.ok && result.cleanupErrorCode !== undefined ? "failed" : "pass",
    privacyScan: "pass",
    submitActivated: false,
  });
  admitPending(pending);
  writeAtomicJsonEvidence({
    root: args.evidenceRoot,
    value: pending,
    sensitiveValues: [],
    label: "page-local pending terminal",
    fileName: "page-local-terminal-pending.json",
  });
}

export function sealPageLocalTerminal(
  args: Stage2AcceptanceArgs,
  runnerExitCode: number,
): void {
  const pendingBytes = readFileSync(join(args.evidenceRoot, "page-local-terminal-pending.json"));
  try {
    const pending = admitPending(JSON.parse(pendingBytes.toString("utf8")));
    const processAudit = readWindowsProcessAudit(args.evidenceRoot);
    if (
      processAudit.evidenceRevision !== "s2-windows-process-audit-v2" ||
      processAudit.journeyId !== pending.journeyId ||
      processAudit.targetHandleId !== pending.targetHandleId ||
      processAudit.configSha256 !== pending.configSha256 ||
      pending.browserCleanup !== "pass" ||
      (pending.status === "passed" ? runnerExitCode !== 0 : runnerExitCode === 0)
    ) throw new TypeError("page-local terminal seal denied");
    const processBytes = readFileSync(join(args.evidenceRoot, "process-audit.json"));
    try {
      writeAtomicJsonEvidence({
        root: args.evidenceRoot,
        value: Object.freeze({
          schemaVersion: 1,
          evidenceRevision: "s2-page-local-terminal-v1",
          sourceRevision: pending.sourceRevision,
          revisionId: pending.revisionId,
          journeyId: pending.journeyId,
          targetHandleId: pending.targetHandleId,
          requestedCheckpoint: pending.requestedCheckpoint,
          status: pending.status,
          resultCode: pending.resultCode,
          runnerExitCode,
          pendingTerminalSha256: sha256(pendingBytes),
          processAuditSha256: sha256(processBytes),
          browserCleanup: "pass",
          processCleanup: "pass",
          privacyScan: "pass",
          submitActivated: false,
        }),
        sensitiveValues: [],
        reviewedSha256Keys: ["pendingTerminalSha256", "processAuditSha256"],
        label: "page-local terminal",
        fileName: "page-local-terminal.json",
      });
    } finally {
      processBytes.fill(0);
    }
  } finally {
    pendingBytes.fill(0);
  }
}

function readIdentity(configPath: string): PageLocalIdentity {
  const bytes = readFileSync(configPath);
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const target = value.target as Record<string, unknown> | undefined;
    const identity = {
      revisionId: value.revisionId,
      journeyId: value.journeyId,
      targetHandleId: target?.handleId,
      configSha256: sha256(bytes),
    };
    if (
      typeof identity.revisionId !== "string" ||
      typeof identity.journeyId !== "string" ||
      typeof identity.targetHandleId !== "string" ||
      !/^revision_[A-Za-z0-9_-]{16,64}$/u.test(identity.revisionId) ||
      !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(identity.journeyId) ||
      !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(identity.targetHandleId)
    ) throw new TypeError("page-local terminal identity denied");
    return Object.freeze(identity as PageLocalIdentity);
  } finally {
    bytes.fill(0);
  }
}

function admitPending(value: unknown): PageLocalPendingTerminal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied();
  const candidate = value as Record<string, unknown>;
  const keys = [
    "schemaVersion", "evidenceRevision", "sourceRevision", "requestedCheckpoint",
    "status", "resultCode", "revisionId", "journeyId", "targetHandleId",
    "configSha256", "browserCleanup", "privacyScan", "submitActivated",
  ];
  if (
    Object.keys(candidate).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(candidate, key)) ||
    candidate.schemaVersion !== 1 ||
    candidate.evidenceRevision !== "s2-page-local-terminal-pending-v1" ||
    typeof candidate.sourceRevision !== "string" || !/^[0-9a-f]{40}$/u.test(candidate.sourceRevision) ||
    typeof candidate.requestedCheckpoint !== "string" ||
    !["resume_verified", "profile_verified", "questionnaire_verified", "pre_review"].includes(candidate.requestedCheckpoint) ||
    typeof candidate.status !== "string" || !["passed", "blocked", "failed"].includes(candidate.status) ||
    typeof candidate.resultCode !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(candidate.resultCode) ||
    typeof candidate.revisionId !== "string" || !/^revision_[A-Za-z0-9_-]{16,64}$/u.test(candidate.revisionId) ||
    typeof candidate.journeyId !== "string" || !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(candidate.journeyId) ||
    typeof candidate.targetHandleId !== "string" || !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(candidate.targetHandleId) ||
    typeof candidate.configSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.configSha256) ||
    !["pass", "failed"].includes(String(candidate.browserCleanup)) ||
    candidate.privacyScan !== "pass" || candidate.submitActivated !== false
  ) denied();
  return Object.freeze(candidate as unknown as PageLocalPendingTerminal);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function denied(): never {
  throw new TypeError("page-local terminal evidence denied");
}
