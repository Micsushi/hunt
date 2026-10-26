import type {
  SecretHandleMetadataV1,
  SecretInspectRequest,
  SecretRevokeRequest,
  SecretStore,
} from "../../contracts/live/index.ts";
import {
  approvedSecretRoot,
  deleteSecretRecord,
  readSecretRecord,
} from "./record.ts";
import { cancelled, ok, secretError } from "./result.ts";

export interface WindowsDpapiSecretStoreOptions {
  readonly root: string;
  readonly forbiddenRoots: readonly string[];
  readonly now?: () => string;
}

export class WindowsDpapiSecretStore implements SecretStore {
  readonly #root: string;
  readonly #now: () => string;

  constructor(options: WindowsDpapiSecretStoreOptions) {
    this.#root = approvedSecretRoot(options.root, options.forbiddenRoots);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async inspect(request: SecretInspectRequest, signal: AbortSignal) {
    if (signal.aborted) return cancelled;
    try {
      const record = await readSecretRecord(this.#root, request.handleId);
      if (signal.aborted) return cancelled;
      if (record === null || record.metadata.state === "revoked") {
        return secretError("secret_handle_invalid");
      }
      const inspected = inspectMetadata(record.metadata, request, this.#now());
      if (!inspected.ok && inspected.error.code === "secret_handle_expired") {
        await deleteSecretRecord(this.#root, request.handleId);
      }
      return inspected.ok ? ok(publicMetadata(inspected.value)) : inspected;
    } catch {
      return secretError("secret_store_unavailable");
    }
  }

  async revoke(request: SecretRevokeRequest, signal: AbortSignal) {
    if (signal.aborted) return cancelled;
    try {
      const record = await readSecretRecord(this.#root, request.handleId);
      if (signal.aborted) return cancelled;
      if (record === null) return ok(undefined);
      if (record.metadata.journeyId !== request.journeyId) {
        return secretError("secret_handle_mismatched");
      }
      await deleteSecretRecord(this.#root, request.handleId);
      return ok(undefined);
    } catch {
      return secretError("secret_store_unavailable");
    }
  }
}

export function inspectMetadata(
  metadata: SecretHandleMetadataV1,
  request: SecretInspectRequest,
  now: string,
) {
  if (metadata.handleId !== request.handleId || metadata.state === "revoked") {
    return secretError("secret_handle_invalid");
  }
  if (
    metadata.provider !== "windows_dpapi_current_user_v1" ||
    metadata.journeyId !== request.journeyId ||
    metadata.purpose !== request.expectedPurpose
  ) {
    return secretError("secret_handle_mismatched");
  }
  if (metadata.consumer !== request.expectedConsumer) {
    return secretError("secret_consumer_forbidden");
  }
  if (metadata.state === "expired" || Date.parse(metadata.expiresAt) <= Date.parse(now)) {
    return secretError("secret_handle_expired");
  }
  return ok(metadata);
}

function publicMetadata(
  metadata: SecretHandleMetadataV1 & Partial<{ storageVersion: 1; scope: string }>,
): SecretHandleMetadataV1 {
  const { storageVersion: _storageVersion, scope: _scope, ...value } = metadata;
  return value;
}
