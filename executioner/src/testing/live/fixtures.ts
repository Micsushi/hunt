import {
  generatedOperationId,
  journeyId,
} from "../../contracts/index.ts";
import type {
  ActiveAccountSecretHandle,
  ActiveGmailSecretHandle,
  AvailableVerificationArtifact,
  CheckpointId,
  LiveBrowserSessionV1,
  LiveCheckpointV1,
  LiveEvidenceId,
  LiveEvidenceSealV1,
  LiveIdentifier,
  LiveRevisionId,
  LiveSessionId,
  MailboxPollRequest,
  MailboxPollResultV1,
  ManifestId,
  ProfileLeaseId,
  RecipientBindingId,
  SecretHandleId,
  SecretHandleMetadataV1,
  TargetHostId,
  TargetIdentityV1,
  TargetPostingId,
  TargetTenantId,
  VerificationArtifactMetadataV1,
  VerificationHandleId,
} from "../../contracts/live/index.ts";

const opaque = <Kind extends string>(value: string) =>
  value as LiveIdentifier<Kind>;

const target: TargetIdentityV1 = {
  schemaVersion: 1,
  atsFamily: "workday",
  hostId: opaque<"host">("host_0123456789abcdef") as TargetHostId,
  tenantId: opaque<"tenant">("tenant_0123456789abcdef") as TargetTenantId,
  postingId: opaque<"posting">("posting_0123456789abcdef") as TargetPostingId,
};

const otherTarget: TargetIdentityV1 = {
  ...target,
  hostId: opaque<"host">("host_fedcba9876543210") as TargetHostId,
  tenantId: opaque<"tenant">("tenant_fedcba9876543210") as TargetTenantId,
  postingId: opaque<"posting">("posting_fedcba9876543210") as TargetPostingId,
};

const primaryJourneyId = journeyId("journey_0123456789abcdef");
const otherJourneyId = journeyId("journey_fedcba9876543210");
const issuedAt = "2026-08-01T12:00:00.000Z";
const expiresAt = "2026-08-02T12:00:00.000Z";
const pastAt = "2026-07-31T12:00:00.000Z";
const sessionId = opaque<"live_session">(
  "live_session_0123456789abcdef",
) as LiveSessionId;
const profileLeaseId = opaque<"profile_lease">(
  "profile_lease_0123456789abcdef",
) as ProfileLeaseId;
const accountSecret: ActiveAccountSecretHandle = {
  schemaVersion: 1,
  handleId: opaque<"secret_handle">(
    "secret_handle_0123456789abcdef",
  ) as SecretHandleId,
  journeyId: primaryJourneyId,
  provider: "windows_dpapi_current_user_v1",
  purpose: "account_credentials",
  consumer: "credential_mutation_adapter",
  issuedAt,
  expiresAt,
  state: "active",
};
const gmailSecret: ActiveGmailSecretHandle = {
  ...accountSecret,
  handleId: opaque<"secret_handle">(
    "secret_handle_fedcba9876543210",
  ) as SecretHandleId,
  purpose: "gmail_oauth",
  consumer: "gmail_auth_executor",
};
const verificationHandle = opaque<"verification_handle">(
  "verification_handle_0123456789abcdef",
) as VerificationHandleId;
const recipientBindingId = opaque<"recipient">(
  "recipient_0123456789abcdef",
) as RecipientBindingId;

const session: LiveBrowserSessionV1 = {
  schemaVersion: 1,
  journeyId: primaryJourneyId,
  sessionId,
  profileLeaseId,
  target,
  leaseExpiresAt: expiresAt,
};

const mailboxAvailable: MailboxPollResultV1 = {
  provider: "gmail_api_v1",
  receivedTimeBucket: "2026-08-01T12:05Z",
  expiresAt,
  candidateCount: 1,
  verificationHandle,
};

const verificationArtifact: AvailableVerificationArtifact = {
  schemaVersion: 1,
  handleId: verificationHandle,
  journeyId: primaryJourneyId,
  provider: "gmail_api_v1",
  recipientBindingId,
  target,
  issuedAt,
  expiresAt,
  state: "available",
};

const checkpoint: LiveCheckpointV1 = {
  schemaVersion: 1,
  journeyId: primaryJourneyId,
  checkpointId: opaque<"checkpoint">(
    "checkpoint_0123456789abcdef",
  ) as CheckpointId,
  revisionId: opaque<"revision">(
    "revision_0123456789abcdef",
  ) as LiveRevisionId,
  phase: "account_access",
  target,
  sessionId,
  profileLeaseId,
  verificationHandle: null,
  leaseExpiresAt: expiresAt,
};

const evidenceSeal: LiveEvidenceSealV1 = {
  schemaVersion: 1,
  journeyId: primaryJourneyId,
  evidenceId: opaque<"live_evidence">(
    "live_evidence_0123456789abcdef",
  ) as LiveEvidenceId,
  manifestId: opaque<"manifest">(
    "manifest_0123456789abcdef",
  ) as ManifestId,
  recordCount: 1,
  sealedAt: issuedAt,
};

const mailboxPollRequest: MailboxPollRequest = {
  schemaVersion: 1,
  journeyId: primaryJourneyId,
  queryId: opaque<"mailbox_query">("mailbox_query_0123456789abcdef"),
  recipientBindingId,
  target,
  notBefore: issuedAt,
  notAfter: expiresAt,
};

export const liveFixtures = {
  journeyId: primaryJourneyId,
  otherJourneyId,
  issuedAt,
  expiresAt,
  pastAt,
  target,
  otherTarget,
  session,
  accountSecret,
  gmailSecret,
  mailboxAvailable,
  mailboxPollRequest,
  verificationArtifact,
  checkpoint,
  evidenceSeal,
  secretInspectRequest: {
    schemaVersion: 1,
    journeyId: primaryJourneyId,
    handleId: accountSecret.handleId,
    expectedPurpose: "account_credentials",
    expectedConsumer: "credential_mutation_adapter",
  },
  operationIds: {
    browserOpen: generatedOperationId("operation_0000000000000001"),
    browserReconcile: generatedOperationId("operation_0000000000000002"),
    browserClose: generatedOperationId("operation_0000000000000003"),
    secretRevoke: generatedOperationId("operation_0000000000000004"),
    credentialMutation: generatedOperationId("operation_0000000000000005"),
    artifactInvalidate: generatedOperationId("operation_0000000000000006"),
    verificationNavigation: generatedOperationId("operation_0000000000000007"),
    checkpointSave: generatedOperationId("operation_0000000000000008"),
    checkpointRemove: generatedOperationId("operation_0000000000000009"),
    evidenceSeal: generatedOperationId("operation_0000000000000010"),
    evidenceCleanup: generatedOperationId("operation_0000000000000011"),
  },
  mailboxFactualResults: [
    {
      provider: "gmail_api_v1",
      receivedTimeBucket: null,
      expiresAt: null,
      candidateCount: 0,
      verificationHandle: null,
    },
    {
      provider: "gmail_api_v1",
      receivedTimeBucket: "2026-08-01T12:05Z",
      expiresAt,
      candidateCount: 2,
      verificationHandle: null,
    },
    mailboxAvailable,
  ] as const satisfies readonly MailboxPollResultV1[],
  artifactFactualStates: ["available", "expired", "consumed", "invalidated"] as const,
  publicSnapshot: {
    session,
    accountSecret,
    gmailSecret,
    mailboxAvailable,
    verificationArtifact,
    checkpoint,
    evidenceSeal,
  },
} as const;

export type UnsafeSyntheticSecretMetadata = SecretHandleMetadataV1 & {
  readonly provider: string;
};
