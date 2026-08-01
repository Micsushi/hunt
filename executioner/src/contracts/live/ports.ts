import type {
  CredentialMutationErrorCode,
  CredentialMutationRequest,
  CredentialMutationResult,
  GmailAuthErrorCode,
  LiveBrowserSessionV1,
  LiveCheckpointErrorCode,
  LiveCheckpointLoadRequest,
  LiveCheckpointRemoveRequest,
  LiveCheckpointSaveRequest,
  LiveCheckpointV1,
  LiveEvidenceCleanupRequest,
  LiveEvidenceErrorCode,
  LiveEvidenceSealRequest,
  LiveEvidenceSealV1,
  LivePortResult,
  MailboxPollRequest,
  MailboxPollResultV1,
  MailboxProviderErrorCode,
  PersistentBrowserCloseRequest,
  PersistentBrowserErrorCode,
  PersistentBrowserOpenRequest,
  PersistentBrowserOpenResult,
  PersistentBrowserReconcileRequest,
  PersistentBrowserReconcileResult,
  PrivilegedGmailQueryRequest,
  SecretHandleMetadataV1,
  SecretInspectRequest,
  SecretRevokeRequest,
  SecretStoreErrorCode,
  VerificationArtifactErrorCode,
  VerificationArtifactInspectRequest,
  VerificationArtifactInvalidateRequest,
  VerificationArtifactMetadataV1,
  VerificationNavigationErrorCode,
  VerificationNavigationRequest,
  VerificationNavigationResult,
} from "./types.ts";

export const livePortNames = [
  "PersistentBrowserSession",
  "SecretStore",
  "CredentialMutationAdapter",
  "PrivilegedGmailAuthExecutor",
  "MailboxProvider",
  "VerificationArtifact",
  "PrivilegedVerificationNavigator",
  "LiveCheckpointStore",
  "LiveEvidenceSink",
] as const;

export const livePortCancellationPolicy = {
  signal: "required",
  owner: "caller",
  resultCode: "operation_cancelled",
  retryable: false,
} as const;

export const livePortEffectCancellationPolicy = {
  beforeEffect: "operation_cancelled",
  persistentBrowserAfterPossibleEffect: "browser_effect_uncertain",
  credentialMutationAfterPossibleEffect: "credential_effect_uncertain",
  verificationNavigationAfterPossibleEffect: "browser_effect_uncertain",
} as const;

export interface PersistentBrowserSession {
  open(
    request: PersistentBrowserOpenRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<PersistentBrowserOpenResult, PersistentBrowserErrorCode>>;
  reconcile(
    request: PersistentBrowserReconcileRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<PersistentBrowserReconcileResult, PersistentBrowserErrorCode>>;
  close(
    request: PersistentBrowserCloseRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
}

export interface SecretStore {
  inspect(
    request: SecretInspectRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<SecretHandleMetadataV1, SecretStoreErrorCode>>;
  revoke(
    request: SecretRevokeRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, SecretStoreErrorCode>>;
}

export interface CredentialMutationAdapter {
  mutate(
    request: CredentialMutationRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<CredentialMutationResult, CredentialMutationErrorCode>>;
}

export interface PrivilegedGmailAuthExecutor {
  query(
    request: PrivilegedGmailQueryRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<MailboxPollResultV1, GmailAuthErrorCode>>;
}

export interface MailboxProvider {
  poll(
    request: MailboxPollRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<MailboxPollResultV1, MailboxProviderErrorCode | GmailAuthErrorCode>>;
}

export interface VerificationArtifact {
  inspect(
    request: VerificationArtifactInspectRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<VerificationArtifactMetadataV1, VerificationArtifactErrorCode>>;
  invalidate(
    request: VerificationArtifactInvalidateRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, VerificationArtifactErrorCode>>;
}

export interface PrivilegedVerificationNavigator {
  navigate(
    request: VerificationNavigationRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<VerificationNavigationResult, VerificationNavigationErrorCode>>;
}

export interface LiveCheckpointStore {
  load(
    request: LiveCheckpointLoadRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<LiveCheckpointV1 | null, LiveCheckpointErrorCode>>;
  save(
    request: LiveCheckpointSaveRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<LiveCheckpointV1, LiveCheckpointErrorCode>>;
  remove(
    request: LiveCheckpointRemoveRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, LiveCheckpointErrorCode>>;
}

export interface LiveEvidenceSink {
  seal(
    request: LiveEvidenceSealRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<LiveEvidenceSealV1, LiveEvidenceErrorCode>>;
  cleanupPartials(
    request: LiveEvidenceCleanupRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, LiveEvidenceErrorCode>>;
}

export type { LiveBrowserSessionV1 };
