import type { OperationId } from "../../../contracts/index.ts";
import type {
  CheckpointId,
  LiveCheckpointV1,
  LiveCheckpointStore,
  LiveEvidenceSink,
  LiveRevisionId,
  ManifestId,
  PersistentBrowserSession,
  PinnedPageLoopBrowserBinder,
  ProfileLeaseId,
  TargetIdentityV1,
} from "../../../contracts/live/index.ts";
import {
  runPageLoop,
  type PageLoopDependencies,
  type PageLoopInput,
  type PageLoopResult,
} from "../loop/index.ts";
import { liveCoordinatorError, type LiveBlocked, type LiveCoordinatorResult } from "./types.ts";

export interface PersistentBrowserSkeletonDependencies {
  readonly browser: PersistentBrowserSession;
  readonly binder: PinnedPageLoopBrowserBinder;
  readonly checkpoints: LiveCheckpointStore;
  readonly evidence: LiveEvidenceSink;
  readonly pageLoop: Omit<PageLoopDependencies, "browser">;
}

export interface PersistentBrowserSkeletonInput {
  readonly schemaVersion: 1;
  readonly journeyId: PageLoopInput["journeyId"];
  readonly target: TargetIdentityV1;
  readonly recoveryProfileLeaseId: ProfileLeaseId;
  readonly freshProfileLeaseId: ProfileLeaseId;
  readonly revisionId: LiveRevisionId;
  readonly checkpointId: CheckpointId;
  readonly manifestId: ManifestId;
  readonly leaseExpiresAt: string;
  readonly now: string;
  readonly operations: {
    readonly open: OperationId;
    readonly reconcile: OperationId;
    readonly bind: OperationId;
    readonly save: OperationId;
    readonly close: OperationId;
    readonly seal: OperationId;
    readonly remove: OperationId;
    readonly cleanup: OperationId;
  };
  readonly pageLoopInput: PageLoopInput;
}

type PersistentBrowserSkeletonValue =
  | Extract<PageLoopResult, { readonly ok: true }>["value"]
  | LiveBlocked;

export async function runPersistentBrowserSkeleton(
  dependencies: PersistentBrowserSkeletonDependencies,
  input: PersistentBrowserSkeletonInput,
  signal: AbortSignal,
): Promise<LiveCoordinatorResult<PersistentBrowserSkeletonValue>> {
  const initialCleanup = await dependencies.evidence.cleanupPartials(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.cleanup },
    signal,
  );
  if (!initialCleanup.ok) return initialCleanup;

  const loaded = await dependencies.checkpoints.load(
    { schemaVersion: 1, journeyId: input.journeyId, expectedRevisionId: input.revisionId },
    signal,
  );
  if (!loaded.ok) return loaded;

  let profileLeaseId = input.freshProfileLeaseId;
  if (loaded.value !== null) {
    if (validCheckpoint(loaded.value, input)) {
      profileLeaseId = input.recoveryProfileLeaseId;
    } else {
      if (input.freshProfileLeaseId === input.recoveryProfileLeaseId) {
        return { ok: false, error: liveCoordinatorError("recovery_state_ambiguous") };
      }
      const removed = await dependencies.checkpoints.remove(
        { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.remove, checkpointId: loaded.value.checkpointId },
        signal,
      );
      if (!removed.ok) return removed;
    }
  }

  const opened = await dependencies.browser.open(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.open, profileLeaseId, target: input.target },
    signal,
  );
  if (!opened.ok) return opened;
  const session = opened.value.session;

  const reconciled = await dependencies.browser.reconcile(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.reconcile, session, expectedTarget: input.target },
    signal,
  );
  if (!reconciled.ok) return finish(dependencies, input, session.sessionId, reconciled);
  if (reconciled.value.kind !== "matched") {
    const factualOutcome = reconciled.value.kind === "target_mismatch"
      ? { source: "target_identity" as const, result: { kind: "target_mismatch" as const, dimension: reconciled.value.dimension } }
      : reconciled.value.kind === "target_ambiguous"
      ? { source: "target_identity" as const, result: { kind: "target_ambiguous" as const } }
      : { source: "target_identity" as const, result: { kind: "posting_unavailable" as const, reason: reconciled.value.reason } };
    return finish(dependencies, input, session.sessionId, { ok: true, value: { kind: "blocked", factualOutcome } });
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
        phase: "live_application",
        target: input.target,
        sessionId: session.sessionId,
        verificationHandle: null,
        leaseExpiresAt: input.leaseExpiresAt,
      },
    },
    signal,
  );
  if (!saved.ok) return finish(dependencies, input, session.sessionId, saved);

  const bound = await dependencies.binder.bind(
    {
      schemaVersion: 1,
      journeyId: input.journeyId,
      operationId: input.operations.bind,
      session,
      expectedSessionId: session.sessionId,
      expectedTarget: input.target,
    },
    signal,
  );
  if (!bound.ok) return finish(dependencies, input, session.sessionId, bound);

  const pageResult = await runPageLoop(
    { ...dependencies.pageLoop, browser: bound.value },
    input.pageLoopInput,
    signal,
  );
  const projected = pageResult.ok
    ? pageResult
    : { ok: false as const, error: pageResult.error.error };
  return finish(dependencies, input, session.sessionId, projected);
}

async function finish<T>(
  dependencies: PersistentBrowserSkeletonDependencies,
  input: PersistentBrowserSkeletonInput,
  sessionId: Parameters<PersistentBrowserSession["close"]>[0]["sessionId"],
  result: LiveCoordinatorResult<T>,
): Promise<LiveCoordinatorResult<T>> {
  const cleanupSignal = new AbortController().signal;
  const closed = await dependencies.browser.close(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.close, sessionId },
    cleanupSignal,
  );
  if (!closed.ok) return closed;
  const sealed = await dependencies.evidence.seal(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.seal, manifestId: input.manifestId, admittedRecordIds: [] },
    cleanupSignal,
  );
  if (!sealed.ok) return sealed;
  const removed = await dependencies.checkpoints.remove(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.remove, checkpointId: input.checkpointId },
    cleanupSignal,
  );
  if (!removed.ok) return removed;
  const partials = await dependencies.evidence.cleanupPartials(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.cleanup },
    cleanupSignal,
  );
  return partials.ok ? result : partials;
}

function validCheckpoint(
  checkpoint: LiveCheckpointV1,
  input: PersistentBrowserSkeletonInput,
): boolean {
  return checkpoint.journeyId === input.journeyId &&
    checkpoint.revisionId === input.revisionId &&
    checkpoint.sessionId !== null &&
    Date.parse(checkpoint.leaseExpiresAt) > Date.parse(input.now) &&
    sameTarget(checkpoint.target, input.target);
}

function sameTarget(left: TargetIdentityV1, right: TargetIdentityV1): boolean {
  return left.hostId === right.hostId && left.tenantId === right.tenantId && left.postingId === right.postingId;
}
