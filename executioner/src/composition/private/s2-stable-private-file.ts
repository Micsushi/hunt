import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

const READ_CHUNK_BYTES = 64 * 1024;

export interface StablePrivateFile {
  readonly canonicalPath: string;
  readonly bytes: Buffer;
}

export function readStablePrivateFile(
  value: string,
  maximumBytes: number,
  options: { readonly notModifiedAfterMs?: number } = {},
): StablePrivateFile {
  if (
    !isAbsolute(value) ||
    normalize(value) !== value ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1
  ) denied();
  const canonicalPath = realpathSync.native(value);
  const beforePath = statSync(value, { bigint: true });
  if (
    comparable(canonicalPath) !== comparable(resolve(value)) ||
    lstatSync(value).isSymbolicLink() ||
    !admitted(beforePath, maximumBytes, options.notModifiedAfterMs)
  ) denied();

  const descriptor = openSync(value, "r");
  const chunks: Buffer[] = [];
  let result: Buffer | undefined;
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!sameFile(beforePath, before) || before.nlink !== 1n) denied();
    let total = 0;
    while (total <= maximumBytes) {
      const chunk = Buffer.alloc(Math.min(
        READ_CHUNK_BYTES,
        maximumBytes + 1 - total,
      ));
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    if (total < 1 || total > maximumBytes) denied();
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = statSync(value, { bigint: true });
    if (
      lstatSync(value).isSymbolicLink() ||
      comparable(realpathSync.native(value)) !== comparable(canonicalPath) ||
      !admitted(after, maximumBytes, options.notModifiedAfterMs) ||
      !admitted(afterPath, maximumBytes, options.notModifiedAfterMs) ||
      !sameFile(before, after) ||
      !sameFile(after, afterPath) ||
      BigInt(total) !== after.size
    ) denied();
    result = Buffer.concat(chunks, total);
    return Object.freeze({ canonicalPath, bytes: result });
  } catch {
    result?.fill(0);
    return denied();
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    closeSync(descriptor);
  }
}

function admitted(
  value: BigIntStats,
  maximumBytes: number,
  notModifiedAfterMs: number | undefined,
): boolean {
  if (
    !value.isFile() ||
    value.nlink !== 1n ||
    value.size < 1n ||
    value.size > BigInt(maximumBytes)
  ) return false;
  if (notModifiedAfterMs === undefined) return true;
  if (!Number.isFinite(notModifiedAfterMs)) return false;
  const limit = BigInt(Math.trunc(notModifiedAfterMs)) * 1_000_000n;
  return value.mtimeNs <= limit && value.ctimeNs <= limit;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new TypeError("private file denied");
}
