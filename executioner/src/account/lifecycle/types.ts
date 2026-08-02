import type { ClassifiedAccountObservation } from "../../ats/workday/live/index.ts";
import type { JourneyId, OperationId } from "../../contracts/index.ts";
import type {
  ActiveAccountSecretHandle,
  CredentialMutationAdapter,
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

export interface AccountLifecycleAccountStateObserver {
  observe(
    request: AccountLifecycleObservationRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<ClassifiedAccountObservation, PersistentBrowserErrorCode>>;
}

export interface AccountLifecycleDependencies {
  readonly credentialMutation: CredentialMutationAdapter;
  readonly mailbox: MailboxProvider;
  readonly artifacts: VerificationArtifact;
  readonly navigator: PrivilegedVerificationNavigator;
  readonly accountState: AccountLifecycleAccountStateObserver;
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
  readonly operations: {
    readonly initialCredentialMutation: OperationId;
    readonly navigateVerification: OperationId;
    readonly postVerificationSignIn: OperationId;
  };
}

export interface AccountLifecycleReady {
  readonly kind: "account_ready";
  readonly path: "already_ready" | "reused_account" | "verified_account";
  readonly independentlyObserved: true;
  readonly verificationCandidateCount: 0 | 1;
  readonly verificationConsumed: boolean;
}

export type AccountLifecycleValue = AccountLifecycleReady | LiveBlocked;
export type AccountLifecycleResult = LiveCoordinatorResult<AccountLifecycleValue>;
