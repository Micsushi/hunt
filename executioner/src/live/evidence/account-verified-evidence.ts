import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

export interface AccountVerifiedAcceptanceV2 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-account-verified-acceptance-v2";
  readonly checkpoint: "account_verified";
  readonly status: "passed";
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly accountState: "application_ready";
  readonly independentlyObservedVerifiedState: true;
  readonly verificationProof: "gmail_candidate_consumed" | "credential_sign_in";
  readonly provider: "gmail-api-v1" | "workday-auth";
  readonly consumedCandidateCount: 0 | 1;
  readonly messageBodyRetained: false;
  readonly submitActivated: false;
  readonly privacyScan: "pass";
  readonly cleanup: "pass";
}

export interface WriteAccountVerifiedEvidenceRequest {
  readonly root: string;
  readonly acceptance: AccountVerifiedAcceptanceV2;
  readonly sensitiveValues: readonly string[];
}

export async function writeAccountVerifiedEvidence(
  request: WriteAccountVerifiedEvidenceRequest,
): Promise<void> {
  writeAtomicJsonEvidence({
    root: request.root,
    value: admitAccountVerifiedEvidence(request.acceptance),
    sensitiveValues: request.sensitiveValues,
    label: "account-verified",
  });
}

export function readAccountVerifiedEvidence(rootValue: string): AccountVerifiedAcceptanceV2 {
  try {
    if (
      !isAbsolute(rootValue) || normalize(rootValue) !== rootValue ||
      lstatSync(rootValue).isSymbolicLink() || !statSync(rootValue).isDirectory() ||
      comparable(realpathSync.native(rootValue)) !== comparable(resolve(rootValue))
    ) denied();
    const path = join(realpathSync.native(rootValue), "acceptance.json");
    if (
      lstatSync(path).isSymbolicLink() || !statSync(path).isFile() ||
      statSync(path).size < 2 || statSync(path).size > 16 * 1024 ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))
    ) denied();
    return admitAccountVerifiedEvidence(
      JSON.parse(readFileSync(path, "utf8")) as AccountVerifiedAcceptanceV2,
    );
  } catch {
    return denied();
  }
}

export function admitAccountVerifiedEvidence(
  value: AccountVerifiedAcceptanceV2,
): AccountVerifiedAcceptanceV2 {
  const expected = [
    "schemaVersion", "evidenceRevision", "checkpoint", "status", "sourceRevision",
    "revisionId", "approvalId", "journeyId", "targetHandleId", "accountState",
    "independentlyObservedVerifiedState", "verificationProof", "provider", "consumedCandidateCount",
    "messageBodyRetained", "submitActivated", "privacyScan", "cleanup",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key, index) => keys[index] !== key) ||
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-account-verified-acceptance-v2" ||
    value.checkpoint !== "account_verified" ||
    value.status !== "passed" ||
    !/^[0-9a-f]{40}$/u.test(value.sourceRevision) ||
    !/^revision_[A-Za-z0-9_-]{16,64}$/u.test(value.revisionId) ||
    !/^approval_[A-Za-z0-9_-]{16,64}$/u.test(value.approvalId) ||
    !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
    !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) ||
    value.accountState !== "application_ready" ||
    value.independentlyObservedVerifiedState !== true ||
    !validProof(value) ||
    value.messageBodyRetained !== false ||
    value.submitActivated !== false ||
    value.privacyScan !== "pass" ||
    value.cleanup !== "pass"
  ) denied();
  return Object.freeze({ ...value });
}

function validProof(value: AccountVerifiedAcceptanceV2): boolean {
  return (
    value.verificationProof === "gmail_candidate_consumed" &&
    value.provider === "gmail-api-v1" && value.consumedCandidateCount === 1
  ) || (
    value.verificationProof === "credential_sign_in" &&
    value.provider === "workday-auth" && value.consumedCandidateCount === 0
  );
}

function denied(): never {
  throw new Error("account-verified evidence denied");
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
