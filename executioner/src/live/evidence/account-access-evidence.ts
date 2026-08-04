import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

export interface AccountAccessAcceptanceV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-account-access-acceptance-v1";
  readonly checkpoint: "account_access";
  readonly status: "passed";
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly verifiedTargetDimensions: readonly ["host", "tenant", "posting"];
  readonly accountMode: "fresh_create" | "sign_in";
  readonly accountOutcome: "verification_required" | "application_ready";
  readonly independentlyVerifiedFields:
    | readonly []
    | readonly ["email", "password"];
  /** Final job-application Submit only; account authentication may be activated. */
  readonly submitActivated: false;
  readonly privacyScan: "pass";
  readonly cleanup: "pass";
}

export interface WriteAccountAccessEvidenceRequest {
  readonly root: string;
  readonly acceptance: AccountAccessAcceptanceV1;
  readonly sensitiveValues: readonly string[];
}

export async function writeAccountAccessEvidence(
  request: WriteAccountAccessEvidenceRequest,
): Promise<void> {
  writeAtomicJsonEvidence({
    root: request.root,
    value: exactAcceptance(request.acceptance),
    sensitiveValues: request.sensitiveValues,
    label: "account-access",
  });
}

export function readAccountAccessEvidence(rootValue: string): AccountAccessAcceptanceV1 {
  const denied = (): never => {
    throw new Error("account-access evidence denied");
  };
  try {
    if (
      !isAbsolute(rootValue) ||
      normalize(rootValue) !== rootValue ||
      lstatSync(rootValue).isSymbolicLink() ||
      !statSync(rootValue).isDirectory() ||
      comparable(realpathSync.native(rootValue)) !== comparable(resolve(rootValue))
    ) denied();
    const root = realpathSync.native(rootValue);
    const path = join(root, "acceptance.json");
    if (
      lstatSync(path).isSymbolicLink() ||
      !statSync(path).isFile() ||
      statSync(path).size < 2 ||
      statSync(path).size > 16 * 1024 ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))
    ) denied();
    return exactAcceptance(
      JSON.parse(readFileSync(path, "utf8")) as AccountAccessAcceptanceV1,
    );
  } catch {
    return denied();
  }
}

function exactAcceptance(value: AccountAccessAcceptanceV1): AccountAccessAcceptanceV1 {
  const keys = Object.keys(value);
  const expected = [
    "schemaVersion", "evidenceRevision", "checkpoint", "status", "sourceRevision", "revisionId",
    "approvalId", "journeyId", "targetHandleId", "verifiedTargetDimensions",
    "accountMode", "accountOutcome", "independentlyVerifiedFields",
    "submitActivated", "privacyScan", "cleanup",
  ];
  if (
    keys.length !== expected.length ||
    expected.some((key, index) => keys[index] !== key) ||
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-account-access-acceptance-v1" ||
    value.checkpoint !== "account_access" ||
    value.status !== "passed" ||
    !/^[0-9a-f]{40}$/u.test(value.sourceRevision) ||
    !/^revision_[A-Za-z0-9_-]{16,64}$/u.test(value.revisionId) ||
    !/^approval_[A-Za-z0-9_-]{16,64}$/u.test(value.approvalId) ||
    !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
    !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) ||
    !exactArray(value.verifiedTargetDimensions, ["host", "tenant", "posting"]) ||
    (value.accountMode !== "fresh_create" && value.accountMode !== "sign_in") ||
    (value.accountOutcome !== "verification_required" &&
      value.accountOutcome !== "application_ready") ||
    !validVerifiedFields(value) ||
    value.submitActivated !== false ||
    value.privacyScan !== "pass" ||
    value.cleanup !== "pass"
  ) denied();
  return Object.freeze({
    ...value,
    verifiedTargetDimensions: Object.freeze(["host", "tenant", "posting"] as const),
    independentlyVerifiedFields: value.independentlyVerifiedFields.length === 0
      ? Object.freeze([] as const)
      : Object.freeze(["email", "password"] as const),
  });
}

function validVerifiedFields(value: AccountAccessAcceptanceV1): boolean {
  return exactArray(value.independentlyVerifiedFields, ["email", "password"]) ||
    (value.accountOutcome === "application_ready" &&
      exactArray(value.independentlyVerifiedFields, []));
}

function exactArray(value: readonly string[], expected: readonly string[]): boolean {
  return value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function denied(): never {
  throw new Error("account-access evidence denied");
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
