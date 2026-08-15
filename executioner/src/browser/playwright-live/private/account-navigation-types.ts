import type { JourneyId, OperationId } from "../../../contracts/index.ts";
import type {
  LivePortResult,
  LiveSessionId,
  PersistentBrowserErrorCode,
  TargetIdentityV1,
} from "../../../contracts/live/index.ts";
import type { PersistentPage } from "./types.ts";

export type PostingNavigationAction =
  | "account_sign_in"
  | "start_application"
  | "apply_manually"
  | "sign_in_with_email";

export interface SemanticPostingNavigationAdapter {
  inspect(
    page: PersistentPage,
    action: PostingNavigationAction,
    options?: { readonly waitForCandidate?: boolean },
  ): Promise<{ readonly cardinality: number; readonly actionable: boolean }>;
  activate(page: PersistentPage, action: PostingNavigationAction): Promise<void>;
}

export interface AccountEntryAdvanceRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly sessionId: LiveSessionId;
  readonly target: TargetIdentityV1;
  readonly now: string;
}

export type AccountEntryAdvanceResult =
  | { readonly kind: "account_boundary" }
  | {
      readonly kind: "state_transitioned";
      readonly state: "job_posting" | "apply_choice" | "email_sign_in_choice";
    }
  | { readonly kind: "target_mismatch"; readonly dimension: "host" | "tenant" | "posting" }
  | { readonly kind: "target_ambiguous" }
  | {
      readonly kind: "posting_unavailable";
      readonly reason: "not_found" | "closed" | "removed" | "unavailable" | "maintenance" | "runtime_error";
    };

export type AccountEntryAdvancePortResult = LivePortResult<
  AccountEntryAdvanceResult,
  PersistentBrowserErrorCode
>;

type PostingNavigationObservedKind = "matched" | AccountEntryAdvanceResult["kind"];
type PostingNavigationFailureCode = PersistentBrowserErrorCode | "operation_cancelled";

export type PostingNavigationSessionTraceEvent =
  | `posting_navigation_state_observed_${WorkdayAccountNavigationTraceState}`
  | `posting_navigation_reconcile_failed_${PostingNavigationFailureCode}`
  | `posting_navigation_reconcile_observed_${PostingNavigationObservedKind}`
  | `posting_navigation_transition_inspection_failed_${PostingNavigationFailureCode}`
  | `posting_navigation_transition_inspection_observed_${PostingNavigationObservedKind}`
  | "posting_navigation_transition_monitor_started"
  | "posting_navigation_transition_monitor_succeeded"
  | "posting_navigation_transition_monitor_failed"
  | "account_post_submit_state_invalidated"
  | "account_post_submit_inspection_started"
  | `account_post_submit_inspection_failed_${PostingNavigationFailureCode}`
  | `account_post_submit_inspection_observed_${PostingNavigationObservedKind}`
  | "account_post_submit_monitor_started"
  | "account_post_submit_monitor_succeeded"
  | "account_post_submit_monitor_failed"
  | "account_post_submit_monitor_transition_retry";

type WorkdayAccountNavigationTraceState =
  | "job_posting"
  | "apply_choice"
  | "email_sign_in_choice"
  | "account_boundary"
  | "ambiguous"
  | "invalid";
