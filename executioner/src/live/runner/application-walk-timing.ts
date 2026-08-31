import type {
  ApplicationCheckpoint,
  ApplicationWalkDependencies,
} from "../../ats/workday/application/page-walk.ts";
import type { ApplicationPhaseTimingLedger } from "./application-phase-timing.ts";

export interface Stage2ApplicationWalkTimingClock {
  readonly monotonicNow: () => number;
  readonly wallNow: () => string;
}

export interface CompletedPageTiming {
  readonly pageReadyAt: string;
  readonly pageFillCompletedAt: string;
  readonly pageReadinessDurationMs: number;
  readonly navigationWaitDurationMs: number;
  readonly activeFillDurationMs: number;
  readonly independentMonitorDurationMs: number;
  readonly committedReadbackDurationMs: number;
  readonly reconciliationDurationMs: number;
  readonly activeFillSloMs: 60_000;
  readonly activeFillWithinSlo: boolean;
  readonly monotonicClock: "performance_now";
}

interface ActivePageTiming {
  readonly checkpoint: ApplicationCheckpoint;
  readonly pageId: string;
  readonly pageReadyAt: string;
  readonly pageReadinessDurationMs: number;
  readonly navigationWaitDurationMs: number;
  committedReadbackDurationMs: number;
  reconciliationDurationMs: number;
  independentMonitorDurationMs: number;
}

const ACTIVE_FILL_SLO_MS = 60_000 as const;

export class ApplicationWalkTimingCollector {
  readonly #clock: Stage2ApplicationWalkTimingClock;
  readonly #phaseTiming: ApplicationPhaseTimingLedger | undefined;
  readonly #ready = new Map<string, { at: string; durationMs: number }>();
  readonly #active: ActivePageTiming[] = [];
  #navigationWaitDurationMs = 0;

  constructor(
    clock: Stage2ApplicationWalkTimingClock,
    phaseTiming: ApplicationPhaseTimingLedger | undefined,
  ) {
    this.#clock = clock;
    this.#phaseTiming = phaseTiming;
  }

  observed(
    result: Awaited<ReturnType<ApplicationWalkDependencies["observer"]["observe"]>>,
    at: string,
    durationMs: number,
  ): void {
    if (!result.ok) return;
    const active = this.#active.find(({ pageId }) => pageId === result.value.pageId);
    if (active === undefined) this.#ready.set(result.value.pageId, { at, durationMs });
    else active.committedReadbackDurationMs += durationMs;
  }

  navigated(durationMs: number): void {
    this.#navigationWaitDurationMs = durationMs;
  }

  handler<Page extends "resume" | "profile" | "questionnaire">(
    page: Page,
    handler: ApplicationWalkDependencies["handlers"][Page],
  ): ApplicationWalkDependencies["handlers"][Page] {
    return Object.freeze({
      reconcile: async (
        request: Parameters<ApplicationWalkDependencies["handlers"][Page]["reconcile"]>[0],
        signal: AbortSignal,
      ) => {
        const checkpoint = page === "resume" ? "resume_verified"
          : page === "profile" ? "profile_verified" : "questionnaire_verified";
        let active = this.#active.find((item) =>
          item.checkpoint === checkpoint && item.pageId === request.pageId
        );
        if (active === undefined) {
          const ready = this.#ready.get(request.pageId) ?? {
            at: this.#clock.wallNow(),
            durationMs: 0,
          };
          active = {
            checkpoint,
            pageId: request.pageId,
            pageReadyAt: ready.at,
            pageReadinessDurationMs: ready.durationMs,
            navigationWaitDurationMs: this.#navigationWaitDurationMs,
            committedReadbackDurationMs: 0,
            reconciliationDurationMs: 0,
            independentMonitorDurationMs: 0,
          };
          this.#active.push(active);
          this.#navigationWaitDurationMs = 0;
        }
        const began = this.#clock.monotonicNow();
        const monitorBegan = this.#phaseTiming?.independentMonitorDurationMs() ?? 0;
        try {
          return await handler.reconcile(request, signal);
        } finally {
          active.reconciliationDurationMs += elapsedApplicationWalkTiming(this.#clock, began);
          const monitorEnded = this.#phaseTiming?.independentMonitorDurationMs() ?? monitorBegan;
          active.independentMonitorDurationMs += Math.max(0, monitorEnded - monitorBegan);
        }
      },
    }) as ApplicationWalkDependencies["handlers"][Page];
  }

  complete(checkpoint: ApplicationCheckpoint): CompletedPageTiming {
    const index = this.#active.findIndex((item) => item.checkpoint === checkpoint);
    const active = index === -1 ? undefined : this.#active.splice(index, 1)[0];
    if (active === undefined) throw new TypeError("application page timing unavailable");
    const independentMonitorDurationMs = Math.min(
      active.reconciliationDurationMs,
      active.independentMonitorDurationMs,
    );
    const activeFillDurationMs = active.reconciliationDurationMs - independentMonitorDurationMs;
    return Object.freeze({
      pageReadyAt: active.pageReadyAt,
      pageFillCompletedAt: this.#clock.wallNow(),
      pageReadinessDurationMs: active.pageReadinessDurationMs,
      navigationWaitDurationMs: active.navigationWaitDurationMs,
      activeFillDurationMs,
      independentMonitorDurationMs,
      committedReadbackDurationMs: active.committedReadbackDurationMs,
      reconciliationDurationMs: active.reconciliationDurationMs,
      activeFillSloMs: ACTIVE_FILL_SLO_MS,
      activeFillWithinSlo: activeFillDurationMs <= ACTIVE_FILL_SLO_MS,
      monotonicClock: "performance_now",
    });
  }
}

export function elapsedApplicationWalkTiming(
  clock: Stage2ApplicationWalkTimingClock,
  started: number,
): number {
  return Math.max(0, Math.round(clock.monotonicNow() - started));
}
