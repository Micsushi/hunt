import type {
  PhaseId,
  PortError,
  StableErrorCode,
} from "../../../contracts/index.ts";

export type EffectState = "none" | "rejected" | "uncertain";

export function retryDisposition(
  error: PortError<StableErrorCode>,
  effect: EffectState,
): "retry" | "stop" {
  return effect === "none" && error.retryable ? "retry" : "stop";
}

export function sessionRecoveryDisposition(
  error: PortError<StableErrorCode>,
  phase: PhaseId,
  effect: EffectState,
): "fresh_session_then_stop" | "stop" {
  return effect === "uncertain" &&
    (phase === "field_interaction" || phase === "verification") &&
    [
      "browser_effect_uncertain",
      "browser_session_invalidated",
      "operation_cancelled",
    ].includes(error.code)
    ? "fresh_session_then_stop"
    : "stop";
}

export function boundedRetry(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}
