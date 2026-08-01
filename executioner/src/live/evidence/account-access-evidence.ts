import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

const MAX_ACCEPTANCE_BYTES = 16 * 1024;

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
  readonly independentlyVerifiedFields: readonly ["email", "password"];
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
  const root = admittedRoot(request.root);
  const target = join(root, "acceptance.json");
  if (existsSync(target)) unavailable();
  const acceptance = exactAcceptance(request.acceptance);
  const payload = Buffer.from(`${JSON.stringify(acceptance, null, 2)}\n`, "utf8");
  if (payload.byteLength > MAX_ACCEPTANCE_BYTES) denied();
  for (const sensitive of request.sensitiveValues) {
    if (sensitive.length >= 3 && payload.includes(Buffer.from(sensitive, "utf8"))) {
      payload.fill(0);
      denied();
    }
  }

  const partial = join(root, `.acceptance-${randomBytes(16).toString("hex")}.partial`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(partial, "wx", 0o600);
    writeSync(descriptor, payload);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(partial, 0o600);
    if (existsSync(target)) unavailable();
    renameSync(partial, target);
  } catch {
    unavailable();
  } finally {
    payload.fill(0);
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The cleanup result is represented by the bounded public failure.
      }
    }
    if (existsSync(partial)) rmSync(partial, { force: true });
  }
}

function admittedRoot(value: string): string {
  try {
    if (
      !isAbsolute(value) ||
      normalize(value) !== value ||
      lstatSync(value).isSymbolicLink() ||
      !statSync(value).isDirectory() ||
      comparable(realpathSync.native(value)) !== comparable(resolve(value))
    ) unavailable();
    return realpathSync.native(value);
  } catch {
    return unavailable();
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
    !exactArray(value.independentlyVerifiedFields, ["email", "password"]) ||
    value.submitActivated !== false ||
    value.privacyScan !== "pass" ||
    value.cleanup !== "pass"
  ) denied();
  return Object.freeze({
    ...value,
    verifiedTargetDimensions: Object.freeze(["host", "tenant", "posting"] as const),
    independentlyVerifiedFields: Object.freeze(["email", "password"] as const),
  });
}

function exactArray(value: readonly string[], expected: readonly string[]): boolean {
  return value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new Error("account-access evidence denied");
}

function unavailable(): never {
  throw new Error("account-access evidence unavailable");
}
