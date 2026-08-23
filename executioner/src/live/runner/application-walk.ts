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
import type {
  ApplicationWalkAcceptanceV1,
} from "../evidence/application-walk-evidence.ts";

export interface Stage2ApplicationWalkInput {
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
  readonly trace?: (event: Stage2ApplicationWalkTraceEvent) => void;
  readonly cleanup: {
    close(signal: AbortSignal, accepted?: boolean): Promise<boolean>;
    preserve?(signal: AbortSignal): Promise<boolean>;
    release?(signal: AbortSignal): Promise<boolean>;
  };
  readonly evidence: ApplicationWalkAcceptanceWriter;
}

export type Stage2ApplicationWalkTraceEvent =
  | {
      readonly kind: "application_walk_started";
      readonly journeyId: string;
      readonly stopAfter: ApplicationCheckpoint;
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
      readonly submitActivated: false;
    };

export async function runObservedApplicationPageWalk(
  dependencies: Pick<Stage2ApplicationWalkDependencies, "walk" | "laneAcceptances" | "trace">,
  input: ApplicationWalkInput,
  signal: AbortSignal,
  options: ApplicationWalkOptions = {},
): Promise<ApplicationWalkResult> {
  emitTrace(dependencies.trace, {
    kind: "application_walk_started",
    journeyId: input.journeyId,
    stopAfter: input.stopAfter ?? "pre_review",
    submitActivated: false,
  });
  const walk = dependencies.trace === undefined ? dependencies.walk : {
    ...dependencies.walk,
    progress: {
      async record(progress: ApplicationWalkProgress, progressSignal: AbortSignal) {
        const result = await dependencies.walk.progress.record(progress, progressSignal);
        if (result.ok) emitProgress(dependencies, input.journeyId, progress);
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
      submitActivated: false,
    });
    throw error;
  }
}

export type Stage2ApplicationWalkResult =
  | { readonly ok: true; readonly acceptance: ApplicationWalkAcceptanceV1 }
  | {
      readonly ok: false;
      readonly code: S2StableErrorCode;
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
  } catch {
    walk = {
      ok: false,
      error: {
        checkpoint: "resume",
        completedPages: 0,
        failure: {
          code: "failure_context_invalid",
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
  if (!walk.ok) {
    return {
      ok: false,
      code: walk.error.failure.code,
      failure: Object.freeze({ ...walk.error.failure }),
    };
  }

  let acceptance: ApplicationWalkAcceptanceV1;
  try {
    acceptance = Object.freeze({
      schemaVersion: 1,
      evidenceRevision: "s2-application-walk-acceptance-v1",
      checkpoint: walk.value.checkpoint,
      status: "passed",
      sourceRevision: input.sourceRevision,
      revisionId: input.revisionId,
      approvalId: input.approvalId,
      journeyId: input.journeyId,
      targetHandleId: input.targetHandleId,
      completedPages: walk.value.completedPages,
      pageChecks: Object.freeze(walk.value.pageChecks.map((item) =>
        Object.freeze({ ...item })
      )),
      laneAcceptances: dependencies.laneAcceptances.snapshot(
        walk.value.checkpoint,
      ),
      submitActivated: false,
      privacyScan: "pass",
      cleanup: "pass",
    });
    await dependencies.evidence.write(acceptance);
  } catch {
    return { ok: false, code: "evidence_unavailable" };
  }
  return { ok: true, acceptance };
}

function emitProgress(
  dependencies: Pick<Stage2ApplicationWalkDependencies, "laneAcceptances" | "trace">,
  journeyId: string,
  progress: ApplicationWalkProgress,
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
      submitActivated: false,
    });
  } catch {
    // Diagnostics never change application behavior.
  }
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
