import type {
  EventId,
  EvidenceId,
  FactualTerminalOutcome,
  EvidenceStore,
  EventSink,
  FailureReporter,
  JourneyIntake,
  JourneyStateStore,
  PortResult,
  PrivacyGuard,
  OperationId,
  ReportId,
  ReportIdentityError,
  StableErrorCode,
} from "../../../contracts/index.ts";
import type {
  PageLoopDependencies,
  PageLoopOptions,
} from "../loop/index.ts";

export interface JourneyOrchestratorDependencies
  extends PageLoopDependencies {
  readonly intake: JourneyIntake;
  readonly state: JourneyStateStore;
  readonly events: EventSink;
  readonly failures: FailureReporter;
  readonly privacy: PrivacyGuard;
  readonly evidence: EvidenceStore;
  readonly nextEventId: () => EventId;
  readonly nextReportId: () => PortResult<ReportId, ReportIdentityError>;
  readonly nextEvidenceId: () => EvidenceId;
  readonly clock: () => string;
}

export interface JourneyOrchestratorOptions extends PageLoopOptions {
  readonly stateRetryLimit?: number;
}

export type TerminalIntent =
  | {
      readonly status: "review_reached";
      readonly step: "stop_review";
      readonly sourceId: OperationId;
    }
  | {
      readonly status: "cancelled";
      readonly step: "cancel";
      readonly sourceId: OperationId;
    }
  | {
      readonly status: "failed";
      readonly step: "report";
      readonly sourceId: OperationId;
      readonly errorCode: StableErrorCode;
    }
  | {
      readonly status: "blocked";
      readonly step: "classify" | "resolve" | "verify";
      readonly phase:
        | "page_understanding"
        | "answer_resolution"
        | "verification";
      readonly component: "F5" | "F6" | "F8";
      readonly sourceId: OperationId;
      readonly factualOutcome: FactualTerminalOutcome;
    };
