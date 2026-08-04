import type { JourneyId, OperationId } from "../../contracts/index.ts";
import type {
  ActiveAccountSecretHandle,
  CredentialMutationErrorCode,
  CredentialMutationRequest,
  CredentialMutationResult,
  LiveBrowserSessionV1,
  LivePortResult,
  LiveSessionId,
  MailboxPollRequest,
  MailboxProvider,
  PersistentBrowserErrorCode,
  PrivilegedVerificationNavigator,
  TargetIdentityV1,
  VerificationArtifact,
} from "../../contracts/live/index.ts";
import type {
  LiveBlocked,
  LiveCoordinatorResult,
} from "../../control/orchestrator/live/types.ts";

export interface AccountLifecycleObservationRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly sessionId: LiveSessionId;
  readonly target: TargetIdentityV1;
}

export type AccountLifecycleObservation =
  | {
      readonly kind: "target_mismatch";
      readonly dimension: "host" | "tenant" | "posting";
    }
  | { readonly kind: "target_ambiguous" }
  | {
      readonly kind: "posting_unavailable";
      readonly reason: "not_found" | "closed" | "removed" | "unavailable" | "maintenance" | "runtime_error";
    }
  | {
      readonly kind: "classified_account";
      readonly state:
        | {
            readonly kind:
              | "existing_account"
              | "create_account";
            readonly accountFact?: "absent" | "exists";
          }
        | { readonly kind: "verification_required" | "application_ready" }
        | {
            readonly kind: "manual_intervention";
            readonly reason: "captcha" | "mfa" | "access_control";
          };
    }
  | {
      readonly kind: "classification_stopped";
      readonly outcome:
        | "ats_unsupported"
        | "ats_unknown"
        | "ats_ambiguous"
        | "workday_page_unknown"
        | "workday_page_ambiguous"
        | "account_state_unknown"
        | "account_state_ambiguous";
    };

export interface AccountLifecycleAccountStateObserver {
  observe(
    request: AccountLifecycleObservationRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<AccountLifecycleObservation, PersistentBrowserErrorCode>>;
}

export type AccountLifecycleCredentialMutationResult =
  | CredentialMutationResult
  | {
      readonly kind: "account_absent" | "account_exists" | "sign_in_required";
      readonly attemptedFields: readonly ["email", "password"];
    };

export type AccountLifecycleTraceEvent =
  | "lifecycle_page_sign_in"
  | "lifecycle_page_create_account"
  | "lifecycle_page_verification_required"
  | "lifecycle_page_application_ready"
  | "lifecycle_page_manual_intervention"
  | "lifecycle_action_sign_in"
  | "lifecycle_action_create_account"
  | "lifecycle_action_verification_link"
  | "lifecycle_cycle_stopped";

export interface AccountLifecycleCredentialMutationAdapter {
  mutate(
    request: CredentialMutationRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<
    AccountLifecycleCredentialMutationResult,
    CredentialMutationErrorCode
  >>;
}

export interface AccountLifecycleDependencies {
  readonly credentialMutation: AccountLifecycleCredentialMutationAdapter;
  readonly mailbox: MailboxProvider;
  readonly artifacts: VerificationArtifact;
  readonly navigator: PrivilegedVerificationNavigator;
  readonly accountState: AccountLifecycleAccountStateObserver;
  readonly trace?: (event: AccountLifecycleTraceEvent) => void;
}

export interface AccountLifecycleInput {
  readonly schemaVersion: 1;
  readonly operationId: OperationId;
  readonly journeyId: JourneyId;
  readonly session: LiveBrowserSessionV1;
  readonly target: TargetIdentityV1;
  readonly credential: ActiveAccountSecretHandle;
  readonly mailboxRequest: MailboxPollRequest;
  readonly now: string;
  readonly accountIntent: "sign_in" | "fresh_create";
  readonly operations: {
    readonly initialCredentialMutation: OperationId;
    readonly createCredentialMutation: OperationId;
    readonly accountExistsSignIn: OperationId;
    readonly navigateVerification: OperationId;
    readonly postVerificationSignIn: OperationId;
  };
}

export interface AccountLifecycleReady {
  readonly kind: "account_ready";
  readonly path: "already_ready" | "reused_account" | "created_account" | "verified_account";
  readonly independentlyObserved: true;
  readonly verificationCandidateCount: 0 | 1;
  readonly verificationConsumed: boolean;
}

export type AccountLifecycleValue = AccountLifecycleReady | LiveBlocked;
export type AccountLifecycleResult = LiveCoordinatorResult<AccountLifecycleValue>;
