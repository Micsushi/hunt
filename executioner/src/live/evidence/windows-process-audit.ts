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

export function readWindowsProcessAudit(rootValue: string): WindowsProcessAuditV1 {
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
    const value = JSON.parse(readFileSync(path, "utf8")) as WindowsProcessAuditV1;
    const expected = [
      "schemaVersion",
      "evidenceRevision",
      "status",
      "jobCloseApplied",
      "membersObservedBeforeClose",
      "membersAliveAfterClose",
      "checkedAt",
    ];
    const keys = Object.keys(value);
    if (
      keys.length !== expected.length ||
      expected.some((key, index) => keys[index] !== key) ||
      value.schemaVersion !== 1 ||
      value.evidenceRevision !== "s2-windows-process-audit-v1" ||
      value.status !== "pass" ||
      value.jobCloseApplied !== true ||
      !Number.isInteger(value.membersObservedBeforeClose) ||
      value.membersObservedBeforeClose < 0 ||
      value.membersObservedBeforeClose > 256 ||
      value.membersAliveAfterClose !== 0 ||
      !canonicalTimestamp(value.checkedAt)
    ) denied();
    return Object.freeze({ ...value });
  } catch {
    return denied();
  }
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
