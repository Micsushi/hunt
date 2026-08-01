import type { OperationId } from "../../../contracts/index.ts";
import type {
  CheckpointId,
  LiveCheckpointV1,
  LiveCheckpointStore,
  LiveEvidenceSink,
  LiveRevisionId,
  ManifestId,
  PersistentBrowserOpenResult,
  PersistentBrowserReconcileResult,
  PersistentBrowserSession,
  PinnedPageLoopBrowserBinder,
  ProfileLeaseId,
  TargetIdentityV1,
} from "../../../contracts/live/index.ts";
import {
  parseLiveBrowserSession,
  parseLiveCheckpoint,
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

  let loadedCheckpoint: LiveCheckpointV1 | null;
  try {
    loadedCheckpoint = loaded.value === null
      ? null
      : parseLiveCheckpoint(loaded.value);
  } catch {
    return {
      ok: false,
      error: liveCoordinatorError("recovery_checkpoint_invalid"),
    };
  }

  let profileLeaseId = input.freshProfileLeaseId;
  let recoveryCheckpoint: LiveCheckpointV1 | null = null;
  if (loadedCheckpoint !== null) {
    if (validCheckpoint(loadedCheckpoint, input)) {
      profileLeaseId = input.recoveryProfileLeaseId;
      recoveryCheckpoint = loadedCheckpoint;
    } else {
      if (input.freshProfileLeaseId === input.recoveryProfileLeaseId) {
        return { ok: false, error: liveCoordinatorError("recovery_state_ambiguous") };
      }
      const removed = await dependencies.checkpoints.remove(
        { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.remove, checkpointId: loadedCheckpoint.checkpointId },
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
  const openedValue: unknown = opened.value;
  if (!validOpenResult(openedValue)) {
    const reportedSessionId = (
      openedValue as {
        readonly session?: { readonly sessionId?: unknown };
      }
    ).session?.sessionId;
    if (typeof reportedSessionId !== "string") {
      return {
        ok: false,
        error: liveCoordinatorError(
          recoveryCheckpoint === null
            ? "browser_session_invalidated"
            : "recovery_state_ambiguous",
        ),
      };
    }
    return finish(
      dependencies,
      input,
      reportedSessionId as Parameters<PersistentBrowserSession["close"]>[0]["sessionId"],
      {
        ok: false,
        error: liveCoordinatorError(
          recoveryCheckpoint === null
            ? "browser_session_invalidated"
            : "recovery_state_ambiguous",
        ),
      },
    );
  }
  let session;
  try {
    session = parseLiveBrowserSession(openedValue.session);
  } catch {
    return finish(
      dependencies,
      input,
      openedValue.session.sessionId,
      {
        ok: false,
        error: liveCoordinatorError(
          recoveryCheckpoint === null
            ? "browser_session_invalidated"
            : "recovery_state_ambiguous",
        ),
      },
    );
  }
  if (
    session.journeyId !== input.journeyId ||
    session.profileLeaseId !== profileLeaseId ||
    !sameTarget(session.target, input.target) ||
    Date.parse(session.leaseExpiresAt) <= Date.parse(input.now) ||
    (recoveryCheckpoint === null && openedValue.kind !== "opened")
  ) {
    return finish(
      dependencies,
      input,
      session.sessionId,
      {
        ok: false,
        error: liveCoordinatorError(
          recoveryCheckpoint === null
            ? "browser_session_invalidated"
            : "recovery_state_ambiguous",
        ),
      },
    );
  }
  if (
    recoveryCheckpoint !== null &&
    (
      openedValue.kind !== "reattached" ||
      session.journeyId !== recoveryCheckpoint.journeyId ||
      session.sessionId !== recoveryCheckpoint.sessionId ||
      session.profileLeaseId !== recoveryCheckpoint.profileLeaseId ||
      session.leaseExpiresAt !== recoveryCheckpoint.leaseExpiresAt ||
      !sameTarget(session.target, recoveryCheckpoint.target)
    )
  ) {
    return finish(
      dependencies,
      input,
      session.sessionId,
      { ok: false, error: liveCoordinatorError("recovery_state_ambiguous") },
    );
  }

  const reconciled = await dependencies.browser.reconcile(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.reconcile, session, expectedTarget: input.target },
    signal,
  );
  if (!reconciled.ok) return finish(dependencies, input, session.sessionId, reconciled);
  if (!validReconcileResult(reconciled.value)) {
    return finish(
      dependencies,
      input,
      session.sessionId,
      {
        ok: false,
        error: liveCoordinatorError(
          recoveryCheckpoint === null
            ? "browser_session_invalidated"
            : "recovery_state_ambiguous",
        ),
      },
    );
  }
  if (
    reconciled.value.kind === "matched" &&
    !sameSession(reconciled.value.session, session)
  ) {
    return finish(
      dependencies,
      input,
      session.sessionId,
      {
        ok: false,
        error: liveCoordinatorError(
          recoveryCheckpoint === null
            ? "browser_session_invalidated"
            : "recovery_state_ambiguous",
        ),
      },
    );
  }
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
        profileLeaseId: session.profileLeaseId,
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
  const sealed = await dependencies.evidence.seal(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.seal, manifestId: input.manifestId, admittedRecordIds: [] },
    cleanupSignal,
  );
  const removed = await dependencies.checkpoints.remove(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.remove, checkpointId: input.checkpointId },
    cleanupSignal,
  );
  const partials = await dependencies.evidence.cleanupPartials(
    { schemaVersion: 1, journeyId: input.journeyId, operationId: input.operations.cleanup },
    cleanupSignal,
  );
  for (const cleanup of [closed, sealed, removed, partials]) {
    if (!cleanup.ok) return cleanup;
  }
  return result;
}

function validCheckpoint(
  checkpoint: LiveCheckpointV1,
  input: PersistentBrowserSkeletonInput,
): boolean {
  return checkpoint.journeyId === input.journeyId &&
    checkpoint.checkpointId === input.checkpointId &&
    checkpoint.revisionId === input.revisionId &&
    checkpoint.phase === "live_application" &&
    checkpoint.sessionId !== null &&
    checkpoint.profileLeaseId === input.recoveryProfileLeaseId &&
    Date.parse(checkpoint.leaseExpiresAt) > Date.parse(input.now) &&
    sameTarget(checkpoint.target, input.target);
}

function sameSession(
  left: Parameters<PersistentBrowserSession["reconcile"]>[0]["session"],
  right: Parameters<PersistentBrowserSession["reconcile"]>[0]["session"],
): boolean {
  return left.journeyId === right.journeyId &&
    left.sessionId === right.sessionId &&
    left.profileLeaseId === right.profileLeaseId &&
    left.leaseExpiresAt === right.leaseExpiresAt &&
    sameTarget(left.target, right.target);
}

function sameTarget(left: TargetIdentityV1, right: TargetIdentityV1): boolean {
  return left.hostId === right.hostId && left.tenantId === right.tenantId && left.postingId === right.postingId;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function validOpenResult(
  value: unknown,
): value is PersistentBrowserOpenResult {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    exactKeys(value, ["kind", "session"]) &&
    ((value as { readonly kind?: unknown }).kind === "opened" ||
      (value as { readonly kind?: unknown }).kind === "reattached");
}

function validReconcileResult(
  value: unknown,
): value is PersistentBrowserReconcileResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const kind = (value as { readonly kind?: unknown }).kind;
  if (kind === "matched") {
    if (!exactKeys(value, ["kind", "session"])) return false;
    try {
      parseLiveBrowserSession(
        (value as { readonly session: unknown }).session,
      );
      return true;
    } catch {
      return false;
    }
  }
  if (kind === "target_mismatch") {
    return exactKeys(value, ["kind", "dimension"]) &&
      ["host", "tenant", "posting"].includes(
        (value as { readonly dimension?: string }).dimension ?? "",
      );
  }
  if (kind === "target_ambiguous") return exactKeys(value, ["kind"]);
  return kind === "posting_unavailable" &&
    exactKeys(value, ["kind", "reason"]) &&
    ["not_found", "closed", "removed", "unavailable"].includes(
      (value as { readonly reason?: string }).reason ?? "",
    );
}
