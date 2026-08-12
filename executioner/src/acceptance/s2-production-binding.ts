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
      return Object.freeze({
        account: bound.account,
        recovery: bound.recovery,
        application: Object.freeze({
          run: (applicationSignal: AbortSignal, resume?: ApplicationWalkResume) => runObservedApplicationPageWalk(
            resolved.dependencies,
            {
              journeyId: resolved.input.journeyId,
              stopAfter: "pre_review",
            },
            applicationSignal,
            { resume },
          ),
        }),
        review: bound.review,
        privacy: bound.privacy,
        cleanup: resolved.dependencies.cleanup,
      });
    },
  });
}

export const stage2RealJourneyRuntimeBinding:
  Stage2RealJourneyRuntimeBinding = createStage2RealJourneyProductionBinding({
    runtime: createStage2PlaywrightLiveRuntimeBinding(),
  });
