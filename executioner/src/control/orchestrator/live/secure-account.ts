import type {
  ActiveAccountSecretHandle,
  AvailableVerificationArtifact,
  CheckpointId,
  CredentialMutationAdapter,
  LiveCheckpointStore,
  LiveRevisionId,
  LiveSessionId,
  MailboxPollRequest,
  MailboxPollResultV1,
  MailboxProvider,
  PrivilegedVerificationNavigator,
  TargetIdentityV1,
  VerificationArtifact,
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
  readonly sessionId: LiveSessionId;
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
  | LiveBlocked;

export async function runSecureAccountSkeleton(
  dependencies: SecureAccountSkeletonDependencies,
  input: SecureAccountSkeletonInput,
  signal: AbortSignal,
): Promise<LiveCoordinatorResult<SecureAccountSkeletonValue>> {
  if (input.mode === "restart") {
    const loaded = await dependencies.checkpoints.load(
      { schemaVersion: 1, journeyId: input.journeyId, expectedRevisionId: input.revisionId },
      signal,
    );
    if (!loaded.ok) return loaded;
    if (loaded.value === null || loaded.value.sessionId !== input.sessionId || !sameTarget(loaded.value.target, input.target)) {
      return { ok: false, error: liveCoordinatorError("recovery_state_ambiguous") };
    }
  } else {
    const mutation = await dependencies.credentialMutation.mutate(
      {
        schemaVersion: 1,
        journeyId: input.journeyId,
        operationId: input.operations.mutate,
        sessionId: input.sessionId,
        mode: "create_account",
        credential: input.credential,
        fields: ["email", "password"],
      },
      signal,
    );
    if (!mutation.ok) return mutation;
    if (mutation.value.kind !== "verification_required" && mutation.value.kind !== "application_ready") {
      return { ok: false, error: liveCoordinatorError("credential_mutation_denied") };
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
        sessionId: input.sessionId,
        verificationHandle: null,
        leaseExpiresAt: input.leaseExpiresAt,
      },
    },
    signal,
  );
  if (!saved.ok) return saved;

  const mailbox = await dependencies.mailbox.poll(input.mailboxRequest, signal);
  if (!mailbox.ok) return mailbox;
  const mailboxStop = mailboxFact(mailbox.value, input.now);
  if (mailboxStop !== null) return blockAndRemove(dependencies, input, mailboxStop);
  const handleId = mailbox.value.verificationHandle;
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
  if (inspected.value.state === "expired") return blockAndRemove(dependencies, input, "mailbox_expired");
  if (inspected.value.state !== "available") return blockAndRemove(dependencies, input, "mailbox_consumed");
  const availableArtifact: AvailableVerificationArtifact = {
    ...inspected.value,
    state: "available",
  };

  const navigated = await dependencies.navigator.navigate(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.navigate, sessionId: input.sessionId, artifact: availableArtifact },
    signal,
  );
  if (!navigated.ok) return navigated;
  if (navigated.value.kind === "target_unavailable") {
    await removeCheckpoint(dependencies, input);
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
