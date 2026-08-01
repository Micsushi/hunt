import {
  s2StableErrorPolicy,
  type S2StableErrorCode,
} from "../../../contracts/s2-common-wire.ts";
import type {
  FactualTerminalOutcomeV4,
} from "../../../contracts/s2-common-wire.ts";
import type { SanitizedUnknownCandidateV1 } from "../../../contracts/live/index.ts";

export interface LiveCoordinatorError {
  readonly code: S2StableErrorCode;
  readonly retryable: boolean;
}

export type LiveCoordinatorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LiveCoordinatorError };

export function liveCoordinatorError<C extends S2StableErrorCode>(code: C): LiveCoordinatorError {
  return { code, retryable: s2StableErrorPolicy[code].retryable };
}

export type LiveBlocked = {
  readonly kind: "blocked";
  readonly factualOutcome: FactualTerminalOutcomeV4;
  readonly candidate?: SanitizedUnknownCandidateV1;
};
