import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

export const MONITOR_SCREENSHOT_FILE = "monitor-visible.png" as const;
export const MONITOR_ACK_FILE = "monitor-ack.json" as const;

export type OperatorMonitorClassification =
  | "application_ready"
  | "posting_unavailable"
  | "maintenance"
  | "account_entry"
  | "verification_required"
  | "manual_action_required"
  | "unknown";

export interface OperatorMonitorAcknowledgementV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-operator-monitor-ack-v1";
  readonly status: "acknowledged";
  readonly classification: OperatorMonitorClassification;
  readonly screenshotFile: typeof MONITOR_SCREENSHOT_FILE;
  readonly screenshotSha256: string;
  readonly observedAt: string;
}

export interface WriteOperatorMonitorAcknowledgementRequest {
  readonly root: string;
  readonly classification: OperatorMonitorClassification;
  readonly observedAt?: string;
}

const classifications: readonly OperatorMonitorClassification[] = [
  "application_ready",
  "posting_unavailable",
  "maintenance",
  "account_entry",
  "verification_required",
  "manual_action_required",
  "unknown",
];

export function writeOperatorMonitorAcknowledgement(
  request: WriteOperatorMonitorAcknowledgementRequest,
): OperatorMonitorAcknowledgementV1 {
  const root = admittedRoot(request.root, "monitor acknowledgement unavailable");
  const acknowledgement = exactAcknowledgement({
    schemaVersion: 1,
    evidenceRevision: "s2-operator-monitor-ack-v1",
    status: "acknowledged",
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
    return acknowledgement;
  } catch {
    return denied();
  }
}

export async function waitForOperatorMonitorAcknowledgement(
  root: string,
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
      return readOperatorMonitorAcknowledgement(root);
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
    value.evidenceRevision !== "s2-operator-monitor-ack-v1" ||
    value.status !== "acknowledged" ||
    !classifications.includes(value.classification) ||
    value.screenshotFile !== MONITOR_SCREENSHOT_FILE ||
    !/^[0-9a-f]{64}$/u.test(value.screenshotSha256) ||
    !canonicalTimestamp(value.observedAt)
  ) throw new Error("monitor acknowledgement denied");
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
