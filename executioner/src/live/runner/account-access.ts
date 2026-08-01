import type {
  ActiveAccountSecretHandle,
  CredentialMutationAdapter,
  LiveBrowserSessionV1,
  LivePortResult,
  OperationId,
  PersistentBrowserErrorCode,
  PersistentBrowserSession,
  ProfileLeaseId,
  SecretHandleId,
  SecretHandleMetadataV1,
  SecretStore,
  TargetIdentityV1,
  JourneyId,
} from "../../contracts/index.ts";

export interface Stage2AccountAccessInput {
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: JourneyId;
  readonly accountMode: "fresh_create" | "sign_in";
  readonly targetHandleId: string;
  readonly profileLeaseId: ProfileLeaseId;
  readonly target: TargetIdentityV1;
  readonly accountSecretHandleId: SecretHandleId;
  readonly accountSecretExpiresAt: string;
  readonly now: string;
}

export interface AccountEntryAdvanceRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly sessionId: LiveBrowserSessionV1["sessionId"];
  readonly target: TargetIdentityV1;
  readonly now: string;
}

export interface AccountEntryNavigator {
  advanceToAccountEntry(
    request: AccountEntryAdvanceRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<{
    readonly kind: "account_boundary";
  } | {
    readonly kind: "target_mismatch";
    readonly dimension: "host" | "tenant" | "posting";
  } | {
    readonly kind: "target_ambiguous";
  } | {
    readonly kind: "posting_unavailable";
    readonly reason: "not_found" | "closed" | "removed" | "unavailable";
  }, PersistentBrowserErrorCode>>;
}

export type AccountAccessTargetFact =
  | { readonly kind: "target_mismatch"; readonly dimension: "host" | "tenant" | "posting" }
  | { readonly kind: "target_ambiguous" }
  | {
      readonly kind: "posting_unavailable";
      readonly reason: "not_found" | "closed" | "removed" | "unavailable";
    };

export interface AccountAccessAcceptance {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-account-access-acceptance-v1";
  readonly checkpoint: "account_access";
  readonly status: "passed";
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly verifiedTargetDimensions: readonly ["host", "tenant", "posting"];
  readonly accountMode: "fresh_create" | "sign_in";
  readonly accountOutcome: "verification_required" | "application_ready";
  readonly independentlyVerifiedFields: readonly ["email", "password"];
  readonly submitActivated: false;
  readonly privacyScan: "pass";
  readonly cleanup: "pass";
}

export interface AccountAccessEvidenceWriter {
  write(value: AccountAccessAcceptance): Promise<void>;
}

export interface Stage2AccountAccessDependencies {
  readonly secretStore: SecretStore;
  readonly browser: PersistentBrowserSession;
  readonly navigator: AccountEntryNavigator;
  readonly credentials: CredentialMutationAdapter;
  readonly evidence: AccountAccessEvidenceWriter;
  readonly nextOperationId: () => OperationId;
}

export type Stage2AccountAccessResult =
  | { readonly ok: true; readonly acceptance: AccountAccessAcceptance }
  | { readonly ok: false; readonly code: string; readonly fact?: AccountAccessTargetFact };

export async function runStage2AccountAccess(
  input: Stage2AccountAccessInput,
  dependencies: Stage2AccountAccessDependencies,
  signal: AbortSignal,
): Promise<Stage2AccountAccessResult> {
  if (signal.aborted) return failure("operation_cancelled");
  const account = await inspect(
    dependencies.secretStore,
    input,
    input.accountSecretHandleId,
    input.accountSecretExpiresAt,
    "account_credentials",
    "credential_mutation_adapter",
    signal,
  );
  if (!account.ok) return failure(account.code);

  let opened: LiveBrowserSessionV1 | undefined;
  let pending: Stage2AccountAccessResult = failure("account_access_failed");
  try {
    const open = await dependencies.browser.open({
      schemaVersion: 1,
      journeyId: input.journeyId,
      operationId: dependencies.nextOperationId(),
      profileLeaseId: input.profileLeaseId,
      target: input.target,
    }, signal);
    if (!open.ok) {
      pending = failure(open.error.code);
    } else {
      opened = open.value.session;
      pending = await enterAndProve(
        input,
        dependencies,
        account.value as ActiveAccountSecretHandle,
        opened,
        signal,
      );
    }
  } catch {
    pending = failure(signal.aborted ? "operation_cancelled" : "account_access_failed");
  }

  if (opened !== undefined) {
    try {
      const cleanup = await dependencies.browser.close({
        schemaVersion: 1,
        journeyId: input.journeyId,
        operationId: dependencies.nextOperationId(),
        sessionId: opened.sessionId,
      }, new AbortController().signal);
      if (!cleanup.ok) {
        if (
          cleanup.error.code !== "browser_session_missing" ||
          pending.ok
        ) return failure(cleanup.error.code);
      }
    } catch {
      return failure("browser_profile_cleanup_failed");
    }
  }
  if (!pending.ok) return pending;
  try {
    await dependencies.evidence.write(pending.acceptance);
    return pending;
  } catch {
    return failure("evidence_unavailable");
  }
}

async function enterAndProve(
  input: Stage2AccountAccessInput,
  dependencies: Stage2AccountAccessDependencies,
  credential: ActiveAccountSecretHandle,
  opened: LiveBrowserSessionV1,
  signal: AbortSignal,
): Promise<Stage2AccountAccessResult> {
  const reconciled = await dependencies.browser.reconcile({
    schemaVersion: 1,
    journeyId: input.journeyId,
    operationId: dependencies.nextOperationId(),
    session: opened,
    expectedTarget: input.target,
  }, signal);
  if (!reconciled.ok) return failure(reconciled.error.code);
  if (reconciled.value.kind !== "matched") return targetFailure(reconciled.value);
  const advanced = await dependencies.navigator.advanceToAccountEntry({
    schemaVersion: 1,
    journeyId: input.journeyId,
    operationId: dependencies.nextOperationId(),
    sessionId: reconciled.value.session.sessionId,
    target: input.target,
    now: input.now,
  }, signal);
  if (!advanced.ok) return failure(advanced.error.code);
  if (advanced.value.kind !== "account_boundary") {
    return targetFailure(advanced.value);
  }
  const mutated = await dependencies.credentials.mutate({
    schemaVersion: 1,
    journeyId: input.journeyId,
    operationId: dependencies.nextOperationId(),
    sessionId: reconciled.value.session.sessionId,
    target: input.target,
    now: input.now,
    mode: input.accountMode === "fresh_create" ? "create_account" : "sign_in",
    credential,
    fields: ["email", "password"],
  }, signal);
  if (!mutated.ok) return failure(mutated.error.code);
  if (
    mutated.value.attemptedFields.length !== 2 ||
    mutated.value.attemptedFields[0] !== "email" ||
    mutated.value.attemptedFields[1] !== "password" ||
    (input.accountMode === "fresh_create" &&
      mutated.value.kind !== "verification_required") ||
    (input.accountMode === "sign_in" &&
      mutated.value.kind !== "verification_required" &&
      mutated.value.kind !== "application_ready")
  ) return failure("account_proof_invalid");

  const accountOutcome = mutated.value.kind as
    "verification_required" | "application_ready";
  const acceptance = Object.freeze({
    schemaVersion: 1 as const,
    evidenceRevision: "s2-account-access-acceptance-v1" as const,
    checkpoint: "account_access" as const,
    status: "passed" as const,
    sourceRevision: input.sourceRevision,
    revisionId: input.revisionId,
    approvalId: input.approvalId,
    journeyId: input.journeyId,
    targetHandleId: input.targetHandleId,
    verifiedTargetDimensions: Object.freeze(["host", "tenant", "posting"] as const),
    accountMode: input.accountMode,
    accountOutcome,
    independentlyVerifiedFields: Object.freeze(["email", "password"] as const),
    submitActivated: false as const,
    privacyScan: "pass" as const,
    cleanup: "pass" as const,
  });
  return { ok: true, acceptance };
}

async function inspect(
  secretStore: SecretStore,
  input: Stage2AccountAccessInput,
  handleId: SecretHandleId,
  expectedExpiresAt: string,
  purpose: "account_credentials" | "gmail_oauth",
  consumer: "credential_mutation_adapter" | "gmail_auth_executor",
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: SecretHandleMetadataV1 }
  | { readonly ok: false; readonly code: string }
> {
  let result: Awaited<ReturnType<SecretStore["inspect"]>>;
  try {
    result = await secretStore.inspect({
      schemaVersion: 1,
      journeyId: input.journeyId,
      handleId,
      expectedPurpose: purpose,
      expectedConsumer: consumer,
    }, signal);
  } catch {
    return failure(signal.aborted ? "operation_cancelled" : "secret_store_unavailable");
  }
  if (!result.ok) return failure(result.error.code);
  if (!exactMetadata(
    result.value,
    input,
    handleId,
    expectedExpiresAt,
    purpose,
    consumer,
  )) {
    return failure("secret_handle_mismatched");
  }
  return { ok: true, value: result.value };
}

function exactMetadata(
  value: SecretHandleMetadataV1,
  input: Stage2AccountAccessInput,
  handleId: SecretHandleId,
  expectedExpiresAt: string,
  purpose: "account_credentials" | "gmail_oauth",
  consumer: "credential_mutation_adapter" | "gmail_auth_executor",
): boolean {
  return value.schemaVersion === 1 &&
    value.handleId === handleId &&
    value.journeyId === input.journeyId &&
    value.provider === "windows_dpapi_current_user_v1" &&
    value.purpose === purpose &&
    value.consumer === consumer &&
    value.state === "active" &&
    value.expiresAt === expectedExpiresAt &&
    Number.isFinite(Date.parse(value.issuedAt)) &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.issuedAt) < Date.parse(value.expiresAt) &&
    Date.parse(value.expiresAt) > Date.parse(input.now);
}

function failure(code: string): { readonly ok: false; readonly code: string } {
  return Object.freeze({ ok: false, code });
}

function targetFailure(fact: AccountAccessTargetFact): {
  readonly ok: false;
  readonly code: string;
  readonly fact: AccountAccessTargetFact;
} {
  const copied = fact.kind === "target_mismatch"
    ? Object.freeze({ kind: fact.kind, dimension: fact.dimension })
    : fact.kind === "posting_unavailable"
      ? Object.freeze({ kind: fact.kind, reason: fact.reason })
      : Object.freeze({ kind: fact.kind });
  return Object.freeze({ ok: false, code: fact.kind, fact: copied });
}
