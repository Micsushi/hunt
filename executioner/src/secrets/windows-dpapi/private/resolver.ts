import type {
  GmailAuthorizationCapability,
} from "../../../contracts/live/private/privileged-capabilities.ts";
import {
  useEphemeralBytes,
} from "../../../contracts/live/private/privileged-capabilities.ts";
import type {
  ActiveAccountSecretHandle,
  ActiveGmailSecretHandle,
  CredentialMutationResult,
  LivePortResult,
  MailboxPollResultV1,
  SecretStoreErrorCode,
  SecretHandleMetadataV1,
} from "../../../contracts/live/index.ts";
import {
  decodeAccountCredentialBundleV1,
  type AccountCredentialBytesV1,
} from "./account-credential-bundle.ts";
import { WindowsDpapiBridge } from "../bridge.ts";
import {
  approvedSecretRoot,
  deleteSecretRecord,
  metadataBytes,
  readSecretRecord,
  type StoredSecretRecord,
} from "../record.ts";
import { cancelled, ok, secretError } from "../result.ts";
import { inspectMetadata } from "../store.ts";

export interface WindowsDpapiSecretResolverOptions {
  readonly root: string;
  readonly forbiddenRoots: readonly string[];
  readonly now?: () => string;
  readonly bridge?: WindowsDpapiBridge;
}

export interface AccountCredentialResolver {
  useAccountCredentials<Result extends CredentialMutationResult>(
    handle: ActiveAccountSecretHandle,
    signal: AbortSignal,
    operation: (value: AccountCredentialBytesV1) => Promise<Result>,
  ): Promise<LivePortResult<Result, SecretStoreErrorCode>>;
}

export class WindowsDpapiSecretResolver implements AccountCredentialResolver {
  readonly #root: string;
  readonly #now: () => string;
  readonly #bridge: WindowsDpapiBridge;

  constructor(options: WindowsDpapiSecretResolverOptions) {
    this.#root = approvedSecretRoot(options.root, options.forbiddenRoots);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#bridge = options.bridge ?? new WindowsDpapiBridge();
  }

  async useAccountCredentials<Result extends CredentialMutationResult>(
    handle: ActiveAccountSecretHandle,
    signal: AbortSignal,
    operation: (value: AccountCredentialBytesV1) => Promise<Result>,
  ) {
    const loaded = await this.#load(handle, signal);
    if (!loaded.ok) return loaded;
    const decoded = decodeAccountCredentialBundleV1(loaded.value);
    loaded.value.fill(0);
    if (decoded === null) return secretError("secret_store_unavailable");
    try {
      return ok(await operation(decoded));
    } finally {
      decoded.email.fill(0);
      decoded.password.fill(0);
    }
  }

  async useGmailAuthorization<Result extends MailboxPollResultV1>(
    handle: ActiveGmailSecretHandle,
    signal: AbortSignal,
    operation: Parameters<GmailAuthorizationCapability["use"]>[0],
  ) {
    const loaded = await this.#load(handle, signal);
    if (!loaded.ok) return loaded;
    const decoded = decodeBatch(loaded.value, 1);
    if (decoded === null) return secretError("secret_store_unavailable");
    const capability: GmailAuthorizationCapability = {
      use: (callback) => useEphemeralBytes(decoded[0]!, callback),
    };
    return ok(await capability.use(operation) as Result);
  }

  async #load(handle: SecretHandleMetadataV1, signal: AbortSignal) {
    if (signal.aborted) return cancelled;
    try {
      const record = await readSecretRecord(this.#root, handle.handleId);
      if (record === null) return secretError("secret_handle_invalid");
      const inspected = inspectMetadata(record.metadata, {
        schemaVersion: 1,
        journeyId: handle.journeyId,
        handleId: handle.handleId,
        expectedPurpose: handle.purpose,
        expectedConsumer: handle.consumer,
      }, this.#now());
      if (!inspected.ok) {
        if (inspected.error.code === "secret_handle_expired") {
          await deleteSecretRecord(this.#root, handle.handleId);
        }
        return inspected;
      }
      if (!sameMetadata(record.metadata, handle)) {
        return secretError("secret_handle_mismatched");
      }
      const entropy = metadataBytes(record.metadata);
      try {
        const value = await this.#bridge.unprotect(record.sealedBytes, entropy, signal);
        if (signal.aborted) {
          value.fill(0);
          return cancelled;
        }
        return ok(value);
      } finally {
        entropy.fill(0);
        record.sealedBytes.fill(0);
        record.metadataBytes.fill(0);
      }
    } catch {
      return signal.aborted ? cancelled : secretError("secret_store_unavailable");
    }
  }
}

function decodeBatch(
  payload: Uint8Array,
  expectedCount: number,
): Uint8Array[] | null {
  const values: Uint8Array[] = [];
  let valid = false;
  try {
    const input = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    if (input.byteLength < 4 || input.readUInt32LE(0) !== expectedCount) return null;
    let offset = 4;
    for (let index = 0; index < expectedCount; index += 1) {
      if (offset + 4 > input.byteLength) return null;
      const size = input.readUInt32LE(offset);
      offset += 4;
      if (size < 1 || offset + size > input.byteLength) return null;
      values.push(new Uint8Array(input.subarray(offset, offset + size)));
      offset += size;
    }
    if (offset !== input.byteLength) return null;
    valid = true;
    return values;
  } finally {
    payload.fill(0);
    if (!valid) for (const value of values) value.fill(0);
  }
}

function sameMetadata(
  stored: SecretHandleMetadataV1,
  supplied: SecretHandleMetadataV1,
): boolean {
  return stored.schemaVersion === supplied.schemaVersion &&
    stored.handleId === supplied.handleId && stored.journeyId === supplied.journeyId &&
    stored.provider === supplied.provider && stored.purpose === supplied.purpose &&
    stored.consumer === supplied.consumer && stored.issuedAt === supplied.issuedAt &&
    stored.expiresAt === supplied.expiresAt && stored.state === supplied.state;
}
