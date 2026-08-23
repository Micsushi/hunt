import type { ApplicationWalkResume } from "../ats/workday/application/page-walk.ts";
import type {
  Stage2ApplicationWalkDependencies,
} from "../live/runner/application-walk.ts";
import { runObservedApplicationPageWalk } from "../live/runner/application-walk.ts";
import {
  createStage2ApplicationWalkProductionBinding,
  type Stage2ApplicationWalkProductionBindingOptions,
  type Stage2ApplicationWalkRuntimeBindingRequest,
} from "../composition/s2-application-walk-runner.ts";
import type {
  Stage2RealJourneyInvocation,
  Stage2RealJourneyRuntime,
  Stage2RealJourneyRuntimeBinding,
} from "./s2-journey.ts";
import { createStage2PlaywrightLiveRuntimeBinding } from "./s2-playwright-runtime.ts";

export interface Stage2RealJourneyLiveRuntimeBinding {
  bind(
    request: Stage2ApplicationWalkRuntimeBindingRequest,
    signal: AbortSignal,
  ): Promise<
    Omit<Stage2ApplicationWalkDependencies, "evidence"> &
    Pick<Stage2RealJourneyRuntime, "account" | "recovery" | "review" | "privacy">
  >;
}

export interface Stage2RealJourneyProductionBindingOptions
  extends Omit<Stage2ApplicationWalkProductionBindingOptions, "runtime"> {
  readonly runtime: Stage2RealJourneyLiveRuntimeBinding;
  readonly outerProcessCleanup?: boolean;
}

/**
 * Binds the accepted immutable F3 owner-source resolver to the F4 journey.
 * The caller retains only live browser, recovery, Review, privacy, and cleanup
 * authority. No Submit capability is accepted or returned.
 */
export function createStage2RealJourneyProductionBinding(
  dependencies: Stage2RealJourneyProductionBindingOptions,
): Stage2RealJourneyRuntimeBinding {
  return Object.freeze({
    async bind(invocation: Stage2RealJourneyInvocation, signal: AbortSignal) {
      let live: Awaited<ReturnType<Stage2RealJourneyLiveRuntimeBinding["bind"]>> | undefined;
      const application = createStage2ApplicationWalkProductionBinding({
        ...dependencies,
        outerProcessCleanup: dependencies.outerProcessCleanup,
        runtime: {
          async bind(request, runtimeSignal) {
            live = await dependencies.runtime.bind(request, runtimeSignal);
            return live;
          },
        },
      });
      const resolved = await application.bind({
        configPath: invocation.args.configPath,
        evidenceRoot: invocation.args.evidenceRoot,
        checkpoint: "pre_review",
      }, signal);
      if (
        live === undefined ||
        resolved.input.sourceRevision !== invocation.source.sourceRevision ||
        resolved.input.configSha256 !== invocation.config.configSha256 ||
        resolved.input.revisionId !== invocation.config.revisionId ||
        resolved.input.approvalId !== invocation.config.approvalId ||
        resolved.input.journeyId !== invocation.config.journeyId ||
        resolved.input.targetHandleId !== invocation.config.targetHandleId
      ) {
        await resolved.dependencies.cleanup.close(new AbortController().signal);
        throw new TypeError("real journey binding denied");
      }
      const bound = live;
      let applicationAcceptance:
        Parameters<Stage2ApplicationWalkDependencies["evidence"]["write"]>[0] | undefined;
      return Object.freeze({
        account: bound.account,
        recovery: bound.recovery,
        application: Object.freeze({
          async run(applicationSignal: AbortSignal, resume?: ApplicationWalkResume) {
            const walk = await runObservedApplicationPageWalk(
              resolved.dependencies,
              {
                journeyId: resolved.input.journeyId,
                stopAfter: "pre_review",
              },
              applicationSignal,
              { resume },
            );
            if (walk.ok) {
              applicationAcceptance = Object.freeze({
                schemaVersion: 1,
                evidenceRevision: "s2-application-walk-acceptance-v1",
                checkpoint: walk.value.checkpoint,
                status: "passed",
                sourceRevision: resolved.input.sourceRevision,
                revisionId: resolved.input.revisionId,
                approvalId: resolved.input.approvalId,
                journeyId: resolved.input.journeyId,
                targetHandleId: resolved.input.targetHandleId,
                completedPages: walk.value.completedPages,
                pageChecks: Object.freeze(walk.value.pageChecks.map((item) => Object.freeze({ ...item }))),
                laneAcceptances: resolved.dependencies.laneAcceptances.snapshot(walk.value.checkpoint),
                submitActivated: false,
                privacyScan: "pass",
                cleanup: "pass",
              });
            }
            return walk;
          },
        }),
        review: bound.review,
        privacy: bound.privacy,
        cleanup: Object.freeze({
          ...(resolved.dependencies.cleanup.release === undefined ? {} : {
            release: async (cleanupSignal: AbortSignal): Promise<boolean> =>
              await resolved.dependencies.cleanup.release!(cleanupSignal),
          }),
          ...(resolved.dependencies.cleanup.retentionExpiresAt === undefined ? {} : {
            retentionExpiresAt: resolved.dependencies.cleanup.retentionExpiresAt,
          }),
          async close(cleanupSignal: AbortSignal, accepted?: boolean) {
            let cleaned = false;
            try {
              cleaned = await resolved.dependencies.cleanup.close(cleanupSignal, accepted);
            } catch {
              cleaned = false;
            }
            const cleanupOwned = cleaned ||
              (accepted === true && dependencies.outerProcessCleanup === true);
            if (!cleanupOwned || accepted !== true) {
              diagnostic({ cleaned, accepted, outerProcessCleanup: dependencies.outerProcessCleanup === true });
              return cleaned;
            }
            if (applicationAcceptance === undefined) {
              diagnostic({ cleaned, accepted, outerProcessCleanup: true, evidence: "missing" });
              return false;
            }
            try {
              await resolved.dependencies.evidence.write(applicationAcceptance);
              return true;
            } catch (error) {
              diagnostic({
                cleaned,
                accepted,
                outerProcessCleanup: dependencies.outerProcessCleanup === true,
                evidence: error instanceof Error ? error.message : "write_failed",
              });
              return false;
            }
          },
        }),
});

function diagnostic(value: Readonly<Record<string, unknown>>): void {
  if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE !== "1") return;
  process.stderr.write(`${JSON.stringify({ applicationAcceptanceCleanupDiagnostics: value })}\n`);
}
    },
  });
}

export const stage2RealJourneyRuntimeBinding:
  Stage2RealJourneyRuntimeBinding = createStage2RealJourneyProductionBinding({
    runtime: createStage2PlaywrightLiveRuntimeBinding(),
    outerProcessCleanup: process.env.HUNT_C3_OUTER_PROCESS_CLEANUP === "1",
  });
