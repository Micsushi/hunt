import type {
  ApplicationLaneAcceptanceCollector,
} from "../../ats/workday/application/lane-composition.ts";
import {
  runApplicationPageWalk,
  type ApplicationCheckpoint,
  type ApplicationWalkDependencies,
  type ApplicationWalkFailurePacket,
  type ApplicationWalkInput,
  type ApplicationWalkOptions,
  type ApplicationWalkProgress,
  type ApplicationWalkResult,
} from "../../ats/workday/application/page-walk.ts";
import type { JourneyId } from "../../contracts/index.ts";
import type { S2StableErrorCode } from "../../contracts/s2-common-wire.ts";
import { stage2CausalCode } from "../../contracts/s2-causal-error.ts";
import type { ApplicationExecutionPolicy } from "../../contracts/application-execution-policy.ts";
import type {
  ApplicationWalkAcceptanceV1,
} from "../evidence/application-walk-evidence.ts";
import type { AccountVerifiedFact } from "./account-verified.ts";
import type { ApplicationPhaseTimingLedger } from "./application-phase-timing.ts";
import {
  ApplicationWalkTimingCollector,
  elapsedApplicationWalkTiming as elapsed,
  type CompletedPageTiming,
  type Stage2ApplicationWalkTimingClock,
} from "./application-walk-timing.ts";

export interface Stage2ApplicationWalkInput {
  readonly executionPolicy: ApplicationExecutionPolicy;
  readonly sourceRevision: string;
  readonly configSha256: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: JourneyId;
  readonly targetHandleId: string;
  readonly stopAfter: ApplicationCheckpoint;
}

export interface ApplicationWalkAcceptanceWriter {
  write(acceptance: ApplicationWalkAcceptanceV1): Promise<void>;
}

export interface Stage2ApplicationWalkDependencies {
  readonly walk: ApplicationWalkDependencies;
  readonly laneAcceptances: Pick<ApplicationLaneAcceptanceCollector, "snapshot">;
  readonly phaseTiming?: ApplicationPhaseTimingLedger;
  readonly trace?: (event: Stage2ApplicationWalkTraceEvent) => void;
  readonly cleanup: {
    close(signal: AbortSignal, accepted?: boolean): Promise<boolean>;
    preserve?(signal: AbortSignal): Promise<boolean>;
    release?(signal: AbortSignal): Promise<boolean>;
    retentionExpiresAt?(): string | undefined;
  };
  readonly evidence: ApplicationWalkAcceptanceWriter;
}

export function scheduleStage2ApplicationRetentionExpiry(
  cleanup: Stage2ApplicationWalkDependencies["cleanup"],
): void {
  const release = cleanup.release;
  const expiresAt = cleanup.retentionExpiresAt?.();
  if (release === undefined || expiresAt === undefined) return;
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return;
  const delay = Math.max(0, deadline - Date.now());
  const timer = setTimeout(() => {
    if (cleanup.retentionExpiresAt?.() === undefined) return;
    void (async () => {
      let released = false;
      try {
        released = await release(new AbortController().signal);
      } catch {
        released = false;
      }
      if (released) return;
      try {
        await cleanup.close(new AbortController().signal);
      } catch {
        // The original application-walk result remains the causal result.
      }
    })();
  }, Math.min(delay, 2_147_483_647));
  timer.unref?.();
}

export type Stage2ApplicationWalkTraceEvent =
  | {
      readonly kind: "application_walk_started";
      readonly journeyId: string;
      readonly stopAfter: ApplicationCheckpoint;
      readonly startedAt: string;
      readonly monotonicClock: "performance_now";
      readonly submitActivated: false;
    }
  | {
      readonly kind: "application_walk_progress";
      readonly journeyId: string;
      readonly checkpoint: ApplicationCheckpoint;
      readonly browserPage: string;
      readonly browserLanes: readonly string[];
      readonly completedPages: number;
      readonly requiredFields: number;
      readonly verifiedFields: number;
      readonly duplicateRows: number;
      readonly questionTypes: readonly string[];
      readonly answerTypes: readonly string[];
      readonly uiBehaviors: readonly string[];
      readonly provenances: readonly string[];
      readonly pageReadyAt: string;
      readonly pageFillCompletedAt: string;
      readonly pageReadinessDurationMs: number;
      readonly navigationWaitDurationMs: number;
      readonly activeFillDurationMs: number;
      readonly independentMonitorDurationMs: number;
      readonly committedReadbackDurationMs: number;
      readonly reconciliationDurationMs: number;
      readonly activeFillSloMs: 60_000;
      readonly activeFillWithinSlo: boolean;
      readonly monotonicClock: "performance_now";
      readonly submitActivated: false;
    }
  | {
      readonly kind: "application_observer_required_field_projection";
      readonly page: string;
      readonly requiredFields: number;
      readonly verifiedFields: number;
      readonly unverifiedFieldIds: readonly string[];
      readonly unverifiedFieldReasons: readonly string[];
      readonly submitActivated: false;
    }
  | {
      readonly kind: "application_walk_terminal";
      readonly journeyId: string;
      readonly status: "passed" | "blocked" | "failed";
      readonly checkpoint: string;
      readonly completedPages: number;
      readonly failure: ApplicationWalkFailurePacket | null;
      readonly code?: string;
      readonly classifier?: string;
      readonly primitive?: string;
      readonly unknownLayer?: string;
      readonly applicationWalkDurationMs: number;
      readonly monotonicClock: "performance_now";
      readonly submitActivated: false;
    };

export interface Stage2ObservedApplicationWalkOptions extends ApplicationWalkOptions {
  readonly timingClock?: Stage2ApplicationWalkTimingClock;
}

export async function runObservedApplicationPageWalk(
  dependencies: Pick<
    Stage2ApplicationWalkDependencies,
    "walk" | "laneAcceptances" | "phaseTiming" | "trace"
  >,
  input: ApplicationWalkInput,
  signal: AbortSignal,
  options: Stage2ObservedApplicationWalkOptions = {},
): Promise<ApplicationWalkResult> {
  const clock = options.timingClock ?? Object.freeze({
    monotonicNow: () => performance.now(),
    wallNow: () => new Date().toISOString(),
  });
  const totalStarted = clock.monotonicNow();
  const startedAt = clock.wallNow();
  emitTrace(dependencies.trace, {
    kind: "application_walk_started",
    journeyId: input.journeyId,
    stopAfter: input.stopAfter ?? "pre_review",
    startedAt,
    monotonicClock: "performance_now",
    submitActivated: false,
  });
  const timing = new ApplicationWalkTimingCollector(clock, dependencies.phaseTiming);
  const walk = dependencies.trace === undefined ? dependencies.walk : {
    ...dependencies.walk,
    observer: {
      async observe(observeSignal: AbortSignal) {
        const began = clock.monotonicNow();
        const result = await dependencies.walk.observer.observe(observeSignal);
        timing.observed(result, clock.wallNow(), elapsed(clock, began));
        if (result.ok) {
          const fields = result.value.requiredFields as readonly ProjectedRequiredField[];
          const unverified = fields.filter(({ verification }) => verification !== "verified");
          emitTrace(dependencies.trace, {
            kind: "application_observer_required_field_projection",
            page: result.value.page,
            requiredFields: fields.length,
            verifiedFields: fields.length - unverified.length,
            unverifiedFieldIds: unique(unverified.map(({ fieldId }) => fieldId)),
            unverifiedFieldReasons: unique(unverified.map(projectionReason)),
            submitActivated: false,
          });
        }
        return result;
      },
    },
    handlers: {
      resume: timing.handler("resume", dependencies.walk.handlers.resume),
      profile: timing.handler("profile", dependencies.walk.handlers.profile),
      questionnaire: timing.handler("questionnaire", dependencies.walk.handlers.questionnaire),
    },
    navigation: {
      async next(
        request: Parameters<ApplicationWalkDependencies["navigation"]["next"]>[0],
        navigationSignal: AbortSignal,
      ) {
        const began = clock.monotonicNow();
        const result = await dependencies.walk.navigation.next(request, navigationSignal);
        timing.navigated(elapsed(clock, began));
        return result;
      },
    },
    progress: {
      async record(progress: ApplicationWalkProgress, progressSignal: AbortSignal) {
        const result = await dependencies.walk.progress.record(progress, progressSignal);
        if (result.ok && progress.checkpoint !== "pre_review") {
          emitProgress(
            dependencies,
            input.journeyId,
            progress,
            timing.complete(progress.checkpoint),
          );
        }
        return result;
      },
    },
  };
  try {
    const result = await runApplicationPageWalk(walk, input, signal, options);
    emitTrace(dependencies.trace, result.ok ? {
      kind: "application_walk_terminal",
      journeyId: input.journeyId,
      status: "passed",
      checkpoint: result.value.checkpoint,
      completedPages: result.value.completedPages,
      failure: null,
      applicationWalkDurationMs: elapsed(clock, totalStarted),
      monotonicClock: "performance_now",
      submitActivated: false,
    } : {
      kind: "application_walk_terminal",
      journeyId: input.journeyId,
      status: "blocked",
      checkpoint: result.error.checkpoint,
      completedPages: result.error.completedPages,
      failure: result.error.failure,
      code: result.error.failure.code,
      classifier: result.error.failure.classifier,
      primitive: result.error.failure.primitive,
      unknownLayer: result.error.failure.unknownLayer,
      applicationWalkDurationMs: elapsed(clock, totalStarted),
      monotonicClock: "performance_now",
      submitActivated: false,
    });
    return result;
  } catch (error) {
    emitTrace(dependencies.trace, {
      kind: "application_walk_terminal",
      journeyId: input.journeyId,
      status: "failed",
      checkpoint: "unknown",
      completedPages: 0,
      failure: null,
      applicationWalkDurationMs: elapsed(clock, totalStarted),
      monotonicClock: "performance_now",
      submitActivated: false,
    });
    throw error;
  }
}

export type Stage2ApplicationWalkResult =
  | { readonly ok: true; readonly acceptance: ApplicationWalkAcceptanceV1 }
  | {
      readonly ok: false;
      readonly code: S2StableErrorCode | AccountVerifiedFact["kind"];
      readonly fact?: AccountVerifiedFact;
      readonly failure?: ApplicationWalkFailurePacket;
      readonly cleanupErrorCode?: "browser_profile_cleanup_failed";
    };

export async function runStage2ApplicationWalk(
  input: Stage2ApplicationWalkInput,
  dependencies: Stage2ApplicationWalkDependencies,
  signal: AbortSignal,
): Promise<Stage2ApplicationWalkResult> {
  let walk: Awaited<ReturnType<typeof runApplicationPageWalk>>;
  try {
    walk = await runObservedApplicationPageWalk(
      dependencies,
      { journeyId: input.journeyId, stopAfter: input.stopAfter },
      signal,
    );
  } catch (error) {
    const code = stage2CausalCode(error, "failure_context_invalid");
    walk = {
      ok: false,
      error: {
        checkpoint: "resume",
        completedPages: 0,
        failure: {
          code,
          retryable: false,
          owner: "browser_truth",
          classifier: "workday_page",
          primitive: "page_observation",
          unknownLayer: "none",
          page: "resume",
          attempt: 1,
        },
        submitActivated: false,
        privacyScan: "pass",
      },
    };
  }

  let cleaned = false;
  try {
    cleaned = await dependencies.cleanup.preserve?.(new AbortController().signal) ?? false;
  } catch {
    cleaned = false;
  }
  if (!cleaned) {
    try {
      cleaned = await dependencies.cleanup.close(new AbortController().signal);
    } catch {
      cleaned = false;
    }
  }
  if (!cleaned) {
    if (!walk.ok) {
      return {
        ok: false,
        code: walk.error.failure.code,
        failure: Object.freeze({ ...walk.error.failure }),
        cleanupErrorCode: "browser_profile_cleanup_failed",
      };
    }
    return { ok: false, code: "browser_profile_cleanup_failed" };
  }
  scheduleStage2ApplicationRetentionExpiry(dependencies.cleanup);
  if (!walk.ok) {
    return {
      ok: false,
      code: walk.error.failure.code,
      failure: Object.freeze({ ...walk.error.failure }),
    };
  }

  let acceptance: ApplicationWalkAcceptanceV1;
  try {
    const laneAcceptances = dependencies.laneAcceptances.snapshot(walk.value.checkpoint);
    acceptance = Object.freeze({
      schemaVersion: 2,
      evidenceRevision: "s2-application-walk-acceptance-v2",
      checkpoint: walk.value.checkpoint,
      status: "passed",
      ...input.executionPolicy,
      sourceRevision: input.sourceRevision,
      revisionId: input.revisionId,
      approvalId: input.approvalId,
      journeyId: input.journeyId,
      targetHandleId: input.targetHandleId,
      completedPages: walk.value.completedPages,
      pageChecks: Object.freeze(walk.value.pageChecks.map((item) =>
        Object.freeze({ ...item })
      )),
      laneAcceptances,
      submitActivated: false,
      privacyScan: "pass",
      cleanup: "pass",
    });
    await dependencies.evidence.write(acceptance);
  } catch (error) {
    return {
      ok: false,
      code: stage2CausalCode(error, "evidence_unavailable"),
    };
  }
  return { ok: true, acceptance };
}

function emitProgress(
  dependencies: Pick<Stage2ApplicationWalkDependencies, "laneAcceptances" | "trace">,
  journeyId: string,
  progress: ApplicationWalkProgress,
  timing: CompletedPageTiming,
): void {
  try {
    const lanes = dependencies.laneAcceptances.snapshot(progress.checkpoint);
    const profile = lanes.flatMap((lane) =>
      lane.checkpoint === "profile_verified" ? lane.verifiedFields : []
    );
    const questionnaire = lanes.flatMap((lane) =>
      lane.checkpoint === "questionnaire_verified" ? lane.answers : []
    );
    const includesResume = lanes.some(({ checkpoint }) => checkpoint === "resume_verified");
    const checks = progress.pageChecks;
    emitTrace(dependencies.trace, {
      kind: "application_walk_progress",
      journeyId,
      checkpoint: progress.checkpoint,
      browserPage: progress.browserPage,
      browserLanes: Object.freeze([...progress.browserLanes]),
      completedPages: progress.completedPages,
      requiredFields: checks.reduce((sum, check) => sum + check.requiredFields, 0),
      verifiedFields: checks.reduce((sum, check) => sum + check.verifiedFields, 0),
      duplicateRows: checks.reduce((sum, check) => sum + check.duplicateRows, 0),
      questionTypes: unique([
        ...(includesResume ? ["attachment"] : []),
        ...profile.map(({ questionType }) => questionType),
        ...questionnaire.map(({ questionId }) => String(questionId)),
      ]),
      answerTypes: unique([
        ...(includesResume ? ["file"] : []),
        ...profile.map(({ answerType }) => answerType),
      ]),
      uiBehaviors: unique([
        ...(includesResume ? ["file_upload"] : []),
        ...profile.map(({ uiBehavior }) => uiBehavior),
      ]),
      provenances: unique([
        ...(includesResume ? ["resume_verified"] : []),
        ...profile.map(({ provenance }) => provenance),
        ...questionnaire.map(({ provenance }) => provenance),
      ]),
      ...timing,
      submitActivated: false,
    });
  } catch {
    // Diagnostics never change application behavior.
  }
}

interface ProjectedRequiredField {
  readonly fieldId: string;
  readonly verification: "verified" | "unverified";
  readonly uiState?: {
    readonly blockedBy?: string | null;
    readonly type?: string;
  };
}

function projectionReason(field: ProjectedRequiredField): string {
  const type = field.uiState?.type ?? "unknown_type";
  const blockedBy = field.uiState?.blockedBy ?? "semantic_verification";
  return `${field.fieldId}.${type}.${blockedBy}`;
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function emitTrace(
  trace: Stage2ApplicationWalkDependencies["trace"],
  event: Stage2ApplicationWalkTraceEvent,
): void {
  try { trace?.(Object.freeze(event)); } catch { /* diagnostics never change application behavior */ }
}
