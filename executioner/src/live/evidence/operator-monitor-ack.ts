import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

export const MONITOR_SCREENSHOT_FILE = "monitor-visible.png" as const;
export const MONITOR_ACK_FILE = "monitor-ack.json" as const;
export const MONITOR_REQUEST_FILE = "monitor-request.json" as const;

export type OperatorMonitorClassification =
  | "application_ready"
  | "posting_unavailable"
  | "maintenance"
  | "runtime_error"
  | "account_entry"
  | "verification_required"
  | "manual_action_required"
  | "unknown";

export interface OperatorMonitorAcknowledgementV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-operator-monitor-ack-v2";
  readonly status: "acknowledged";
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly monitorRequestSha256: string;
  readonly classification: OperatorMonitorClassification;
  readonly screenshotFile: typeof MONITOR_SCREENSHOT_FILE;
  readonly screenshotSha256: string;
  readonly observedAt: string;
}

export interface WriteOperatorMonitorAcknowledgementRequest {
  readonly root: string;
  readonly monitorRequestPath: string;
  readonly classification: OperatorMonitorClassification;
  readonly observedAt?: string;
}

export interface OperatorMonitorRequestBinding {
  readonly path: string;
  readonly sha256: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
}

interface OperatorMonitorRequestV1 {
  readonly schemaVersion: 1;
  readonly requestRevision: "s2-operator-monitor-request-v1";
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly host: string;
  readonly tenant: string;
  readonly posting: string;
}

const classifications: readonly OperatorMonitorClassification[] = [
  "application_ready",
  "posting_unavailable",
  "maintenance",
  "runtime_error",
  "account_entry",
  "verification_required",
  "manual_action_required",
  "unknown",
];

export function writeOperatorMonitorAcknowledgement(
  request: WriteOperatorMonitorAcknowledgementRequest,
): OperatorMonitorAcknowledgementV1 {
  const root = admittedRoot(request.root, "monitor acknowledgement unavailable");
  const monitorRequest = readOperatorMonitorRequest(request.monitorRequestPath);
  const acknowledgement = exactAcknowledgement({
    schemaVersion: 1,
    evidenceRevision: "s2-operator-monitor-ack-v2",
    status: "acknowledged",
    journeyId: monitorRequest.journeyId,
    targetHandleId: monitorRequest.targetHandleId,
    monitorRequestSha256: monitorRequest.sha256,
    classification: request.classification,
    screenshotFile: MONITOR_SCREENSHOT_FILE,
    screenshotSha256: screenshotDigest(root),
    observedAt: request.observedAt ?? new Date().toISOString(),
  });
  writeAtomicJsonEvidence({
    root,
    value: acknowledgement,
    sensitiveValues: [],
    label: "operator-monitor-acknowledgement",
    fileName: MONITOR_ACK_FILE,
  });
  return acknowledgement;
}

export function readOperatorMonitorAcknowledgement(
  rootValue: string,
  expected?: OperatorMonitorRequestBinding,
): OperatorMonitorAcknowledgementV1 {
  const denied = (): never => {
    throw new Error("monitor acknowledgement denied");
  };
  const root = admittedRoot(rootValue, "monitor acknowledgement denied");
  const path = join(root, MONITOR_ACK_FILE);
  try {
    if (
      !existsSync(path) ||
      lstatSync(path).isSymbolicLink() ||
      !statSync(path).isFile() ||
      statSync(path).size < 2 ||
      statSync(path).size > 16 * 1024 ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))
    ) denied();
    const acknowledgement = exactAcknowledgement(
      JSON.parse(readFileSync(path, "utf8")) as OperatorMonitorAcknowledgementV1,
    );
    if (acknowledgement.screenshotSha256 !== screenshotDigest(root)) denied();
    if (expected !== undefined && (
      acknowledgement.journeyId !== expected.journeyId ||
      acknowledgement.targetHandleId !== expected.targetHandleId ||
      acknowledgement.monitorRequestSha256 !== expected.sha256
    )) denied();
    return acknowledgement;
  } catch {
    return denied();
  }
}

export async function waitForOperatorMonitorAcknowledgement(
  root: string,
  expected: OperatorMonitorRequestBinding,
  timeoutMs = 180_000,
  pollMs = 250,
): Promise<OperatorMonitorAcknowledgementV1> {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 5_000
  ) throw new TypeError("monitor acknowledgement timing invalid");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return readOperatorMonitorAcknowledgement(root, expected);
    } catch {
      if (Date.now() >= deadline) {
        throw new Error("monitor acknowledgement unavailable");
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
    }
  }
}

function exactAcknowledgement(
  value: OperatorMonitorAcknowledgementV1,
): OperatorMonitorAcknowledgementV1 {
  const expected = [
    "schemaVersion",
    "evidenceRevision",
    "status",
    "journeyId",
    "targetHandleId",
    "monitorRequestSha256",
    "classification",
    "screenshotFile",
    "screenshotSha256",
    "observedAt",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key, index) => keys[index] !== key) ||
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-operator-monitor-ack-v2" ||
    value.status !== "acknowledged" ||
    !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
    !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) ||
    !/^[0-9a-f]{64}$/u.test(value.monitorRequestSha256) ||
    !classifications.includes(value.classification) ||
    value.screenshotFile !== MONITOR_SCREENSHOT_FILE ||
    !/^[0-9a-f]{64}$/u.test(value.screenshotSha256) ||
    !canonicalTimestamp(value.observedAt)
  ) throw new Error("monitor acknowledgement denied");
  return Object.freeze({ ...value });
}

export function writeOperatorMonitorRequest(request: {
  readonly root: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly host: string;
  readonly tenant: string;
  readonly posting: string;
}): OperatorMonitorRequestBinding {
  const root = admittedRoot(request.root, "monitor request unavailable");
  const value = exactMonitorRequest({
    schemaVersion: 1,
    requestRevision: "s2-operator-monitor-request-v1",
    journeyId: request.journeyId,
    targetHandleId: request.targetHandleId,
    host: request.host,
    tenant: request.tenant,
    posting: request.posting,
  });
  const path = join(root, MONITOR_REQUEST_FILE);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    return Object.freeze({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      journeyId: value.journeyId,
      targetHandleId: value.targetHandleId,
    });
  } catch {
    throw new Error("monitor request unavailable");
  } finally {
    bytes.fill(0);
  }
}

function readOperatorMonitorRequest(pathValue: string): OperatorMonitorRequestBinding {
  try {
    if (
      !isAbsolute(pathValue) ||
      normalize(pathValue) !== pathValue ||
      lstatSync(pathValue).isSymbolicLink() ||
      !statSync(pathValue).isFile() ||
      statSync(pathValue).size < 2 ||
      statSync(pathValue).size > 16 * 1024 ||
      comparable(realpathSync.native(pathValue)) !== comparable(resolve(pathValue))
    ) throw new Error();
    const bytes = readFileSync(pathValue);
    try {
      const value = exactMonitorRequest(JSON.parse(bytes.toString("utf8")));
      return Object.freeze({
        path: realpathSync.native(pathValue),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        journeyId: value.journeyId,
        targetHandleId: value.targetHandleId,
      });
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new Error("monitor request unavailable");
  }
}

function exactMonitorRequest(value: OperatorMonitorRequestV1): OperatorMonitorRequestV1 {
  const expected = [
    "schemaVersion",
    "requestRevision",
    "journeyId",
    "targetHandleId",
    "host",
    "tenant",
    "posting",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key, index) => keys[index] !== key) ||
    value.schemaVersion !== 1 ||
    value.requestRevision !== "s2-operator-monitor-request-v1" ||
    !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
    !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) ||
    !/^[a-z0-9.-]{4,253}$/u.test(value.host) ||
    !/^[a-z0-9-]{2,64}$/u.test(value.tenant) ||
    !/^[A-Za-z0-9-]{2,64}$/u.test(value.posting) ||
    value.host.split(".")[0] !== value.tenant
  ) throw new Error("monitor request unavailable");
  return Object.freeze({ ...value });
}

function screenshotDigest(root: string): string {
  const path = join(root, MONITOR_SCREENSHOT_FILE);
  try {
    if (
      !existsSync(path) ||
      lstatSync(path).isSymbolicLink() ||
      !statSync(path).isFile() ||
      statSync(path).size < 8 ||
      statSync(path).size > 12 * 1024 * 1024 ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))
    ) throw new Error("invalid screenshot");
    const bytes = readFileSync(path);
    try {
      if (!bytes.subarray(0, 8).equals(Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]))) throw new Error("invalid screenshot");
      return createHash("sha256").update(bytes).digest("hex");
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new Error("monitor screenshot unavailable");
  }
}

function canonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function admittedRoot(value: string, message: string): string {
  try {
    if (
      !isAbsolute(value) ||
      normalize(value) !== value ||
      lstatSync(value).isSymbolicLink() ||
      !statSync(value).isDirectory() ||
      comparable(realpathSync.native(value)) !== comparable(resolve(value))
    ) throw new Error(message);
    return realpathSync.native(value);
  } catch {
    throw new Error(message);
  }
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
