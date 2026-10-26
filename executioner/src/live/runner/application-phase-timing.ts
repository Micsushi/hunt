export interface ApplicationPhaseTimingLedger {
  recordIndependentMonitor(durationMs: number): void;
  independentMonitorDurationMs(): number;
}

export function createApplicationPhaseTimingLedger(): ApplicationPhaseTimingLedger {
  let independentMonitorDurationMs = 0;
  return Object.freeze({
    recordIndependentMonitor(durationMs: number): void {
      if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
        throw new TypeError("application phase timing denied");
      }
      independentMonitorDurationMs += durationMs;
      if (!Number.isSafeInteger(independentMonitorDurationMs)) {
        throw new TypeError("application phase timing denied");
      }
    },
    independentMonitorDurationMs(): number {
      return independentMonitorDurationMs;
    },
  });
}
