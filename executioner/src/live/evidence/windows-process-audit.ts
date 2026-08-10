import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

export interface WindowsProcessAuditV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-windows-process-audit-v1";
  readonly status: "pass";
  readonly jobCloseApplied: true;
  readonly membersObservedBeforeClose: number;
  readonly membersAliveAfterClose: 0;
  readonly checkedAt: string;
}

export interface WindowsProcessAuditV2 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-windows-process-audit-v2";
  readonly status: "pass";
  readonly runKey: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly configSha256: string;
  readonly processLiveNonceSha256: string;
  readonly processIssuedAt: string;
  readonly processOwnerPid: number;
  readonly processOwnerStartedAt: string;
  readonly processExitObservedAt: string;
  readonly jobCloseApplied: true;
  readonly membersObservedBeforeClose: number;
  readonly membersAliveAfterClose: 0;
  readonly monitorFileCount: number;
  readonly monitorChainSha256: string;
  readonly checkedAt: string;
}

export function readWindowsProcessAudit(
  rootValue: string,
): WindowsProcessAuditV1 | WindowsProcessAuditV2 {
  const denied = (): never => {
    throw new Error("process audit denied");
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
    const path = join(root, "process-audit.json");
    if (
      lstatSync(path).isSymbolicLink() ||
      !statSync(path).isFile() ||
      statSync(path).size < 2 ||
      statSync(path).size > 16 * 1024 ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))
    ) denied();
    const value = JSON.parse(readFileSync(path, "utf8")) as
      WindowsProcessAuditV1 | WindowsProcessAuditV2;
    const legacyKeys = [
      "schemaVersion",
      "evidenceRevision",
      "status",
      "jobCloseApplied",
      "membersObservedBeforeClose",
      "membersAliveAfterClose",
      "checkedAt",
    ];
    const boundKeys = [
      "schemaVersion", "evidenceRevision", "status", "runKey", "journeyId",
      "targetHandleId", "configSha256", "processLiveNonceSha256", "processIssuedAt",
      "processOwnerPid", "processOwnerStartedAt", "processExitObservedAt",
      "jobCloseApplied", "membersObservedBeforeClose", "membersAliveAfterClose",
      "monitorFileCount", "monitorChainSha256", "checkedAt",
    ];
    const keys = Object.keys(value);
    const legacy = value.evidenceRevision === "s2-windows-process-audit-v1";
    if (
      (legacy
        ? keys.length !== legacyKeys.length || legacyKeys.some((key, index) => keys[index] !== key)
        : keys.length !== boundKeys.length || boundKeys.some((key, index) => keys[index] !== key)) ||
      value.schemaVersion !== 1 ||
      !["s2-windows-process-audit-v1", "s2-windows-process-audit-v2"].includes(
        value.evidenceRevision,
      ) ||
      value.status !== "pass" ||
      value.jobCloseApplied !== true ||
      !Number.isInteger(value.membersObservedBeforeClose) ||
      value.membersObservedBeforeClose < 0 ||
      value.membersObservedBeforeClose > 256 ||
      value.membersAliveAfterClose !== 0 ||
      !canonicalTimestamp(value.checkedAt) ||
      (!legacy && !validBoundAudit(value as WindowsProcessAuditV2))
    ) denied();
    return Object.freeze({ ...value });
  } catch {
    return denied();
  }
}

function validBoundAudit(value: WindowsProcessAuditV2): boolean {
  return /^run_\d{8}_[a-z0-9]{16}$/u.test(value.runKey) &&
    /^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) &&
    /^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) &&
    /^[0-9a-f]{64}$/u.test(value.configSha256) &&
    /^[0-9a-f]{64}$/u.test(value.processLiveNonceSha256) &&
    canonicalTimestamp(value.processIssuedAt) &&
    Number.isSafeInteger(value.processOwnerPid) && value.processOwnerPid >= 1 &&
    canonicalTimestamp(value.processOwnerStartedAt) &&
    canonicalTimestamp(value.processExitObservedAt) &&
    Date.parse(value.processIssuedAt) < Date.parse(value.checkedAt) &&
    Date.parse(value.processOwnerStartedAt) >= Date.parse(value.processIssuedAt) &&
    Date.parse(value.processOwnerStartedAt) <= Date.parse(value.processExitObservedAt) &&
    Date.parse(value.processExitObservedAt) >= Date.parse(value.processIssuedAt) &&
    Date.parse(value.processExitObservedAt) <= Date.parse(value.checkedAt) &&
    Number.isInteger(value.monitorFileCount) && value.monitorFileCount >= 0 &&
    value.monitorFileCount <= 1024 && /^[0-9a-f]{64}$/u.test(value.monitorChainSha256);
}

function canonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
