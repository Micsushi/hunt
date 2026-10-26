import type {
  FailureContext,
  JourneyId,
} from "../../../contracts/index.ts";
import type { PageLoopFailure } from "../loop/index.ts";
import type { JourneyOrchestratorDependencies } from "./types.ts";

export async function reportJourneyFailure(
  dependencies: JourneyOrchestratorDependencies,
  journeyId: JourneyId,
  failure: PageLoopFailure,
): Promise<void> {
  const reportId = dependencies.nextReportId();
  if (!reportId.ok) return;
  const cause = failure.error.cause;
  const context = {
    journeyId,
    component: failure.component,
    phase: failure.phase,
    step: failure.step,
    code: failure.error.code,
    retryable: failure.error.retryable,
    source: { kind: "operation", id: failure.sourceId },
    ...(cause === undefined
      ? {}
      : {
          cause: {
            verification: "verified",
            code: cause.code,
            source: cause.source,
          },
        }),
  } as FailureContext;
  await dependencies.failures.report(
    { reportId: reportId.value, context },
    new AbortController().signal,
  );
}
