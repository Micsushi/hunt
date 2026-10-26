import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  SecretConsumer,
  SecretHandleMetadataV1,
  SecretPurpose,
} from "../../contracts/live/index.ts";

const MAGIC = Buffer.from([72, 83, 50, 68, 80, 65, 80, 73]);
const HANDLE_PATTERN = /^secret_handle_[0-9a-f]{32}$/u;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

export type SecretScope = "account_access" | "mailbox_verification";

export interface StoredSecretMetadata extends SecretHandleMetadataV1 {
  readonly storageVersion: 1;
  readonly scope: SecretScope;
}

export interface StoredSecretRecord {
  readonly metadata: StoredSecretMetadata;
  readonly metadataBytes: Uint8Array;
  readonly sealedBytes: Uint8Array;
}

export function approvedSecretRoot(
  root: string,
  forbiddenRoots: readonly string[],
): string {
  let candidate: string;
  try {
    candidate = realpathSync.native(resolve(root));
  } catch {
    throw new TypeError("secret root is not an approved external directory");
  }
  if (
    !isAbsolute(root) || forbiddenRoots === undefined || forbiddenRoots.length === 0 ||
    forbiddenRoots.some((forbidden) => {
      let boundary: string;
      try {
        boundary = realpathSync.native(resolve(forbidden));
      } catch {
        boundary = resolve(forbidden);
      }
      const relation = relative(boundary, candidate);
      return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
    })
  ) {
    throw new TypeError("secret root is not an approved external directory");
  }
  return candidate;
}

export async function readSecretRecord(
  root: string,
  handleId: string,
): Promise<StoredSecretRecord | null> {
  if (!HANDLE_PATTERN.test(handleId)) return null;
  let value: Buffer;
  try {
    value = await readFile(recordPath(root, handleId));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (value.byteLength < MAGIC.byteLength + 5 || value.byteLength > MAX_RECORD_BYTES) {
    return null;
  }
  if (!value.subarray(0, MAGIC.byteLength).equals(MAGIC)) return null;
  const metadataLength = value.readUInt32LE(MAGIC.byteLength);
  const metadataStart = MAGIC.byteLength + 4;
  const sealedStart = metadataStart + metadataLength;
  if (metadataLength < 2 || sealedStart > value.byteLength) return null;
  const metadataBytes = new Uint8Array(value.subarray(metadataStart, sealedStart));
  const metadata = parseMetadata(metadataBytes);
  if (metadata === null || metadata.handleId !== handleId) return null;
  return {
    metadata,
    metadataBytes,
    sealedBytes: new Uint8Array(value.subarray(sealedStart)),
  };
}

export async function writeSecretRecord(
  root: string,
  metadata: StoredSecretMetadata,
  sealedBytes: Readonly<Uint8Array>,
): Promise<void> {
  if (!HANDLE_PATTERN.test(metadata.handleId)) throw new TypeError("invalid secret handle");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadataBytes = Buffer.from(JSON.stringify(metadata), "utf8");
  const header = Buffer.allocUnsafe(MAGIC.byteLength + 4);
  MAGIC.copy(header);
  header.writeUInt32LE(metadataBytes.byteLength, MAGIC.byteLength);
  const record = Buffer.concat([header, metadataBytes, Buffer.from(sealedBytes)]);
  if (record.byteLength > MAX_RECORD_BYTES) throw new RangeError("secret record exceeds bound");
  const destination = recordPath(root, metadata.handleId);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(record);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    record.fill(0);
    metadataBytes.fill(0);
    header.fill(0);
  }
}

export async function deleteSecretRecord(
  root: string,
  handleId: string,
): Promise<void> {
  if (!HANDLE_PATTERN.test(handleId)) throw new TypeError("invalid secret handle");
  try {
    await unlink(recordPath(root, handleId));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

export function metadataBytes(metadata: StoredSecretMetadata): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(metadata));
}

export function expectedScope(purpose: SecretPurpose): SecretScope {
  return purpose === "account_credentials" ? "account_access" : "mailbox_verification";
}

export function expectedConsumer(purpose: SecretPurpose): SecretConsumer {
  return purpose === "account_credentials"
    ? "credential_mutation_adapter"
    : "gmail_auth_executor";
}

function recordPath(root: string, handleId: string): string {
  const path = resolve(root, `${handleId}.s2secret`);
  const relation = relative(root, path);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new TypeError("invalid secret handle");
  }
  return path;
}

function parseMetadata(value: Uint8Array): StoredSecretMetadata | null {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort();
    const expectedKeys = [
      "consumer", "expiresAt", "handleId", "issuedAt", "journeyId", "provider",
      "purpose", "schemaVersion", "scope", "state", "storageVersion",
    ].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) return null;
    if (
      parsed.storageVersion !== 1 || parsed.schemaVersion !== 1 ||
      typeof parsed.handleId !== "string" || !HANDLE_PATTERN.test(parsed.handleId) ||
      typeof parsed.journeyId !== "string" ||
      parsed.provider !== "windows_dpapi_current_user_v1" ||
      (parsed.purpose !== "account_credentials" && parsed.purpose !== "gmail_oauth") ||
      parsed.consumer !== expectedConsumer(parsed.purpose) ||
      parsed.scope !== expectedScope(parsed.purpose) ||
      typeof parsed.issuedAt !== "string" || !Number.isFinite(Date.parse(parsed.issuedAt)) ||
      typeof parsed.expiresAt !== "string" || !Number.isFinite(Date.parse(parsed.expiresAt)) ||
      (parsed.state !== "active" && parsed.state !== "revoked")
    ) return null;
    return parsed as unknown as StoredSecretMetadata;
  } catch {
    return null;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
