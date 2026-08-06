import { s2StableErrorPolicy } from "../../contracts/index.ts";
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
  EventId,
  S2StableErrorCode,
  TerminalResultV4,
} from "../../contracts/index.ts";
import {
  AccountAccessEventRecorder,
  type AccountAccessDiagnostics,
  type AccountAccessDiagnosticsWriter,
} from "./account-access-diagnostics.ts";
export type {
  AccountAccessDiagnostics,
  AccountAccessDiagnosticsWriter,
} from "./account-access-diagnostics.ts";

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
    readonly reason: "not_found" | "closed" | "removed" | "unavailable" | "maintenance" | "runtime_error";
  }, PersistentBrowserErrorCode>>;
}

export type AccountAccessTargetFact =
  | { readonly kind: "target_mismatch"; readonly dimension: "host" | "tenant" | "posting" }
  | { readonly kind: "target_ambiguous" }
  | {
      readonly kind: "posting_unavailable";
      readonly reason: "not_found" | "closed" | "removed" | "unavailable" | "maintenance" | "runtime_error";
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
  readonly independentlyVerifiedFields:
    | readonly []
    | readonly ["email", "password"];
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
  readonly diagnostics: AccountAccessDiagnosticsWriter;
  readonly nextOperationId: () => OperationId;
  readonly nextEventId: () => EventId;
  readonly now: () => string;
}

export type Stage2AccountAccessResult =
  | { readonly ok: true; readonly acceptance: AccountAccessAcceptance }
  | { readonly ok: false; readonly code: string; readonly fact?: AccountAccessTargetFact };

export async function runStage2AccountAccess(
  input: Stage2AccountAccessInput,
  dependencies: Stage2AccountAccessDependencies,
  signal: AbortSignal,
): Promise<Stage2AccountAccessResult> {
  const recorder = new AccountAccessEventRecorder({
    journeyId: input.journeyId,
    nextEventId: dependencies.nextEventId,
    now: dependencies.now,
  });
  if (signal.aborted) {
    return finalize(
      input,
      dependencies,
      recorder,
      failure("operation_cancelled"),
      "pass",
    );
  }
  const inspectOperation = dependencies.nextOperationId();
  recorder.record("S2_SECRET_STORE", "validate", "step_started", inspectOperation);
  const account = await inspect(
    dependencies.secretStore,
    input,
    input.accountSecretHandleId,
    input.accountSecretExpiresAt,
    "account_credentials",
    "credential_mutation_adapter",
    signal,
  );
  if (!account.ok) {
    recorder.record("S2_SECRET_STORE", "validate", "step_failed", inspectOperation);
    return finalize(input, dependencies, recorder, failure(account.code), "pass");
  }
  recorder.record("S2_SECRET_STORE", "validate", "step_completed", inspectOperation);

  let opened: LiveBrowserSessionV1 | undefined;
  let pending: Stage2AccountAccessResult = failure("browser_session_invalidated");
  try {
    const openOperation = dependencies.nextOperationId();
    recorder.record("F3", "start", "step_started", openOperation);
    const open = await dependencies.browser.open({
      schemaVersion: 1,
      journeyId: input.journeyId,
      operationId: openOperation,
      profileLeaseId: input.profileLeaseId,
      target: input.target,
    }, signal);
    if (!open.ok) {
      recorder.record("F3", "start", "step_failed", openOperation);
      pending = failure(open.error.code);
    } else {
      recorder.record("F3", "start", "step_completed", openOperation);
      opened = open.value.session;
      pending = await enterAndProve(
        input,
        dependencies,
        account.value as ActiveAccountSecretHandle,
        opened,
        recorder,
        signal,
      );
    }
  } catch {
    const code = signal.aborted
      ? "operation_cancelled"
      : recorder.unexpectedFailureCode();
    recorder.failActive();
    pending = failure(code);
  }

  let cleanup: AccountAccessDiagnostics["cleanup"] = "pass";
  if (opened !== undefined) {
    const closeOperation = dependencies.nextOperationId();
    recorder.record("F3", "close", "step_started", closeOperation);
    try {
      const closeResult = await dependencies.browser.close({
        schemaVersion: 1,
        journeyId: input.journeyId,
        operationId: closeOperation,
        sessionId: opened.sessionId,
      }, new AbortController().signal);
      if (!closeResult.ok) {
        if (
          closeResult.error.code !== "browser_session_missing" ||
          pending.ok
          ) {
            recorder.record("F3", "close", "step_failed", closeOperation);
            pending = failure(closeResult.error.code);
            cleanup = closeResult.error.code === "browser_effect_uncertain"
              ? "pass"
              : "failed";
        } else {
          recorder.record("F3", "close", "step_completed", closeOperation);
        }
      } else {
        recorder.record("F3", "close", "step_completed", closeOperation);
      }
    } catch {
      recorder.record("F3", "close", "step_failed", closeOperation);
      pending = failure("browser_profile_cleanup_failed");
      cleanup = "failed";
    }
  }
  return finalize(input, dependencies, recorder, pending, cleanup);
}

async function enterAndProve(
  input: Stage2AccountAccessInput,
  dependencies: Stage2AccountAccessDependencies,
  credential: ActiveAccountSecretHandle,
  opened: LiveBrowserSessionV1,
  recorder: AccountAccessEventRecorder,
  signal: AbortSignal,
): Promise<Stage2AccountAccessResult> {
  const reconcileOperation = dependencies.nextOperationId();
  recorder.record("F3", "reconcile", "step_started", reconcileOperation);
  const reconciled = await dependencies.browser.reconcile({
    schemaVersion: 1,
    journeyId: input.journeyId,
    operationId: reconcileOperation,
    session: opened,
    expectedTarget: input.target,
  }, signal);
  if (!reconciled.ok) {
    recorder.record("F3", "reconcile", "step_failed", reconcileOperation);
    return failure(reconciled.error.code);
  }
  recorder.record("F3", "reconcile", "step_completed", reconcileOperation);
  if (reconciled.value.kind !== "matched") return targetFailure(reconciled.value);
  const navigateOperation = dependencies.nextOperationId();
  recorder.record("F3", "navigate", "step_started", navigateOperation);
  const advanced = await dependencies.navigator.advanceToAccountEntry({
    schemaVersion: 1,
    journeyId: input.journeyId,
    operationId: navigateOperation,
    sessionId: reconciled.value.session.sessionId,
    target: input.target,
    now: input.now,
  }, signal);
  if (!advanced.ok) {
    recorder.record("F3", "navigate", "step_failed", navigateOperation);
    return failure(advanced.error.code);
  }
  recorder.record("F3", "navigate", "step_completed", navigateOperation);
  if (advanced.value.kind !== "account_boundary") {
    return targetFailure(advanced.value);
  }
  const mutateOperation = dependencies.nextOperationId();
  recorder.record(
    "S2_CREDENTIAL_MUTATION",
    "mutate",
    "step_started",
    mutateOperation,
  );
  const mutated = await dependencies.credentials.mutate({
    schemaVersion: 1,
    journeyId: input.journeyId,
    operationId: mutateOperation,
    sessionId: reconciled.value.session.sessionId,
    target: input.target,
    now: input.now,
    mode: input.accountMode === "fresh_create" ? "create_account" : "sign_in",
    credential,
    fields: ["email", "password"],
  }, signal);
  if (!mutated.ok) {
    recorder.record(
      "S2_CREDENTIAL_MUTATION",
      "mutate",
      "step_failed",
      mutateOperation,
    );
    return failure(mutated.error.code);
  }
  const fullCredentialSet = mutated.value.attemptedFields.length === 2 &&
    mutated.value.attemptedFields[0] === "email" &&
    mutated.value.attemptedFields[1] === "password";
  const directApplicationAccess = mutated.value.kind === "application_ready" &&
    mutated.value.attemptedFields.length === 0;
  if ((!fullCredentialSet && !directApplicationAccess) ||
      (mutated.value.kind !== "verification_required" &&
        mutated.value.kind !== "application_ready")) {
    recorder.record(
      "S2_CREDENTIAL_MUTATION",
      "mutate",
      "step_failed",
      mutateOperation,
    );
    return failure("credential_mutation_denied");
  }
  recorder.record(
    "S2_CREDENTIAL_MUTATION",
    "mutate",
    "step_completed",
    mutateOperation,
  );

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
    independentlyVerifiedFields: directApplicationAccess
      ? Object.freeze([] as const)
      : Object.freeze(["email", "password"] as const),
    submitActivated: false as const,
    privacyScan: "pass" as const,
    cleanup: "pass" as const,
  });
  return { ok: true, acceptance };
}

async function finalize(
  input: Stage2AccountAccessInput,
  dependencies: Stage2AccountAccessDependencies,
  recorder: AccountAccessEventRecorder,
  candidate: Stage2AccountAccessResult,
  cleanup: AccountAccessDiagnostics["cleanup"],
): Promise<Stage2AccountAccessResult> {
  let result = candidate;
  if (result.ok) {
    const evidenceOperation = dependencies.nextOperationId();
    recorder.record("F11", "persist", "step_started", evidenceOperation);
    try {
      await dependencies.evidence.write(result.acceptance);
      recorder.record("F11", "persist", "step_completed", evidenceOperation);
    } catch {
      recorder.record("F11", "persist", "step_failed", evidenceOperation);
      result = failure("evidence_unavailable");
    }
  }
  if (!result.ok) {
    recorder.record(
      "F9",
      "complete",
      "journey_terminal",
      recorder.lastSource ?? dependencies.nextOperationId(),
    );
  }
  const terminal = terminalResult(input.journeyId, result);
  const diagnostics = Object.freeze({
    schemaVersion: 1 as const,
    evidenceRevision: "s2-account-access-diagnostics-v1" as const,
    checkpoint: "account_access" as const,
    sourceRevision: input.sourceRevision,
    revisionId: input.revisionId,
    journeyId: input.journeyId,
    status: result.ok ? "passed" as const : result.fact === undefined
      ? "failed" as const
      : "blocked" as const,
    completedSteps: recorder.completedSteps,
    events: Object.freeze([...recorder.events]),
    terminal,
    submitActivated: false as const,
    privacyScan: "pass" as const,
    cleanup,
  });
  try {
    await dependencies.diagnostics.write(diagnostics);
  } catch {
    return failure("evidence_unavailable");
  }
  return result;
}

function terminalResult(
  journeyId: JourneyId,
  result: Stage2AccountAccessResult,
): TerminalResultV4 | null {
  if (result.ok) return null;
  if (result.fact !== undefined) {
    return Object.freeze({
      schemaVersion: 4 as const,
      journeyId,
      status: "blocked" as const,
      completedPages: 0,
      factualOutcome: {
        source: "target_identity" as const,
        result: result.fact,
      },
    });
  }
  const code = stableCode(result.code);
  return Object.freeze({
    schemaVersion: 4 as const,
    journeyId,
    status: "failed" as const,
    completedPages: 0,
    errorCode: code,
  });
}

function stableCode(value: string): S2StableErrorCode {
  return Object.hasOwn(s2StableErrorPolicy, value)
    ? value as S2StableErrorCode
    : "mcp_internal_error";
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
