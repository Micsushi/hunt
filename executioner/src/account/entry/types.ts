import type { JourneyId, OperationId } from "../../contracts/index.ts";
import type {
  ActiveAccountSecretHandle,
  ClassificationId,
  ClassificationRevisionId,
  CredentialMutationResult,
  LivePortResult,
  LiveSessionId,
  PersistentBrowserErrorCode,
  SecretStoreErrorCode,
  TargetIdentityV1,
} from "../../contracts/live/index.ts";

export type AccountFieldName = "email" | "password" | "password_confirmation";
export type AccountActionIntent =
  | "show_sign_in"
  | "show_create_account"
  | "submit_sign_in"
  | "submit_create_account";

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
  | { readonly kind: "existing_account" | "create_account" | "verification_required" | "application_ready" }
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
  | { readonly kind: "classification_stopped" };

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
}

export function accountStateResult(
  state: AccountState,
  attemptedFields: readonly ("email" | "password")[],
): CredentialMutationResult {
  return state.kind === "manual_intervention"
    ? { kind: state.kind, reason: state.reason, attemptedFields }
    : { kind: state.kind, attemptedFields };
}
