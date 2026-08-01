import { randomBytes } from "node:crypto";

import type {
  SecretHandleMetadataV1,
} from "../../../contracts/live/index.ts";
import type { JourneyId } from "../../../contracts/index.ts";
import { WindowsDpapiBridge } from "../bridge.ts";
import {
  encodeAccountCredentialBundleV1,
  type AccountCredentialBytesV1,
} from "./account-credential-bundle.ts";
import {
  approvedSecretRoot,
  deleteSecretRecord,
  expectedConsumer,
  expectedScope,
  metadataBytes,
  readSecretRecord,
  type StoredSecretMetadata,
  writeSecretRecord,
} from "../record.ts";
import { cancelled, ok, secretError } from "../result.ts";

const MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface SecretProvisionRequest {
  readonly journeyId: JourneyId;
  readonly expiresAt: string;
}

export interface WindowsDpapiSecretCustodianOptions {
  readonly root: string;
  readonly forbiddenRoots: readonly string[];
  readonly now?: () => string;
  readonly bridge?: WindowsDpapiBridge;
}

export class WindowsDpapiSecretCustodian {
  readonly #root: string;
  readonly #now: () => string;
  readonly #bridge: WindowsDpapiBridge;

  constructor(options: WindowsDpapiSecretCustodianOptions) {
    this.#root = approvedSecretRoot(options.root, options.forbiddenRoots);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#bridge = options.bridge ?? new WindowsDpapiBridge();
  }

  provisionAccount(
    request: SecretProvisionRequest,
    value: AccountCredentialBytesV1,
    signal: AbortSignal,
  ) {
    return this.#provision(
      "account_credentials",
      request,
      encodeAccountCredentialBundleV1(value),
      signal,
    );
  }

  provisionGmail(
    request: SecretProvisionRequest,
    value: Readonly<Uint8Array>,
    signal: AbortSignal,
  ) {
    return this.#provision(
      "gmail_oauth",
      request,
      value.byteLength === 0 ? null : encodeBatch([value]),
      signal,
    );
  }

  async rotateGmail(
    previous: SecretHandleMetadataV1,
    request: SecretProvisionRequest,
    value: Readonly<Uint8Array>,
    signal: AbortSignal,
  ) {
    const created = await this.provisionGmail(request, value, signal);
    if (!created.ok) return created;
    const revoked = await this.#revoke(previous, signal);
    if (revoked.ok) return created;
    await this.delete(created.value, new AbortController().signal);
    return revoked;
  }

  async rotateAccount(
    previous: SecretHandleMetadataV1,
    request: SecretProvisionRequest,
    value: AccountCredentialBytesV1,
    signal: AbortSignal,
  ) {
    const created = await this.provisionAccount(request, value, signal);
    if (!created.ok) return created;
    const revoked = await this.#revoke(previous, signal);
    if (revoked.ok) return created;
    await this.delete(created.value, new AbortController().signal);
    return revoked;
  }

  async delete(metadata: SecretHandleMetadataV1, signal: AbortSignal) {
    if (signal.aborted) return cancelled;
    try {
      const record = await readSecretRecord(this.#root, metadata.handleId);
      if (record === null) return ok(undefined);
      if (
        record.metadata.journeyId !== metadata.journeyId ||
        record.metadata.purpose !== metadata.purpose ||
        record.metadata.consumer !== metadata.consumer
      ) {
        return secretError("secret_handle_mismatched");
      }
      if (signal.aborted) return cancelled;
      await deleteSecretRecord(this.#root, metadata.handleId);
      return ok(undefined);
    } catch {
      return secretError("secret_store_unavailable");
    }
  }

  async #provision(
    purpose: "account_credentials" | "gmail_oauth",
    request: SecretProvisionRequest,
    payload: Uint8Array | null,
    signal: AbortSignal,
  ) {
    if (payload === null) return secretError("secret_handle_mismatched");
    if (signal.aborted) {
      payload.fill(0);
      return cancelled;
    }
    const issuedAt = this.#now();
    const issuedAtMs = Date.parse(issuedAt);
    const expiresAtMs = Date.parse(request.expiresAt);
    if (
      !Number.isFinite(issuedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs > MAX_RETENTION_MS
    ) {
      payload.fill(0);
      return secretError("secret_handle_mismatched");
    }
    const metadata: StoredSecretMetadata = {
      storageVersion: 1,
      schemaVersion: 1,
      handleId: `secret_handle_${randomBytes(16).toString("hex")}` as SecretHandleMetadataV1["handleId"],
      journeyId: request.journeyId,
      provider: "windows_dpapi_current_user_v1",
      purpose,
      consumer: expectedConsumer(purpose),
      scope: expectedScope(purpose),
      issuedAt,
      expiresAt: request.expiresAt,
      state: "active",
    };
    const entropy = metadataBytes(metadata);
    try {
      const sealed = await this.#bridge.protect(payload, entropy, signal);
      try {
        if (signal.aborted) return cancelled;
        await writeSecretRecord(this.#root, metadata, sealed);
      } finally {
        sealed.fill(0);
      }
      return ok(publicMetadata(metadata));
    } catch {
      return signal.aborted ? cancelled : secretError("secret_store_unavailable");
    } finally {
      payload.fill(0);
      entropy.fill(0);
    }
  }

  async #revoke(metadata: SecretHandleMetadataV1, signal: AbortSignal) {
    if (signal.aborted) return cancelled;
    try {
      const record = await readSecretRecord(this.#root, metadata.handleId);
      if (record === null || record.metadata.journeyId !== metadata.journeyId) {
        return secretError("secret_handle_mismatched");
      }
      await deleteSecretRecord(this.#root, metadata.handleId);
      return signal.aborted ? cancelled : ok(undefined);
    } catch {
      return secretError("secret_store_unavailable");
    }
  }
}

function encodeBatch(values: readonly Readonly<Uint8Array>[]): Uint8Array {
  const size = 4 + values.reduce((total, value) => total + 4 + value.byteLength, 0);
  const output = Buffer.allocUnsafe(size);
  output.writeUInt32LE(values.length, 0);
  let offset = 4;
  for (const value of values) {
    output.writeUInt32LE(value.byteLength, offset);
    offset += 4;
    output.set(value, offset);
    offset += value.byteLength;
  }
  return new Uint8Array(output);
}

function publicMetadata(metadata: StoredSecretMetadata): SecretHandleMetadataV1 {
  const { storageVersion: _storageVersion, scope: _scope, ...value } = metadata;
  return value;
}
