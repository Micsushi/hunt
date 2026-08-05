import type {
  ApplicationLaneAcceptanceCollector,
} from "../../ats/workday/application/lane-composition.ts";
import {
  runApplicationPageWalk,
  type ApplicationCheckpoint,
  type ApplicationWalkDependencies,
  type ApplicationWalkFailurePacket,
} from "../../ats/workday/application/page-walk.ts";
import type { JourneyId } from "../../contracts/index.ts";
import type { S2StableErrorCode } from "../../contracts/s2-common-wire.ts";
import type {
  ApplicationWalkAcceptanceV1,
} from "../evidence/application-walk-evidence.ts";

export interface Stage2ApplicationWalkInput {
  readonly sourceRevision: string;
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
  readonly cleanup: {
    close(signal: AbortSignal): Promise<boolean>;
  };
  readonly evidence: ApplicationWalkAcceptanceWriter;
}

export type Stage2ApplicationWalkResult =
  | { readonly ok: true; readonly acceptance: ApplicationWalkAcceptanceV1 }
  | {
      readonly ok: false;
      readonly code: S2StableErrorCode;
      readonly failure?: ApplicationWalkFailurePacket;
    };

export async function runStage2ApplicationWalk(
  input: Stage2ApplicationWalkInput,
  dependencies: Stage2ApplicationWalkDependencies,
  signal: AbortSignal,
): Promise<Stage2ApplicationWalkResult> {
  let walk: Awaited<ReturnType<typeof runApplicationPageWalk>>;
  try {
    walk = await runApplicationPageWalk(
      dependencies.walk,
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
    cleaned = await dependencies.cleanup.close(new AbortController().signal);
  } catch {
    cleaned = false;
  }
  if (!cleaned) return { ok: false, code: "browser_profile_cleanup_failed" };
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
