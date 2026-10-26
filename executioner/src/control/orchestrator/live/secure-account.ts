import type {
  ActiveAccountSecretHandle,
  AvailableVerificationArtifact,
  CheckpointId,
  CredentialMutationAdapter,
  CredentialMutationResult,
  LiveBrowserSessionV1,
  LiveCheckpointStore,
  LiveRevisionId,
  MailboxPollRequest,
  MailboxPollResultV1,
  MailboxProvider,
  PrivilegedVerificationNavigator,
  TargetIdentityV1,
  VerificationArtifact,
} from "../../../contracts/live/index.ts";
import {
  parseCredentialMutationResult,
  parseLiveCheckpoint,
  parseMailboxPollResult,
  parseVerificationArtifactMetadata,
} from "../../../contracts/live/index.ts";
import type { JourneyId, OperationId } from "../../../contracts/types.ts";
import { liveCoordinatorError, type LiveBlocked, type LiveCoordinatorResult } from "./types.ts";

export interface SecureAccountSkeletonDependencies {
  readonly credentialMutation: CredentialMutationAdapter;
  readonly mailbox: MailboxProvider;
  readonly artifacts: VerificationArtifact;
  readonly navigator: PrivilegedVerificationNavigator;
  readonly checkpoints: LiveCheckpointStore;
}

export interface SecureAccountSkeletonInput {
  readonly schemaVersion: 1;
  readonly mode: "fresh" | "restart";
  readonly journeyId: JourneyId;
  readonly session: LiveBrowserSessionV1;
  readonly target: TargetIdentityV1;
  readonly credential: ActiveAccountSecretHandle;
  readonly mailboxRequest: MailboxPollRequest;
  readonly revisionId: LiveRevisionId;
  readonly checkpointId: CheckpointId;
  readonly leaseExpiresAt: string;
  readonly now: string;
  readonly operations: {
    readonly mutate: OperationId;
    readonly save: OperationId;
    readonly navigate: OperationId;
    readonly invalidate: OperationId;
    readonly remove: OperationId;
  };
}

export type SecureAccountSkeletonValue =
  | { readonly kind: "verification_complete" }
  | {
      readonly kind: "account_state";
      readonly result: Exclude<
        CredentialMutationResult,
        { readonly kind: "verification_required" | "manual_intervention" }
      >;
    }
  | LiveBlocked;

export async function runSecureAccountSkeleton(
  dependencies: SecureAccountSkeletonDependencies,
  input: SecureAccountSkeletonInput,
  signal: AbortSignal,
): Promise<LiveCoordinatorResult<SecureAccountSkeletonValue>> {
  if (input.credential.journeyId !== input.journeyId) {
    return { ok: false, error: liveCoordinatorError("secret_handle_mismatched") };
  }
  if (
    input.session.journeyId !== input.journeyId ||
    !sameTarget(input.session.target, input.target) ||
    Date.parse(input.session.leaseExpiresAt) <= Date.parse(input.now)
  ) {
    return {
      ok: false,
      error: liveCoordinatorError(
        input.mode === "restart"
          ? "recovery_state_ambiguous"
          : "browser_session_invalidated",
      ),
    };
  }
  if (
    input.mailboxRequest.journeyId !== input.journeyId ||
    !sameTarget(input.mailboxRequest.target, input.target) ||
    Date.parse(input.mailboxRequest.notBefore) >=
      Date.parse(input.mailboxRequest.notAfter)
  ) {
    return { ok: false, error: liveCoordinatorError("mailbox_query_invalid") };
  }
  if (input.mode === "restart") {
    const loaded = await dependencies.checkpoints.load(
      { schemaVersion: 1, journeyId: input.journeyId, expectedRevisionId: input.revisionId },
      signal,
    );
    if (!loaded.ok) return loaded;
    let checkpoint;
    try {
      checkpoint = loaded.value === null
        ? null
        : parseLiveCheckpoint(loaded.value);
    } catch {
      return {
        ok: false,
        error: liveCoordinatorError("recovery_checkpoint_invalid"),
      };
    }
    if (checkpoint === null || !validRestartCheckpoint(checkpoint, input)) {
      return { ok: false, error: liveCoordinatorError("recovery_state_ambiguous") };
    }
  } else {
    const mutation = await dependencies.credentialMutation.mutate(
      {
        schemaVersion: 1,
        journeyId: input.journeyId,
        operationId: input.operations.mutate,
        sessionId: input.session.sessionId,
        target: input.target,
        now: input.now,
        mode: "create_account",
        credential: input.credential,
        fields: ["email", "password"],
      },
      signal,
    );
    if (!mutation.ok) return mutation;
    let mutationValue;
    try {
      mutationValue = parseCredentialMutationResult(mutation.value);
    } catch {
      return {
        ok: false,
        error: liveCoordinatorError("credential_mutation_denied"),
      };
    }
    if (mutationValue.kind === "manual_intervention") {
      return {
        ok: true,
        value: {
          kind: "blocked",
          factualOutcome: {
            source: "account_access",
            result: {
              kind: "manual_intervention",
              reason: mutationValue.reason,
            },
          },
        },
      };
    }
    if (mutationValue.kind !== "verification_required") {
      return {
        ok: true,
        value: { kind: "account_state", result: mutationValue },
      };
    }
  }

  const saved = await dependencies.checkpoints.save(
    {
      schemaVersion: 1,
      journeyId: input.journeyId,
      operationId: input.operations.save,
      checkpoint: {
        schemaVersion: 1,
        journeyId: input.journeyId,
        checkpointId: input.checkpointId,
        revisionId: input.revisionId,
        phase: "mailbox_verification",
        target: input.target,
        sessionId: input.session.sessionId,
        profileLeaseId: input.session.profileLeaseId,
        verificationHandle: null,
        leaseExpiresAt: input.leaseExpiresAt,
      },
    },
    signal,
  );
  if (!saved.ok) return saved;

  const mailbox = await dependencies.mailbox.poll(input.mailboxRequest, signal);
  if (!mailbox.ok) return mailbox;
  let mailboxValue;
  try {
    mailboxValue = parseMailboxPollResult(mailbox.value);
  } catch {
    return { ok: false, error: liveCoordinatorError("mailbox_query_invalid") };
  }
  const mailboxStop = mailboxFact(mailboxValue, input.now);
  if (mailboxStop !== null) return blockAndRemove(dependencies, input, mailboxStop);
  const handleId = mailboxValue.verificationHandle;
  if (handleId === null) return blockAndRemove(dependencies, input, "mailbox_consumed");

  const inspected = await dependencies.artifacts.inspect(
    {
      schemaVersion: 1,
      journeyId: input.journeyId,
      handleId,
      expectedRecipientBindingId: input.mailboxRequest.recipientBindingId,
      expectedTarget: input.target,
    },
    signal,
  );
  if (!inspected.ok) return inspected;
  let artifact;
  try {
    artifact = parseVerificationArtifactMetadata(inspected.value);
  } catch {
    return { ok: false, error: liveCoordinatorError("mailbox_query_invalid") };
  }
  if (
    artifact.handleId !== handleId ||
    artifact.journeyId !== input.journeyId ||
    artifact.recipientBindingId !== input.mailboxRequest.recipientBindingId
  ) {
    return {
      ok: false,
      error: liveCoordinatorError("verification_artifact_replayed"),
    };
  }
  if (!sameTarget(artifact.target, input.target)) {
    return { ok: false, error: liveCoordinatorError("mailbox_query_invalid") };
  }
  if (artifact.state === "expired") return blockAndRemove(dependencies, input, "mailbox_expired");
  if (artifact.state !== "available") return blockAndRemove(dependencies, input, "mailbox_consumed");
  const availableArtifact: AvailableVerificationArtifact = {
    ...artifact,
    state: "available",
  };

  const navigated = await dependencies.navigator.navigate(
    {
      schemaVersion: 1,
      journeyId: input.journeyId,
      operationId: input.operations.navigate,
      sessionId: input.session.sessionId,
      expectedRecipientBindingId: input.mailboxRequest.recipientBindingId,
      expectedTarget: input.target,
      now: input.now,
      artifact: availableArtifact,
    },
    signal,
  );
  if (!navigated.ok) return navigated;
  if (!validNavigationResult(navigated.value)) {
    return {
      ok: false,
      error: liveCoordinatorError("verification_navigation_denied"),
    };
  }
  if (navigated.value.kind === "target_unavailable") {
    const removed = await removeCheckpoint(dependencies, input);
    if (!removed.ok) return removed;
    return { ok: true, value: { kind: "blocked", factualOutcome: { source: "verification_navigation", result: { kind: "verification_target_unavailable" } } } };
  }

  const invalidated = await dependencies.artifacts.invalidate(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.invalidate, handleId },
    signal,
  );
  if (!invalidated.ok) return invalidated;
  const removed = await removeCheckpoint(dependencies, input);
  return removed.ok ? { ok: true, value: { kind: "verification_complete" } } : removed;
}

function mailboxFact(
  value: MailboxPollResultV1,
  now: string,
): "mailbox_none" | "mailbox_ambiguous" | "mailbox_expired" | "mailbox_consumed" | null {
  if (value.candidateCount === 0) return "mailbox_none";
  if (value.candidateCount > 1) return "mailbox_ambiguous";
  if (value.expiresAt !== null && Date.parse(value.expiresAt) <= Date.parse(now)) return "mailbox_expired";
  return value.verificationHandle === null ? "mailbox_consumed" : null;
}

async function blockAndRemove(
  dependencies: SecureAccountSkeletonDependencies,
  input: SecureAccountSkeletonInput,
  kind: "mailbox_none" | "mailbox_ambiguous" | "mailbox_expired" | "mailbox_consumed",
): Promise<LiveCoordinatorResult<SecureAccountSkeletonValue>> {
  const removed = await removeCheckpoint(dependencies, input);
  return removed.ok
    ? { ok: true, value: { kind: "blocked", factualOutcome: { source: "mailbox_verification", result: { kind } } } }
    : removed;
}

function removeCheckpoint(dependencies: SecureAccountSkeletonDependencies, input: SecureAccountSkeletonInput) {
  return dependencies.checkpoints.remove(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.remove, checkpointId: input.checkpointId },
    new AbortController().signal,
  );
}

function sameTarget(left: TargetIdentityV1, right: TargetIdentityV1): boolean {
  return left.hostId === right.hostId && left.tenantId === right.tenantId && left.postingId === right.postingId;
}

function validNavigationResult(
  value: unknown,
): value is { readonly kind: "navigated" | "target_unavailable" } {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    ((value as { readonly kind?: unknown }).kind === "navigated" ||
      (value as { readonly kind?: unknown }).kind === "target_unavailable");
}

function validRestartCheckpoint(
  checkpoint: Parameters<LiveCheckpointStore["save"]>[0]["checkpoint"],
  input: SecureAccountSkeletonInput,
): boolean {
  return checkpoint.journeyId === input.journeyId &&
    checkpoint.checkpointId === input.checkpointId &&
    checkpoint.revisionId === input.revisionId &&
    checkpoint.phase === "mailbox_verification" &&
    checkpoint.sessionId === input.session.sessionId &&
    checkpoint.profileLeaseId === input.session.profileLeaseId &&
    checkpoint.leaseExpiresAt === input.session.leaseExpiresAt &&
    Date.parse(checkpoint.leaseExpiresAt) > Date.parse(input.now) &&
    sameTarget(checkpoint.target, input.target);
}
