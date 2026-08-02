import { copyContractDataGraph } from "../admission.ts";
import {
  ContractParseError,
} from "../serialized.ts";
import { journeyId } from "../types.ts";
import type {
  CheckpointId,
  CredentialMutationResult,
  LiveBrowserSessionV1,
  LiveCheckpointPhase,
  LiveCheckpointV1,
  LiveEvidenceId,
  LiveEvidenceSealV1,
  LiveIdentifier,
  LiveRevisionId,
  LiveSessionId,
  MailboxPollResultV1,
  ManifestId,
  ProfileLeaseId,
  RecipientBindingId,
  SecretConsumer,
  SecretHandleId,
  SecretHandleMetadataV1,
  SecretHandleState,
  SecretPurpose,
  TargetHostId,
  TargetIdentityV1,
  TargetPostingId,
  TargetTenantId,
  VerificationArtifactMetadataV1,
  VerificationArtifactState,
  VerificationHandleId,
} from "./types.ts";

type JsonObject = Record<string, unknown>;

function snapshot(value: unknown): unknown {
  const copied = copyContractDataGraph(value);
  if (!copied.ok) throw new ContractParseError("invalid_type", "$");
  return copied.value;
}

function record(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractParseError("invalid_type", path);
  }
  return value as JsonObject;
}

function exact(
  value: unknown,
  path: string,
  required: readonly string[],
): JsonObject {
  const result = record(value, path);
  for (const key of required) {
    if (!Object.hasOwn(result, key)) {
      throw new ContractParseError("missing_key", `${path}.${key}`);
    }
  }
  const allowed = new Set(required);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) {
      throw new ContractParseError("extra_key", `${path}.${key}`);
    }
  }
  return result;
}

function versioned(
  value: unknown,
  path: string,
  required: readonly string[],
): JsonObject {
  const result = exact(value, path, ["schemaVersion", ...required]);
  if (result.schemaVersion !== 1) {
    throw new ContractParseError(
      typeof result.schemaVersion === "number"
        ? "incompatible_version"
        : "invalid_type",
      `${path}.schemaVersion`,
    );
  }
  return result;
}

function oneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ContractParseError("invalid_value", path);
  }
  return value as T;
}

function prefixedIdentifier<Kind extends string>(
  value: unknown,
  prefix: string,
  path: string,
): LiveIdentifier<Kind> {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  const expression = new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`, "u");
  if (!expression.test(value)) {
    throw new ContractParseError("invalid_value", path);
  }
  return value as LiveIdentifier<Kind>;
}

function parseJourneyId(value: unknown, path: string) {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  try {
    return journeyId(value);
  } catch {
    throw new ContractParseError("invalid_value", path);
  }
}

function timestamp(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new ContractParseError(
      typeof value === "string" ? "invalid_value" : "invalid_type",
      path,
    );
  }
  return value;
}

function laterThan(value: string, lower: string, path: string): void {
  if (Date.parse(value) <= Date.parse(lower)) {
    throw new ContractParseError("invalid_value", path);
  }
}

function nullable<T>(
  value: unknown,
  parse: (candidate: unknown) => T,
): T | null {
  return value === null ? null : parse(value);
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number") {
    throw new ContractParseError("invalid_type", path);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContractParseError("invalid_value", path);
  }
  return value;
}

function attemptedCredentialFields(
  value: unknown,
  path: string,
): readonly ("email" | "password")[] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ContractParseError("invalid_value", path);
  }
  const fields = value.map((field, index) =>
    oneOf(field, ["email", "password"], `${path}[${index}]`)
  );
  if (fields[0] !== "email" || fields[1] !== "password") {
    throw new ContractParseError("invalid_value", path);
  }
  return fields;
}

export function parseTargetIdentity(value: unknown): TargetIdentityV1 {
  const input = versioned(snapshot(value), "$", [
    "atsFamily",
    "hostId",
    "tenantId",
    "postingId",
  ]);
  return {
    schemaVersion: 1,
    atsFamily: oneOf(input.atsFamily, ["workday"], "$.atsFamily"),
    hostId: prefixedIdentifier(input.hostId, "host", "$.hostId") as TargetHostId,
    tenantId: prefixedIdentifier(input.tenantId, "tenant", "$.tenantId") as TargetTenantId,
    postingId: prefixedIdentifier(input.postingId, "posting", "$.postingId") as TargetPostingId,
  };
}

function nestedTarget(value: unknown, path: string): TargetIdentityV1 {
  try {
    return parseTargetIdentity(value);
  } catch (error) {
    if (!(error instanceof ContractParseError)) throw error;
    const suffix = error.path === "$" ? "" : error.path.slice(1);
    throw new ContractParseError(error.code, `${path}${suffix}`);
  }
}

export function parseLiveBrowserSession(value: unknown): LiveBrowserSessionV1 {
  const input = versioned(snapshot(value), "$", [
    "journeyId",
    "sessionId",
    "profileLeaseId",
    "target",
    "leaseExpiresAt",
  ]);
  return {
    schemaVersion: 1,
    journeyId: parseJourneyId(input.journeyId, "$.journeyId"),
    sessionId: prefixedIdentifier(input.sessionId, "live_session", "$.sessionId") as LiveSessionId,
    profileLeaseId: prefixedIdentifier(
      input.profileLeaseId,
      "profile_lease",
      "$.profileLeaseId",
    ) as ProfileLeaseId,
    target: nestedTarget(input.target, "$.target"),
    leaseExpiresAt: timestamp(input.leaseExpiresAt, "$.leaseExpiresAt"),
  };
}

export function parseSecretHandleMetadata(
  value: unknown,
): SecretHandleMetadataV1 {
  const input = versioned(snapshot(value), "$", [
    "handleId",
    "journeyId",
    "provider",
    "purpose",
    "consumer",
    "issuedAt",
    "expiresAt",
    "state",
  ]);
  const purpose = oneOf(
    input.purpose,
    ["account_credentials", "gmail_oauth"],
    "$.purpose",
  ) as SecretPurpose;
  const consumer = oneOf(
    input.consumer,
    ["credential_mutation_adapter", "gmail_auth_executor"],
    "$.consumer",
  ) as SecretConsumer;
  const expectedConsumer =
    purpose === "account_credentials"
      ? "credential_mutation_adapter"
      : "gmail_auth_executor";
  if (consumer !== expectedConsumer) {
    throw new ContractParseError("invalid_value", "$.consumer");
  }
  const issuedAt = timestamp(input.issuedAt, "$.issuedAt");
  const expiresAt = timestamp(input.expiresAt, "$.expiresAt");
  laterThan(expiresAt, issuedAt, "$.expiresAt");
  return {
    schemaVersion: 1,
    handleId: prefixedIdentifier(input.handleId, "secret_handle", "$.handleId") as SecretHandleId,
    journeyId: parseJourneyId(input.journeyId, "$.journeyId"),
    provider: oneOf(
      input.provider,
      ["windows_dpapi_current_user_v1"],
      "$.provider",
    ),
    purpose,
    consumer,
    issuedAt,
    expiresAt,
    state: oneOf(
      input.state,
      ["active", "expired", "revoked"],
      "$.state",
    ) as SecretHandleState,
  };
}

function receivedTimeBucket(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    `${new Date(Date.parse(value)).toISOString().slice(0, 16)}Z` !== value
  ) {
    throw new ContractParseError(
      typeof value === "string" ? "invalid_value" : "invalid_type",
      path,
    );
  }
  return value;
}

export function parseMailboxPollResult(value: unknown): MailboxPollResultV1 {
  const input = exact(snapshot(value), "$", [
    "provider",
    "receivedTimeBucket",
    "expiresAt",
    "candidateCount",
    "verificationHandle",
  ]);
  const candidateCount = nonnegativeInteger(input.candidateCount, "$.candidateCount");
  const bucket = nullable(input.receivedTimeBucket, (candidate) =>
    receivedTimeBucket(candidate, "$.receivedTimeBucket"),
  );
  const expiresAt = nullable(input.expiresAt, (candidate) =>
    timestamp(candidate, "$.expiresAt"),
  );
  const verificationHandle = nullable(
    input.verificationHandle,
    (candidate) =>
      prefixedIdentifier(
        candidate,
        "verification_handle",
        "$.verificationHandle",
      ) as VerificationHandleId,
  );
  if (
    (candidateCount === 1 && (bucket === null || expiresAt === null)) ||
    (candidateCount !== 1 && verificationHandle !== null)
  ) {
    throw new ContractParseError("invalid_value", "$.verificationHandle");
  }
  return {
    provider: oneOf(input.provider, ["gmail_api_v1"], "$.provider"),
    receivedTimeBucket: bucket,
    expiresAt,
    candidateCount,
    verificationHandle,
  };
}

export function parseCredentialMutationResult(
  value: unknown,
): CredentialMutationResult {
  const copied = snapshot(value);
  const candidate = record(copied, "$");
  const kind = oneOf(
    candidate.kind,
    [
      "existing_account",
      "create_account",
      "account_absent",
      "account_exists",
      "verification_required",
      "application_ready",
      "manual_intervention",
    ],
    "$.kind",
  );
  if (kind === "manual_intervention") {
    const input = exact(copied, "$", ["kind", "reason", "attemptedFields"]);
    return {
      kind,
      reason: oneOf(
        input.reason,
        ["captcha", "mfa", "access_control"],
        "$.reason",
      ),
      attemptedFields: attemptedCredentialFields(
        input.attemptedFields,
        "$.attemptedFields",
      ),
    };
  }
  const input = exact(copied, "$", ["kind", "attemptedFields"]);
  return {
    kind,
    attemptedFields: attemptedCredentialFields(
      input.attemptedFields,
      "$.attemptedFields",
    ),
  };
}

export function parseVerificationArtifactMetadata(
  value: unknown,
): VerificationArtifactMetadataV1 {
  const input = versioned(snapshot(value), "$", [
    "handleId",
    "journeyId",
    "provider",
    "recipientBindingId",
    "target",
    "issuedAt",
    "expiresAt",
    "state",
  ]);
  const issuedAt = timestamp(input.issuedAt, "$.issuedAt");
  const expiresAt = timestamp(input.expiresAt, "$.expiresAt");
  laterThan(expiresAt, issuedAt, "$.expiresAt");
  return {
    schemaVersion: 1,
    handleId: prefixedIdentifier(
      input.handleId,
      "verification_handle",
      "$.handleId",
    ) as VerificationHandleId,
    journeyId: parseJourneyId(input.journeyId, "$.journeyId"),
    provider: oneOf(input.provider, ["gmail_api_v1"], "$.provider"),
    recipientBindingId: prefixedIdentifier(
      input.recipientBindingId,
      "recipient",
      "$.recipientBindingId",
    ) as RecipientBindingId,
    target: nestedTarget(input.target, "$.target"),
    issuedAt,
    expiresAt,
    state: oneOf(
      input.state,
      ["available", "expired", "consumed", "invalidated"],
      "$.state",
    ) as VerificationArtifactState,
  };
}

export function parseLiveCheckpoint(value: unknown): LiveCheckpointV1 {
  const input = versioned(snapshot(value), "$", [
    "journeyId",
    "checkpointId",
    "revisionId",
    "phase",
    "target",
    "sessionId",
    "profileLeaseId",
    "verificationHandle",
    "leaseExpiresAt",
  ]);
  const phase = oneOf(
    input.phase,
    [
      "preflight",
      "account_access",
      "mailbox_verification",
      "verification_navigation",
      "live_application",
      "recovery",
      "review",
    ],
    "$.phase",
  ) as LiveCheckpointPhase;
  const sessionId = nullable(input.sessionId, (candidate) =>
    prefixedIdentifier(candidate, "live_session", "$.sessionId") as LiveSessionId,
  );
  const profileLeaseId = nullable(input.profileLeaseId, (candidate) =>
    prefixedIdentifier(
      candidate,
      "profile_lease",
      "$.profileLeaseId",
    ) as ProfileLeaseId,
  );
  if (
    (phase === "mailbox_verification" || phase === "live_application") &&
    (sessionId === null || profileLeaseId === null)
  ) {
    throw new ContractParseError(
      "invalid_value",
      sessionId === null ? "$.sessionId" : "$.profileLeaseId",
    );
  }
  return {
    schemaVersion: 1,
    journeyId: parseJourneyId(input.journeyId, "$.journeyId"),
    checkpointId: prefixedIdentifier(
      input.checkpointId,
      "checkpoint",
      "$.checkpointId",
    ) as CheckpointId,
    revisionId: prefixedIdentifier(
      input.revisionId,
      "revision",
      "$.revisionId",
    ) as LiveRevisionId,
    phase,
    target: nestedTarget(input.target, "$.target"),
    sessionId,
    profileLeaseId,
    verificationHandle: nullable(input.verificationHandle, (candidate) =>
      prefixedIdentifier(
        candidate,
        "verification_handle",
        "$.verificationHandle",
      ) as VerificationHandleId,
    ),
    leaseExpiresAt: timestamp(input.leaseExpiresAt, "$.leaseExpiresAt"),
  };
}

export function parseLiveEvidenceSeal(value: unknown): LiveEvidenceSealV1 {
  const input = versioned(snapshot(value), "$", [
    "journeyId",
    "evidenceId",
    "manifestId",
    "recordCount",
    "sealedAt",
  ]);
  return {
    schemaVersion: 1,
    journeyId: parseJourneyId(input.journeyId, "$.journeyId"),
    evidenceId: prefixedIdentifier(
      input.evidenceId,
      "live_evidence",
      "$.evidenceId",
    ) as LiveEvidenceId,
    manifestId: prefixedIdentifier(
      input.manifestId,
      "manifest",
      "$.manifestId",
    ) as ManifestId,
    recordCount: nonnegativeInteger(input.recordCount, "$.recordCount"),
    sealedAt: timestamp(input.sealedAt, "$.sealedAt"),
  };
}
