import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

const MAX_ACCEPTANCE_BYTES = 16 * 1024;
const MAX_DIAGNOSTICS_BYTES = 64 * 1024;
const OPAQUE_ID_PREFIXES = [
  "approval_", "checkpoint_", "event_", "host_", "journey_", "operation_",
  "posting_", "profile_lease_", "revision_", "target_ref_", "tenant_",
] as const;

export interface AtomicJsonEvidenceRequest {
  readonly root: string;
  readonly value: unknown;
  readonly sensitiveValues: readonly string[];
  readonly label: string;
  readonly fileName?:
    | "acceptance.json"
    | "application-walk-acceptance.json"
    | "review-acceptance.json"
    | "diagnostics.json"
    | "monitor-ack.json"
    | "process-audit.json"
    | "completion-audit.json"
    | "s2-acceptance-manifest.json"
    | "storage-manifest.json"
    | "disposal-audit.json";
}

export function writeAtomicJsonEvidence(request: AtomicJsonEvidenceRequest): void {
  const unavailable = () => failure(`${request.label} evidence unavailable`);
  const denied = () => failure(`${request.label} evidence denied`);
  const root = admittedRoot(request.root, unavailable);
  const target = join(root, request.fileName ?? "acceptance.json");
  if (existsSync(target)) unavailable();
  const retainedStrings: string[] = [];
  const serialized = JSON.stringify(request.value, (_key, value: unknown) => {
    if (typeof value === "string") retainedStrings.push(withoutOpaquePrefix(value));
    return value;
  }, 2);
  const payload = Buffer.from(`${serialized}\n`, "utf8");
  const maxBytes = request.fileName === "diagnostics.json"
    ? MAX_DIAGNOSTICS_BYTES
    : MAX_ACCEPTANCE_BYTES;
  if (payload.byteLength > maxBytes) denied();
  for (const sensitive of request.sensitiveValues) {
    const normalizedSensitive = withoutOpaquePrefix(sensitive);
    if (
      normalizedSensitive.length >= 3 &&
      retainedStrings.some((value) => value.includes(normalizedSensitive))
    ) {
      payload.fill(0);
      denied();
    }
  }

  const partial = join(
    root,
    `.${(request.fileName ?? "acceptance.json").replace(/\.json$/u, "")}-${randomBytes(16).toString("hex")}.partial`,
  );
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
        // Public failure remains bounded to the evidence owner.
      }
    }
    if (existsSync(partial)) rmSync(partial, { force: true });
  }
}

function withoutOpaquePrefix(value: string): string {
  const prefix = OPAQUE_ID_PREFIXES.find((candidate) => value.startsWith(candidate));
  if (prefix === undefined) return value;
  const suffix = value.slice(prefix.length);
  return /^[A-Za-z0-9_-]{16,64}$/u.test(suffix) ? suffix : value;
}

function admittedRoot(value: string, unavailable: () => never): string {
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

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function failure(message: string): never {
  throw new Error(message);
}
