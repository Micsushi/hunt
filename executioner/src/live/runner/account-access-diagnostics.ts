import type {
  EventEnvelopeV3,
  EventId,
  JourneyId,
  OperationId,
  S2CommonComponentId,
  S2StableErrorCode,
  StepId,
  TerminalResultV4,
} from "../../contracts/index.ts";

export interface AccountAccessDiagnostics {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-account-access-diagnostics-v1";
  readonly checkpoint: "account_access";
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly journeyId: JourneyId;
  readonly status: "passed" | "blocked" | "failed";
  readonly completedSteps: number;
  readonly events: readonly EventEnvelopeV3[];
  readonly terminal: TerminalResultV4 | null;
  readonly submitActivated: false;
  readonly privacyScan: "pass";
  readonly cleanup: "pass" | "failed";
}

export interface AccountAccessDiagnosticsWriter {
  write(value: AccountAccessDiagnostics): Promise<void>;
}

export interface AccountAccessEventRecorderOptions {
  readonly journeyId: JourneyId;
  readonly nextEventId: () => EventId;
  readonly now: () => string;
}

export class AccountAccessEventRecorder {
  readonly events: EventEnvelopeV3[] = [];
  lastSource: OperationId | undefined;
  #active:
    | {
        readonly component: S2CommonComponentId;
        readonly step: StepId;
        readonly source: OperationId;
      }
    | undefined;
  readonly #options: AccountAccessEventRecorderOptions;

  constructor(options: AccountAccessEventRecorderOptions) {
    this.#options = options;
  }

  get completedSteps(): number {
    return this.events.filter(({ kind }) => kind === "step_completed").length;
  }

  unexpectedFailureCode(): S2StableErrorCode {
    if (this.#active?.component === "S2_CREDENTIAL_MUTATION") {
      return "credential_effect_uncertain";
    }
    if (this.#active?.step === "navigate") return "browser_target_invalid";
    return "browser_session_invalidated";
  }

  failActive(): void {
    const active = this.#active;
    if (active === undefined) return;
    this.record(active.component, active.step, "step_failed", active.source);
  }

  record(
    component: S2CommonComponentId,
    step: StepId,
    kind: EventEnvelopeV3["kind"],
    source: OperationId,
  ): void {
    this.lastSource = source;
    if (kind === "step_started") {
      this.#active = { component, step, source };
    } else if (
      (kind === "step_completed" || kind === "step_failed") &&
      this.#active?.source === source
    ) {
      this.#active = undefined;
    }
    this.events.push(Object.freeze({
      schemaVersion: 3,
      eventId: this.#options.nextEventId(),
      journeyId: this.#options.journeyId,
      component,
      phase: "account_access",
      step,
      kind,
      at: this.#options.now(),
      source: { kind: "operation" as const, id: source },
    }));
  }
}
