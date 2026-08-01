import type {
  CancellationError,
  JourneyId,
  OperationId,
  PortResult,
} from "../types.ts";
import {
  s2StableErrorPolicy,
  type S2StableErrorCode,
} from "../s2-common-wire.ts";

declare const liveIdentifierBrand: unique symbol;
export type LiveIdentifier<Kind extends string> = string & {
  readonly [liveIdentifierBrand]: Kind;
};

export type LiveSessionId = LiveIdentifier<"live_session">;
export type ProfileLeaseId = LiveIdentifier<"profile_lease">;
export type SecretHandleId = LiveIdentifier<"secret_handle">;
export type VerificationHandleId = LiveIdentifier<"verification_handle">;
export type CheckpointId = LiveIdentifier<"checkpoint">;
export type LiveEvidenceId = LiveIdentifier<"live_evidence">;
export type LiveRevisionId = LiveIdentifier<"revision">;
export type TargetHostId = LiveIdentifier<"host">;
export type TargetTenantId = LiveIdentifier<"tenant">;
export type TargetPostingId = LiveIdentifier<"posting">;
export type RecipientBindingId = LiveIdentifier<"recipient">;
export type ManifestId = LiveIdentifier<"manifest">;

type S2ErrorPolicy<C extends S2StableErrorCode> =
  (typeof s2StableErrorPolicy)[C];

export type S2PortError<C extends S2StableErrorCode> =
  C extends S2StableErrorCode
    ? {
        readonly code: C;
        readonly retryable: S2ErrorPolicy<C>["retryable"];
      }
    : never;

export type LivePortResult<T, C extends S2StableErrorCode> = PortResult<
  T,
  S2PortError<C> | CancellationError
>;

export interface TargetIdentityV1 {
  readonly schemaVersion: 1;
  readonly atsFamily: "workday";
  readonly hostId: TargetHostId;
  readonly tenantId: TargetTenantId;
  readonly postingId: TargetPostingId;
}

export interface LiveBrowserSessionV1 {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly sessionId: LiveSessionId;
  readonly profileLeaseId: ProfileLeaseId;
  readonly target: TargetIdentityV1;
  readonly leaseExpiresAt: string;
}

export interface PersistentBrowserOpenRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly profileLeaseId: ProfileLeaseId;
  readonly target: TargetIdentityV1;
}

export interface PersistentBrowserReconcileRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly session: LiveBrowserSessionV1;
  readonly expectedTarget: TargetIdentityV1;
}

export interface PersistentBrowserCloseRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly sessionId: LiveSessionId;
}

export type PersistentBrowserOpenResult = {
  readonly kind: "opened" | "reattached";
  readonly session: LiveBrowserSessionV1;
};

export type PersistentBrowserReconcileResult =
  | { readonly kind: "matched"; readonly session: LiveBrowserSessionV1 }
  | {
      readonly kind: "target_mismatch";
      readonly dimension: "host" | "tenant" | "posting";
    }
  | { readonly kind: "target_ambiguous" }
  | {
      readonly kind: "posting_unavailable";
      readonly reason: "not_found" | "closed" | "removed" | "unavailable";
    };

export type PersistentBrowserErrorCode =
  | "browser_target_invalid"
  | "browser_session_missing"
  | "browser_target_stale"
  | "browser_target_ambiguous"
  | "browser_operation_replayed"
  | "browser_timeout"
  | "browser_effect_uncertain"
  | "browser_session_invalidated"
  | "browser_profile_cleanup_failed";

export type SecretProviderId = "windows_dpapi_current_user_v1";
export type SecretPurpose = "account_credentials" | "gmail_oauth";
export type SecretConsumer =
  | "credential_mutation_adapter"
  | "gmail_auth_executor";
export type SecretHandleState = "active" | "expired" | "revoked";

export interface SecretHandleMetadataV1 {
  readonly schemaVersion: 1;
  readonly handleId: SecretHandleId;
  readonly journeyId: JourneyId;
  readonly provider: SecretProviderId;
  readonly purpose: SecretPurpose;
  readonly consumer: SecretConsumer;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: SecretHandleState;
}

export type ActiveAccountSecretHandle = SecretHandleMetadataV1 & {
  readonly purpose: "account_credentials";
  readonly consumer: "credential_mutation_adapter";
  readonly state: "active";
};

export type ActiveGmailSecretHandle = SecretHandleMetadataV1 & {
  readonly purpose: "gmail_oauth";
  readonly consumer: "gmail_auth_executor";
  readonly state: "active";
};

export interface SecretInspectRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly handleId: SecretHandleId;
  readonly expectedPurpose: SecretPurpose;
  readonly expectedConsumer: SecretConsumer;
}

export interface SecretRevokeRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly handleId: SecretHandleId;
}

export type SecretStoreErrorCode =
  | "secret_handle_invalid"
  | "secret_handle_expired"
  | "secret_handle_mismatched"
  | "secret_consumer_forbidden"
  | "secret_store_unavailable";

export interface CredentialMutationRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly sessionId: LiveSessionId;
  readonly target: TargetIdentityV1;
  readonly now: string;
  readonly mode: "create_account" | "sign_in";
  readonly credential: ActiveAccountSecretHandle;
  readonly fields: readonly ("email" | "password")[];
}

export type CredentialMutationResult =
  | {
      readonly kind:
        | "existing_account"
        | "create_account"
        | "verification_required"
        | "application_ready";
      readonly attemptedFields: readonly ("email" | "password")[];
    }
  | {
      readonly kind: "manual_intervention";
      readonly reason: "captcha" | "mfa" | "access_control";
      readonly attemptedFields: readonly ("email" | "password")[];
    };

export type CredentialMutationErrorCode =
  | "credential_mutation_denied"
  | "credential_effect_uncertain"
  | "secret_handle_invalid"
  | "secret_handle_expired"
  | "secret_handle_mismatched"
  | "secret_consumer_forbidden"
  | "secret_store_unavailable";

export interface MailboxPollRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly queryId: LiveIdentifier<"mailbox_query">;
  readonly recipientBindingId: RecipientBindingId;
  readonly target: TargetIdentityV1;
  readonly notBefore: string;
  readonly notAfter: string;
}

export interface PrivilegedGmailQueryRequest extends MailboxPollRequest {
  readonly now: string;
  readonly authorization: ActiveGmailSecretHandle;
}

export interface MailboxPollResultV1 {
  readonly provider: "gmail_api_v1";
  readonly receivedTimeBucket: string | null;
  readonly expiresAt: string | null;
  readonly candidateCount: number;
  readonly verificationHandle: VerificationHandleId | null;
}

export type GmailAuthErrorCode =
  | "gmail_auth_denied"
  | "gmail_rate_limited"
  | "gmail_network_unavailable"
  | "mailbox_query_invalid"
  | "secret_handle_invalid"
  | "secret_handle_expired"
  | "secret_handle_mismatched"
  | "secret_consumer_forbidden"
  | "secret_store_unavailable";

export type MailboxProviderErrorCode =
  | "mailbox_query_invalid"
  | "mailbox_timeout"
  | "verification_artifact_replayed";

export type VerificationArtifactState =
  | "available"
  | "expired"
  | "consumed"
  | "invalidated";

export interface VerificationArtifactMetadataV1 {
  readonly schemaVersion: 1;
  readonly handleId: VerificationHandleId;
  readonly journeyId: JourneyId;
  readonly provider: "gmail_api_v1";
  readonly recipientBindingId: RecipientBindingId;
  readonly target: TargetIdentityV1;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: VerificationArtifactState;
}

export type AvailableVerificationArtifact = VerificationArtifactMetadataV1 & {
  readonly state: "available";
};

export interface VerificationArtifactInspectRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly handleId: VerificationHandleId;
  readonly expectedRecipientBindingId: RecipientBindingId;
  readonly expectedTarget: TargetIdentityV1;
}

export interface VerificationArtifactInvalidateRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly handleId: VerificationHandleId;
}

export interface VerificationNavigationRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly sessionId: LiveSessionId;
  readonly expectedRecipientBindingId: RecipientBindingId;
  readonly expectedTarget: TargetIdentityV1;
  readonly now: string;
  readonly artifact: AvailableVerificationArtifact;
}

export type VerificationNavigationResult =
  | { readonly kind: "navigated" }
  | { readonly kind: "target_unavailable" };

export type VerificationArtifactErrorCode =
  | "mailbox_query_invalid"
  | "verification_artifact_replayed";

export type VerificationNavigationErrorCode =
  | "verification_navigation_denied"
  | "verification_artifact_replayed"
  | "browser_timeout"
  | "browser_effect_uncertain";

export type LiveCheckpointPhase =
  | "preflight"
  | "account_access"
  | "mailbox_verification"
  | "verification_navigation"
  | "live_application"
  | "recovery"
  | "review";

export interface LiveCheckpointV1 {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly checkpointId: CheckpointId;
  readonly revisionId: LiveRevisionId;
  readonly phase: LiveCheckpointPhase;
  readonly target: TargetIdentityV1;
  readonly sessionId: LiveSessionId | null;
  readonly profileLeaseId: ProfileLeaseId | null;
  readonly verificationHandle: VerificationHandleId | null;
  readonly leaseExpiresAt: string;
}

export interface LiveCheckpointLoadRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly expectedRevisionId: LiveRevisionId;
}

export interface LiveCheckpointSaveRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly checkpoint: LiveCheckpointV1;
}

export interface LiveCheckpointRemoveRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly checkpointId: CheckpointId;
}

export type LiveCheckpointErrorCode =
  | "recovery_checkpoint_invalid"
  | "recovery_checkpoint_unavailable"
  | "recovery_state_ambiguous"
  | "recovery_target_mismatch"
  | "recovery_checkpoint_cleanup_failed";

export interface LiveEvidenceSealV1 {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly evidenceId: LiveEvidenceId;
  readonly manifestId: ManifestId;
  readonly recordCount: number;
  readonly sealedAt: string;
}

export interface LiveEvidenceSealRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly manifestId: ManifestId;
  readonly admittedRecordIds: readonly LiveIdentifier<"admitted_record">[];
}

export interface LiveEvidenceCleanupRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
}

export type LiveEvidenceErrorCode =
  | "evidence_denied"
  | "evidence_limit_exceeded"
  | "evidence_unavailable"
  | "evidence_root_invalid"
  | "evidence_root_cleanup_failed"
  | "acceptance_evidence_cleanup_failed";
