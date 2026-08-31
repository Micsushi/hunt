import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

const MAX_RETAINED_FILE_BYTES = 12 * 1024 * 1024;

export function verifyManifestRetainedFiles(root: string, value: unknown): void {
  if (!Array.isArray(value) || value.length < 2 || value.length > 2_048) denied();
  const retained = value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) denied();
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("\0") !== "bytes\0file\0sha256" ||
      typeof record.file !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/u.test(record.file) ||
      typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(record.sha256) ||
      !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 1 ||
      (record.bytes as number) > MAX_RETAINED_FILE_BYTES
    ) denied();
    const path = admittedFile(join(root, record.file));
    const bytes = readFileSync(path);
    try {
      if (
        bytes.byteLength !== record.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== record.sha256
      ) denied();
    } finally {
      bytes.fill(0);
    }
    return record.file;
  });
  if (new Set(retained).size !== retained.length) denied();
  const actual = readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "storage-manifest.json" || entry.name === "disposal-audit.json") return [];
    if (entry.isFile() && !entry.isSymbolicLink()) return [entry.name];
    if (!entry.isDirectory() || entry.isSymbolicLink()) denied();
    return readdirSync(join(root, entry.name), { withFileTypes: true }).map((nested) => {
      if (!nested.isFile() || nested.isSymbolicLink()) denied();
      return `${entry.name}/${nested.name}`;
    });
  }).sort();
  if (actual.join("\0") !== [...retained].sort().join("\0")) denied();
}

function admittedFile(path: string): string {
  const status = lstatSync(path);
  const admitted = realpathSync.native(path);
  if (
    status.isSymbolicLink() || !status.isFile() || status.size < 1 ||
    status.size > MAX_RETAINED_FILE_BYTES || comparable(admitted) !== comparable(resolve(path))
  ) denied();
  return admitted;
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new TypeError("storage catalog rebuild denied");
}
