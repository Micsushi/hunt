import {
  providerCause,
  providerError,
  stableErrorPolicy,
  type CancellationError,
  type OperationId,
  type PhaseId,
  type PortError,
  type PortResult,
  type StableErrorCode,
  type StepId,
} from "../../../contracts/index.ts";
import type { PageLoopFailure } from "../loop/index.ts";

export function contextualError<
  C extends "journey_request_conflict" | "journey_busy",
>(
  code: C,
  provider: PortError<StableErrorCode>,
  sourceId: OperationId,
): PortError<C> {
  return providerError(
    code,
    providerCause(provider.code, { kind: "operation", id: sourceId }),
  );
}

export function pageLoopFailure(
  error: PortError<StableErrorCode>,
  phase: PhaseId,
  step: StepId,
  sourceId: OperationId,
  effect: PageLoopFailure["effect"] = "none",
): PageLoopFailure {
  return {
    error,
    component: stableErrorPolicy[error.code].owner,
    phase,
    step,
    sourceId,
    effect,
  };
}

export function cancelledResult(): PortResult<never, CancellationError> {
  return { ok: false, error: providerError("operation_cancelled") };
}

export function boundedRetry(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("stateRetryLimit must be a non-negative safe integer");
  }
  return value;
}
