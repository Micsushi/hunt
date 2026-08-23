import { createHash, randomBytes } from "node:crypto";
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
const MAX_APPLICATION_WALK_ACCEPTANCE_BYTES = 128 * 1024;
const MAX_DIAGNOSTICS_BYTES = 64 * 1024;
const MAX_PROFILE_FIELD_LEARNING_BYTES = 256 * 1024;
const MAX_STORAGE_MANIFEST_BYTES = 512 * 1024;
const OPAQUE_ID_PREFIXES = [
  "approval_", "checkpoint_", "event_", "host_", "journey_", "operation_",
  "posting_", "profile_lease_", "revision_", "target_ref_", "tenant_",
] as const;

export interface AtomicJsonEvidenceRequest {
  readonly root: string;
  readonly value: unknown;
  readonly sensitiveValues: readonly string[];
  readonly reviewedStructuralValues?: readonly string[];
  readonly reviewedSha256Keys?: readonly string[];
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
    | "disposal-audit.json"
    | "profile-field-learning.json"
    | "profile-field-learning-02.json"
    | "question-answer-learning.json"
    | "terminal-artifact.json"
    | "retained-fixture-control-learning.json";
}

export function writeAtomicJsonEvidence(request: AtomicJsonEvidenceRequest): string {
  const unavailable = () => failure(`${request.label} evidence unavailable`);
  const denied = (reason?: string) => failure(
    `${request.label} evidence denied${reason === undefined ? "" : `: ${reason}`}`,
  );
  const root = admittedRoot(request.root, unavailable);
  const target = join(root, request.fileName ?? "acceptance.json");
  if (existsSync(target)) unavailable();
  const retainedStrings: { readonly key: string; readonly value: string }[] = [];
  const serialized = JSON.stringify(request.value, (key, value: unknown) => {
    if (typeof value === "string") {
      retainedStrings.push({ key, value: withoutOpaquePrefix(value) });
    }
    return value;
  }, 2);
  const payload = Buffer.from(`${serialized}\n`, "utf8");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const maxBytes = request.fileName === "application-walk-acceptance.json"
    ? MAX_APPLICATION_WALK_ACCEPTANCE_BYTES
    : request.fileName === "storage-manifest.json"
      ? MAX_STORAGE_MANIFEST_BYTES
    : request.fileName === "profile-field-learning.json" ||
      request.fileName === "profile-field-learning-02.json" ||
      request.fileName === "question-answer-learning.json" ||
      request.fileName === "retained-fixture-control-learning.json"
    ? MAX_PROFILE_FIELD_LEARNING_BYTES
    : request.fileName === "diagnostics.json"
      ? MAX_DIAGNOSTICS_BYTES
      : MAX_ACCEPTANCE_BYTES;
  if (payload.byteLength > maxBytes) denied("payload_size");
  for (const [sensitiveIndex, sensitive] of request.sensitiveValues.entries()) {
    const normalizedSensitive = withoutOpaquePrefix(sensitive);
    const retainedIndex = normalizedSensitive.length < 3
      ? -1
      : retainedStrings.findIndex(({ key, value }) =>
        value.includes(normalizedSensitive) &&
        !request.reviewedStructuralValues?.includes(value) &&
        !(
          request.reviewedSha256Keys?.includes(key) &&
          /^[0-9a-f]{64}$/u.test(value)
        )
      );
    if (retainedIndex !== -1) {
      payload.fill(0);
      const retained = retainedStrings[retainedIndex]!;
      denied(`sensitive_${sensitiveIndex}_${retainedIndex}_${retained.key}`);
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
    return sha256;
  } catch {
    return unavailable();
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
