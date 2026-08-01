import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { JourneyId } from "../../../contracts/index.ts";
import type { SecretHandleMetadataV1 } from "../../../contracts/live/index.ts";
import {
  approvedSecretRoot,
  deleteSecretRecord,
  metadataBytes,
  type StoredSecretMetadata,
  writeSecretRecord,
} from "../record.ts";
import {
  type ExactRecordAclProtector,
  WindowsExactRecordAclProtector,
} from "./exact-record-acl-protector.ts";

const HANDLE_PATTERN = /^secret_handle_[0-9a-f]{32}$/u;
const JOURNEY_PATTERN = /^journey_[A-Za-z0-9_-]{16,64}$/u;
const MAX_GMAIL_LIFETIME_MS = 30 * 60 * 1_000;
const MAX_CIPHERTEXT_BYTES = 1024 * 1024;

export interface ExactSealedGmailRequest {
  readonly handleId: string;
  readonly journeyId: JourneyId;
  readonly expiresAt: string;
}

export interface ExactSealedGmailCustodianOptions {
  readonly root: string;
  readonly forbiddenRoots: readonly string[];
  readonly now?: () => string;
  readonly aclProtector?: ExactRecordAclProtector;
}

export class ExactSealedGmailCustodian {
  readonly #root: string;
  readonly #now: () => string;
  readonly #aclProtector: ExactRecordAclProtector;

  constructor(options: ExactSealedGmailCustodianOptions) {
    this.#root = approvedSecretRoot(options.root, options.forbiddenRoots);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#aclProtector = options.aclProtector ?? new WindowsExactRecordAclProtector();
  }

  async prepare(request: ExactSealedGmailRequest): Promise<PreparedExactGmail> {
    const issuedAt = this.#now();
    if (!validRequest(request, issuedAt)) throw new Error("exact Gmail request invalid");
    const destination = join(this.#root, `${request.handleId}.s2secret`);
    if (await exists(destination)) throw new Error("exact Gmail handle already exists");
    const metadata: StoredSecretMetadata = {
      storageVersion: 1,
      schemaVersion: 1,
      handleId: request.handleId as SecretHandleMetadataV1["handleId"],
      journeyId: request.journeyId,
      provider: "windows_dpapi_current_user_v1",
      purpose: "gmail_oauth",
      consumer: "gmail_auth_executor",
      scope: "mailbox_verification",
      issuedAt,
      expiresAt: request.expiresAt,
      state: "active",
    };
    return new PreparedExactGmail(
      this.#root,
      destination,
      metadata,
      this.#aclProtector,
    );
  }
}

export class PreparedExactGmail {
  readonly #root: string;
  readonly #destination: string;
  readonly #metadata: StoredSecretMetadata;
  readonly #aclProtector: ExactRecordAclProtector;
  #consumed = false;

  constructor(
    root: string,
    destination: string,
    metadata: StoredSecretMetadata,
    aclProtector: ExactRecordAclProtector,
  ) {
    this.#root = root;
    this.#destination = destination;
    this.#metadata = metadata;
    this.#aclProtector = aclProtector;
  }

  entropy(): Uint8Array {
    if (this.#consumed) throw new Error("exact Gmail provisioning consumed");
    return metadataBytes(this.#metadata);
  }

  async commit(sealed: Uint8Array, signal: AbortSignal): Promise<SecretHandleMetadataV1> {
    if (this.#consumed) {
      sealed.fill(0);
      throw new Error("exact Gmail handle already exists");
    }
    try {
      if (signal.aborted) throw new Error("exact Gmail provisioning cancelled");
      if (sealed.byteLength < 1 || sealed.byteLength > MAX_CIPHERTEXT_BYTES) {
        throw new Error("exact Gmail ciphertext invalid");
      }
      if (await exists(this.#destination)) throw new Error("exact Gmail handle already exists");
      this.#consumed = true;
      await writeSecretRecord(this.#root, this.#metadata, sealed);
      try {
        await this.#aclProtector.protect(this.#destination, signal);
      } catch {
        await deleteSecretRecord(this.#root, this.#metadata.handleId);
        throw new Error("exact Gmail store unavailable");
      }
      return publicMetadata(this.#metadata);
    } finally {
      sealed.fill(0);
    }
  }
}

function validRequest(request: ExactSealedGmailRequest, issuedAt: string): boolean {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(request.expiresAt);
  return HANDLE_PATTERN.test(request.handleId) &&
    JOURNEY_PATTERN.test(request.journeyId) &&
    Number.isFinite(issued) && new Date(issued).toISOString() === issuedAt &&
    Number.isFinite(expires) && new Date(expires).toISOString() === request.expiresAt &&
    expires > issued && expires - issued <= MAX_GMAIL_LIFETIME_MS;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw new Error("exact Gmail store unavailable");
  }
}

function publicMetadata(metadata: StoredSecretMetadata): SecretHandleMetadataV1 {
  const { storageVersion: _storageVersion, scope: _scope, ...value } = metadata;
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
