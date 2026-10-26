import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { readOperatorMonitorAcknowledgement } from "../../live/evidence/operator-monitor-ack.ts";
import { writeAtomicJsonEvidence } from "../../live/evidence/private/atomic-json-evidence.ts";
import { readWindowsProcessAudit } from "../../live/evidence/windows-process-audit.ts";

export interface Stage2AccountVerifiedCompletionAuditV2 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-account-verified-completion-v2";
  readonly status: "pass";
  readonly sourceRevision: string;
  readonly journeyId: string;
  readonly runStatus: "passed";
  readonly acceptance: "present";
  readonly monitor: "acknowledged";
  readonly monitorClassification: "application_ready";
  readonly verificationProof:
    | "gmail_candidate_consumed"
    | "credential_sign_in"
    | "application_state_observed";
  readonly provider: "gmail-api-v1" | "workday-auth" | "workday-state";
  readonly consumedCandidateCount: 0 | 1;
  readonly processCleanup: "pass";
  readonly privacyScan: "pass";
  readonly messageBodyRetained: false;
  readonly submitActivated: false;
}

export async function auditStage2AccountVerifiedCompletion(
  rootValue: string,
): Promise<Stage2AccountVerifiedCompletionAuditV2> {
  try {
    const root = admittedRoot(rootValue);
    const acceptance = readAcceptance(root);
    const monitor = readOperatorMonitorAcknowledgement(root);
    readWindowsProcessAudit(root);
    if (
      monitor.journeyId !== acceptance.journeyId ||
      monitor.targetHandleId !== acceptance.targetHandleId ||
      monitor.classification !== "application_ready"
    ) denied();
    const audit: Stage2AccountVerifiedCompletionAuditV2 = Object.freeze({
      schemaVersion: 1,
      evidenceRevision: "s2-account-verified-completion-v2",
      status: "pass",
      sourceRevision: acceptance.sourceRevision,
      journeyId: acceptance.journeyId,
      runStatus: "passed",
      acceptance: "present",
      monitor: "acknowledged",
      monitorClassification: "application_ready",
      verificationProof: acceptance.verificationProof,
      provider: acceptance.provider,
      consumedCandidateCount: acceptance.consumedCandidateCount,
      processCleanup: "pass",
      privacyScan: "pass",
      messageBodyRetained: false,
      submitActivated: false,
    });
    writeAtomicJsonEvidence({
      root,
      value: audit,
      sensitiveValues: [],
      label: "account-verified completion audit",
      fileName: "completion-audit.json",
    });
    return audit;
  } catch {
    return denied();
  }
}

interface Acceptance {
  readonly sourceRevision: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly verificationProof:
    | "gmail_candidate_consumed"
    | "credential_sign_in"
    | "application_state_observed";
  readonly provider: "gmail-api-v1" | "workday-auth" | "workday-state";
  readonly consumedCandidateCount: 0 | 1;
}

function readAcceptance(root: string): Acceptance {
  const path = join(root, "acceptance.json");
  if (
    lstatSync(path).isSymbolicLink() || !statSync(path).isFile() ||
    statSync(path).size < 2 || statSync(path).size > 16 * 1024 ||
    comparable(realpathSync.native(path)) !== comparable(resolve(path))
  ) denied();
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const expected = [
    "schemaVersion", "evidenceRevision", "checkpoint", "status", "sourceRevision",
    "revisionId", "approvalId", "journeyId", "targetHandleId", "accountState",
    "independentlyObservedVerifiedState", "verificationProof", "provider", "consumedCandidateCount",
    "messageBodyRetained", "submitActivated", "privacyScan", "cleanup",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length || expected.some((key, index) => keys[index] !== key) ||
    value.schemaVersion !== 1 || value.evidenceRevision !== "s2-account-verified-acceptance-v2" ||
    value.checkpoint !== "account_verified" || value.status !== "passed" ||
    typeof value.sourceRevision !== "string" || !/^[0-9a-f]{40}$/u.test(value.sourceRevision) ||
    typeof value.journeyId !== "string" || !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
    typeof value.targetHandleId !== "string" || !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) ||
    value.accountState !== "application_ready" || value.independentlyObservedVerifiedState !== true ||
    !validProof(value) ||
    value.messageBodyRetained !== false || value.submitActivated !== false ||
    value.privacyScan !== "pass" || value.cleanup !== "pass"
  ) denied();
  return Object.freeze({
    sourceRevision: value.sourceRevision,
    journeyId: value.journeyId,
    targetHandleId: value.targetHandleId,
    verificationProof: value.verificationProof as Acceptance["verificationProof"],
    provider: value.provider as Acceptance["provider"],
    consumedCandidateCount: value.consumedCandidateCount as Acceptance["consumedCandidateCount"],
  });
}

function validProof(value: Record<string, unknown>): boolean {
  return (
    value.verificationProof === "gmail_candidate_consumed" &&
    value.provider === "gmail-api-v1" && value.consumedCandidateCount === 1
  ) || (
    value.verificationProof === "credential_sign_in" &&
    value.provider === "workday-auth" && value.consumedCandidateCount === 0
  ) || (
    value.verificationProof === "application_state_observed" &&
    value.provider === "workday-state" && value.consumedCandidateCount === 0
  );
}

function admittedRoot(value: string): string {
  if (
    !isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
    !statSync(value).isDirectory() ||
    comparable(realpathSync.native(value)) !== comparable(resolve(value))
  ) denied();
  return realpathSync.native(value);
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new Error("account-verified completion audit denied");
}
