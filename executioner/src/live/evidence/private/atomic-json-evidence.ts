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

export interface AtomicJsonEvidenceRequest {
  readonly root: string;
  readonly value: unknown;
  readonly sensitiveValues: readonly string[];
  readonly label: string;
}

export function writeAtomicJsonEvidence(request: AtomicJsonEvidenceRequest): void {
  const unavailable = () => failure(`${request.label} evidence unavailable`);
  const denied = () => failure(`${request.label} evidence denied`);
  const root = admittedRoot(request.root, unavailable);
  const target = join(root, "acceptance.json");
  if (existsSync(target)) unavailable();
  const payload = Buffer.from(`${JSON.stringify(request.value, null, 2)}\n`, "utf8");
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
        // Public failure remains bounded to the evidence owner.
      }
    }
    if (existsSync(partial)) rmSync(partial, { force: true });
  }
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
