import {
  s2StableErrorPolicy,
  type S2StableErrorCode,
} from "./s2-common-wire.ts";

export const stage2FailureLayers = [
  "readiness",
  "source_admission",
  "browser_launch_binding",
  "authentication",
  "ui",
  "observer_evidence",
  "cancellation",
  "cleanup",
  "service",
] as const;

export type Stage2FailureLayer = (typeof stage2FailureLayers)[number];

/** A value-free causal marker. Detail stays in the retained private trace. */
export class Stage2CausalError extends Error {
  readonly layer: Stage2FailureLayer;
  readonly code: S2StableErrorCode;
  override readonly cause?: unknown;

  constructor(
    layer: Stage2FailureLayer,
    code: S2StableErrorCode,
    cause?: unknown,
  ) {
    super(`stage2 ${layer} failed`);
    this.name = "Stage2CausalError";
    this.layer = layer;
    this.code = code;
    this.cause = cause;
  }
}

export function stage2CausalError(
  layer: Stage2FailureLayer,
  code: S2StableErrorCode,
  cause?: unknown,
): Stage2CausalError {
  return new Stage2CausalError(layer, code, cause);
}

export function earliestStage2Cause(error: unknown): Readonly<{
  layer: Stage2FailureLayer;
  code: S2StableErrorCode;
}> | undefined {
  let current = error;
  let earliest: Stage2CausalError | undefined;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 32 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Stage2CausalError) earliest = current;
    current = causalParent(current);
  }
  return earliest === undefined
    ? undefined
    : Object.freeze({ layer: earliest.layer, code: earliest.code });
}

export function stage2CausalCode(
  error: unknown,
  fallback: S2StableErrorCode,
): S2StableErrorCode {
  return earliestStage2Cause(error)?.code ?? fallback;
}

export function stableStage2Code(value: string): S2StableErrorCode | undefined {
  return Object.hasOwn(s2StableErrorPolicy, value)
    ? value as S2StableErrorCode
    : undefined;
}

function causalParent(value: unknown): unknown {
  return typeof value === "object" && value !== null && "cause" in value
    ? (value as { readonly cause?: unknown }).cause
    : undefined;
}
