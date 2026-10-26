import {
  recoveryKinds,
  type RecoveryAttemptSnapshot,
  type RecoveryClassification,
  type RecoveryInterruption,
  type RecoveryKind,
  type RecoveryRetryLimits,
} from "./types.ts";

export const DEFAULT_RECOVERY_RETRY_LIMITS = Object.freeze({
  reload: 2,
  stale_handle: 1,
  transient_network: 2,
  popup: 1,
  interrupted_process: 1,
  total: 4,
}) satisfies RecoveryRetryLimits;

const recoverable = {
  reload_required: { kind: "reload", action: "reload" },
  browser_target_stale: { kind: "stale_handle", action: "reattach" },
  browser_timeout: { kind: "transient_network", action: "reload" },
  popup_observed: { kind: "popup", action: "inspect" },
  process_interrupted: { kind: "interrupted_process", action: "reattach" },
  browser_session_missing: {
    kind: "interrupted_process",
    action: "reattach",
  },
  browser_session_invalidated: {
    kind: "interrupted_process",
    action: "reattach",
  },
} as const;

export function classifyRecoveryInterruption(
  interruption: RecoveryInterruption,
): RecoveryClassification {
  if (interruption.effect !== "none") {
    return { recoverable: false, code: "recovery_state_ambiguous" };
  }
  const disposition = recoverable[
    interruption.code as keyof typeof recoverable
  ];
  return disposition === undefined
    ? { recoverable: false, code: "recovery_state_ambiguous" }
    : { recoverable: true, ...disposition };
}

export class RecoveryRetryBudget {
  readonly #limits: RecoveryRetryLimits;
  readonly #attempts: Record<RecoveryKind | "total", number> = {
    reload: 0,
    stale_handle: 0,
    transient_network: 0,
    popup: 0,
    interrupted_process: 0,
    total: 0,
  };

  constructor(limits: RecoveryRetryLimits = DEFAULT_RECOVERY_RETRY_LIMITS) {
    for (const name of [...recoveryKinds, "total"] as const) {
      const value = limits[name];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
      }
    }
    this.#limits = Object.freeze({ ...limits });
  }

  consume(kind: RecoveryKind): boolean {
    if (
      this.#attempts[kind] >= this.#limits[kind] ||
      this.#attempts.total >= this.#limits.total
    ) return false;
    this.#attempts[kind] += 1;
    this.#attempts.total += 1;
    return true;
  }

  snapshot(): RecoveryAttemptSnapshot {
    return Object.freeze({ ...this.#attempts });
  }
}
