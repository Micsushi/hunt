import type {
  BrowserPageId,
  JourneyId,
  OperationId,
} from "../../contracts/index.ts";
import type {
  LiveRevisionId,
  TargetIdentityV1,
} from "../../contracts/live/index.ts";
import type { S2StableErrorCode } from "../../contracts/s2-common-wire.ts";

export const recoveryKinds = [
  "reload",
  "stale_handle",
  "transient_network",
  "popup",
  "interrupted_process",
] as const;

export type RecoveryKind = (typeof recoveryKinds)[number];
export type RecoveryEffect = "none" | "possible";
export type RecoveryInterruptionCode =
  | "reload_required"
  | "browser_target_stale"
  | "browser_timeout"
  | "popup_observed"
  | "process_interrupted"
  | "browser_session_missing"
  | "browser_session_invalidated"
  | "browser_effect_uncertain"
  | "browser_target_invalid";

export interface RecoveryInterruption {
  readonly code: RecoveryInterruptionCode;
  readonly effect: RecoveryEffect;
}

export type RecoveryClassification =
  | {
      readonly recoverable: true;
      readonly kind: RecoveryKind;
      readonly action: "inspect" | "reload" | "reattach";
    }
  | {
      readonly recoverable: false;
      readonly code: "recovery_state_ambiguous";
    };

export type RecoveryRetryLimits = Readonly<Record<RecoveryKind | "total", number>>;
export type RecoveryAttemptSnapshot = Readonly<Record<RecoveryKind | "total", number>>;

export type RecoveryPageKind =
  | "account"
  | "verification"
  | "profile"
  | "questionnaire"
  | "review";

export interface RecoveryPageCoordinate {
  readonly id: BrowserPageId;
  readonly kind: RecoveryPageKind;
}

export type RecoveryBrowserPageKind = RecoveryPageKind | "unknown" | "ambiguous";
export type RecoveryVerificationTruth =
  | "not_required"
  | "required"
  | "verified"
  | "unknown";

export interface RecoveryBrowserPageTruth {
  readonly page: {
    readonly id: BrowserPageId;
    readonly kind: RecoveryBrowserPageKind;
  };
  readonly target: TargetIdentityV1;
  readonly verification: RecoveryVerificationTruth;
  readonly surface: "primary" | "popup";
}

export type RecoveryTerminalCode =
  | "recovery_state_ambiguous"
  | "recovery_target_mismatch"
  | "journey_retry_exhausted";

export interface RecoveryTerminal {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly code: RecoveryTerminalCode;
  readonly retryable: false;
  readonly attempts: RecoveryAttemptSnapshot;
}

export interface RecoveryCheckpoint {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly sourceRevision: LiveRevisionId;
  readonly revision: number;
  readonly target: TargetIdentityV1;
  readonly page: RecoveryPageCoordinate;
  readonly verification: Exclude<RecoveryVerificationTruth, "unknown">;
  readonly terminal: RecoveryTerminal | null;
}

export interface RecoveryReconciliationRecord {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly interruption: RecoveryKind | "nonrecoverable";
  readonly target: "matched" | "mismatch" | "ambiguous";
  readonly page:
    | "matched"
    | "browser_advanced"
    | "browser_regressed"
    | "browser_replaced"
    | "unresolved";
  readonly verification:
    | "matched"
    | "browser_verified"
    | "verification_required"
    | "unresolved";
  readonly outcome: "resume" | "stop";
  readonly attempts: RecoveryAttemptSnapshot;
}

export interface RecoveryError {
  readonly code: S2StableErrorCode;
  readonly retryable: boolean;
}

export type RecoveryPortResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: S2StableErrorCode } };

export interface RecoveryStateStore {
  load(
    request: {
      readonly schemaVersion: 1;
      readonly journeyId: JourneyId;
      readonly sourceRevision: LiveRevisionId;
    },
    signal: AbortSignal,
  ): Promise<RecoveryPortResult<RecoveryCheckpoint | null>>;
  save(
    request: {
      readonly schemaVersion: 1;
      readonly journeyId: JourneyId;
      readonly operationId: OperationId;
      readonly expectedRevision: number;
      readonly state: RecoveryCheckpoint;
    },
    signal: AbortSignal,
  ): Promise<RecoveryPortResult<RecoveryCheckpoint>>;
}

export interface RecoveryBrowser {
  inspect(
    signal: AbortSignal,
  ): Promise<RecoveryPortResult<{ readonly pages: readonly RecoveryBrowserPageTruth[] }>>;
  reload(signal: AbortSignal): Promise<RecoveryPortResult<void>>;
  reattach(signal: AbortSignal): Promise<RecoveryPortResult<void>>;
}

export interface RecoveryReconciliationSink {
  record(
    request: { readonly record: RecoveryReconciliationRecord },
    signal: AbortSignal,
  ): Promise<RecoveryPortResult<void>>;
}

export interface RecoveryTerminalStore {
  commit(
    request: { readonly terminal: RecoveryTerminal },
    signal: AbortSignal,
  ): Promise<RecoveryPortResult<RecoveryTerminal>>;
}

export interface RecoveryDependencies {
  readonly state: RecoveryStateStore;
  readonly browser: RecoveryBrowser;
  readonly reconciliation: RecoveryReconciliationSink;
  readonly terminal: RecoveryTerminalStore;
}

export interface RecoverBrowserInterruptionInput {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly sourceRevision: LiveRevisionId;
  readonly expectedTarget: TargetIdentityV1;
  readonly operationId: OperationId;
  readonly interruption: RecoveryInterruption;
  readonly retryLimits?: RecoveryRetryLimits;
}

export type RecoverBrowserInterruptionResult =
  | {
      readonly ok: true;
      readonly value:
        | {
            readonly kind: "resumed";
            readonly state: RecoveryCheckpoint;
            readonly reconciliation: RecoveryReconciliationRecord;
          }
        | { readonly kind: "terminal"; readonly terminal: RecoveryTerminal };
    }
  | { readonly ok: false; readonly error: RecoveryError };
