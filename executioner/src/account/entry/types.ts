import type { JourneyId, OperationId } from "../../contracts/index.ts";
import type {
  ActiveAccountSecretHandle,
  ClassificationId,
  ClassificationRevisionId,
  CredentialMutationResult,
  CredentialMutationAdapter,
  CredentialMutationErrorCode,
  CredentialMutationRequest,
  LivePortResult,
  LiveSessionId,
  PersistentBrowserErrorCode,
  SecretStoreErrorCode,
  TargetIdentityV1,
  WorkdayPageType,
} from "../../contracts/live/index.ts";

export type AccountFieldName = "email" | "password" | "password_confirmation";
export type AccountActionIntent =
  | "show_sign_in"
  | "show_create_account"
  | "submit_sign_in"
  | "submit_create_account"
  | "accept_terms"
  | "request_verification_email";

export type AccountEntryTraceEvent =
  | "initial_state_existing_account"
  | "initial_state_create_account"
  | "owned_access_started"
  | "account_mode_switched_to_sign_in"
  | "account_mode_switched_to_create_account"
  | "fields_admitted"
  | "credentials_resolved"
  | "email_verified"
  | "password_verified"
  | "submit_reinspect_succeeded"
  | "submit_reinspect_failed"
  | "account_submit_activate_started"
  | "account_submit_activate_failed"
  | "account_submit_activated"
  | "post_submit_classify_started"
  | "post_submit_classify_retry"
  | "post_submit_classify_failed"
  | "post_submit_navigation_required"
  | "post_submit_existing_account"
  | "post_submit_create_account"
  | "post_submit_account_absent"
  | "post_submit_account_exists"
  | "post_submit_sign_in_required"
  | "post_submit_no_progress"
  | "post_submit_verification_required"
  | "post_submit_application_ready"
  | "post_submit_manual_intervention"
  | "cleanup_succeeded"
  | "cleanup_failed"
  | "cleanup_clear_failed"
  | "cleanup_empty_failed"
  | "page_scope_failed";

export interface SemanticControlFact {
  readonly cardinality: number;
  readonly actionable: boolean;
}

export interface AccountPageAccess {
  inspectField(field: AccountFieldName): Promise<LivePortResult<SemanticControlFact, PersistentBrowserErrorCode>>;
  inspectAction(action: AccountActionIntent): Promise<LivePortResult<SemanticControlFact, PersistentBrowserErrorCode>>;
  fill(field: AccountFieldName, bytes: Uint8Array): Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
  matches(field: AccountFieldName, bytes: Uint8Array): Promise<LivePortResult<boolean, PersistentBrowserErrorCode>>;
  clear(field: AccountFieldName): Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
  isEmpty(field: AccountFieldName): Promise<LivePortResult<boolean, PersistentBrowserErrorCode>>;
  activate(action: AccountActionIntent): Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
}

export interface AccountPageAccessProvider {
  withOwnedAccountPageAccess(
    request: {
      readonly schemaVersion: 1;
      readonly journeyId: JourneyId;
      readonly operationId: OperationId;
      readonly sessionId: LiveSessionId;
      readonly target: TargetIdentityV1;
      readonly now: string;
    },
    signal: AbortSignal,
    use: (access: AccountPageAccess) => Promise<void>,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
}

type AccountState = {
  readonly classificationId: ClassificationId;
  readonly sourceRevisionId: ClassificationRevisionId;
} & (
  | {
      readonly kind: "existing_account" | "create_account";
      readonly accountFact?: "absent" | "exists";
    }
  | { readonly kind: "verification_required" | "application_ready" }
  | { readonly kind: "manual_intervention"; readonly reason: "captcha" | "mfa" | "access_control" }
);

export type ClassifiedAccountObservation =
  | {
      readonly kind: "classified_account";
      readonly state: AccountState;
      readonly classificationId: ClassificationId;
      readonly sourceRevisionId: ClassificationRevisionId;
      readonly snapshotId: string;
      readonly documentGenerationId: string;
    }
  | { readonly kind: "target_mismatch" | "target_ambiguous" | "posting_unavailable" }
  | { readonly kind: "classification_stopped"; readonly pageType: WorkdayPageType | null };

export interface ClassifiedAccountStateSource {
  inspectClassifiedAccount(
    request: {
      readonly schemaVersion: 1;
      readonly sessionId: LiveSessionId;
      readonly target: TargetIdentityV1;
    },
    signal: AbortSignal,
  ): Promise<LivePortResult<ClassifiedAccountObservation, PersistentBrowserErrorCode>>;
}

export interface ScopedAccountCredentialResolver {
  useAccountCredentials<Result extends CredentialMutationResult>(
    handle: ActiveAccountSecretHandle,
    signal: AbortSignal,
    operation: (value: {
      readonly email: Readonly<Uint8Array>;
      readonly password: Readonly<Uint8Array>;
    }) => Promise<Result>,
  ): Promise<LivePortResult<Result, SecretStoreErrorCode>>;
}

export interface AccountEntryDependencies {
  readonly classifiedAccount: ClassifiedAccountStateSource;
  readonly accountPage: AccountPageAccessProvider;
  readonly credentials: ScopedAccountCredentialResolver;
  readonly postSubmitClassificationDelay?: () => Promise<void>;
  readonly trace?: (event: AccountEntryTraceEvent) => void;
}

export type AccountLifecycleCredentialMutationResult =
  | CredentialMutationResult
  | {
      readonly kind:
        | "account_absent"
        | "account_exists"
        | "sign_in_required"
        | "create_account_required";
      readonly attemptedFields: readonly ["email", "password"];
    }
  | {
      readonly kind: "navigation_required";
      readonly pageType: "job_posting";
      readonly attemptedFields: readonly ["email", "password"];
    };

export interface AccountLifecycleCredentialMutationAdapter {
  mutate(
    request: CredentialMutationRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<
    AccountLifecycleCredentialMutationResult,
    CredentialMutationErrorCode
  >>;
}

export interface AccountEntryCredentialMutationAdapter extends CredentialMutationAdapter {
  readonly lifecycle: AccountLifecycleCredentialMutationAdapter;
}

export function accountStateResult(
  state: AccountState,
  attemptedFields: readonly ("email" | "password")[],
): CredentialMutationResult {
  return state.kind === "manual_intervention"
    ? { kind: state.kind, reason: state.reason, attemptedFields }
    : { kind: state.kind, attemptedFields };
}

export function accountFactResult(
  state: AccountState,
): {
  readonly kind: "account_absent" | "account_exists";
  readonly attemptedFields: readonly ["email", "password"];
} | undefined {
  if (state.kind === "existing_account" && state.accountFact === "absent") {
    return { kind: "account_absent", attemptedFields: ["email", "password"] };
  }
  if (state.kind === "create_account" && state.accountFact === "exists") {
    return { kind: "account_exists", attemptedFields: ["email", "password"] };
  }
  return undefined;
}
