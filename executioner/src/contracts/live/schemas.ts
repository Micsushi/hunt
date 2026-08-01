function opaqueIdentifier(prefix: string) {
  return {
    type: "string",
    minLength: prefix.length + 17,
    maxLength: prefix.length + 65,
    pattern: `^${prefix}_[A-Za-z0-9_-]{16,64}$`,
  } as const;
}

const journeyIdentifier = {
  type: "string",
  pattern: "^journey_[A-Za-z0-9_-]{16,64}$",
} as const;

const timestamp = {
  type: "string",
  format: "date-time",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
} as const;

const receivedTimeBucket = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z$",
} as const;

function closed<
  const Required extends readonly string[],
  const Properties extends Readonly<Record<string, unknown>>,
>(required: Required, properties: Properties) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  } as const;
}

const targetIdentity = closed(
  ["schemaVersion", "atsFamily", "hostId", "tenantId", "postingId"],
  {
    schemaVersion: { const: 1 },
    atsFamily: { const: "workday" },
    hostId: opaqueIdentifier("host"),
    tenantId: opaqueIdentifier("tenant"),
    postingId: opaqueIdentifier("posting"),
  },
);

export const liveContractSchemas = {
  targetIdentity,
  persistentBrowserSession: closed(
    [
      "schemaVersion",
      "journeyId",
      "sessionId",
      "profileLeaseId",
      "target",
      "leaseExpiresAt",
    ],
    {
      schemaVersion: { const: 1 },
      journeyId: journeyIdentifier,
      sessionId: opaqueIdentifier("live_session"),
      profileLeaseId: opaqueIdentifier("profile_lease"),
      target: targetIdentity,
      leaseExpiresAt: timestamp,
    },
  ),
  secretHandleMetadata: {
    ...closed(
      [
        "schemaVersion",
        "handleId",
        "journeyId",
        "provider",
        "purpose",
        "consumer",
        "issuedAt",
        "expiresAt",
        "state",
      ],
      {
        schemaVersion: { const: 1 },
        handleId: opaqueIdentifier("secret_handle"),
        journeyId: journeyIdentifier,
        provider: { const: "windows_dpapi_current_user_v1" },
        purpose: { enum: ["account_credentials", "gmail_oauth"] },
        consumer: {
          enum: ["credential_mutation_adapter", "gmail_auth_executor"],
        },
        issuedAt: timestamp,
        expiresAt: timestamp,
        state: { enum: ["active", "expired", "revoked"] },
      },
    ),
    allOf: [
      {
        if: { properties: { purpose: { const: "account_credentials" } } },
        then: {
          properties: { consumer: { const: "credential_mutation_adapter" } },
        },
      },
      {
        if: { properties: { purpose: { const: "gmail_oauth" } } },
        then: { properties: { consumer: { const: "gmail_auth_executor" } } },
      },
    ],
  },
  credentialMutationResult: {
    ...closed(
      ["kind", "attemptedFields"],
      {
        kind: {
          enum: [
            "existing_account",
            "create_account",
            "verification_required",
            "application_ready",
            "manual_intervention",
          ],
        },
        reason: { enum: ["captcha", "mfa", "access_control"] },
        attemptedFields: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          prefixItems: [{ const: "email" }, { const: "password" }],
        },
      },
    ),
    allOf: [
      {
        if: { properties: { kind: { const: "manual_intervention" } } },
        then: { required: ["reason"] },
        else: { not: { required: ["reason"] } },
      },
    ],
  },
  mailboxPollResult: {
    ...closed(
      [
        "provider",
        "receivedTimeBucket",
        "expiresAt",
        "candidateCount",
        "verificationHandle",
      ],
      {
        provider: { const: "gmail_api_v1" },
        receivedTimeBucket: {
          oneOf: [receivedTimeBucket, { type: "null" }],
        },
        expiresAt: { oneOf: [timestamp, { type: "null" }] },
        candidateCount: { type: "integer", minimum: 0 },
        verificationHandle: {
          oneOf: [opaqueIdentifier("verification_handle"), { type: "null" }],
        },
      },
    ),
    allOf: [
      {
        if: { properties: { candidateCount: { const: 1 } } },
        then: {
          properties: {
            receivedTimeBucket,
            expiresAt: timestamp,
          },
        },
        else: { properties: { verificationHandle: { type: "null" } } },
      },
    ],
  },
  verificationArtifact: closed(
    [
      "schemaVersion",
      "handleId",
      "journeyId",
      "provider",
      "recipientBindingId",
      "target",
      "issuedAt",
      "expiresAt",
      "state",
    ],
    {
      schemaVersion: { const: 1 },
      handleId: opaqueIdentifier("verification_handle"),
      journeyId: journeyIdentifier,
      provider: { const: "gmail_api_v1" },
      recipientBindingId: opaqueIdentifier("recipient"),
      target: targetIdentity,
      issuedAt: timestamp,
      expiresAt: timestamp,
      state: { enum: ["available", "expired", "consumed", "invalidated"] },
    },
  ),
  liveCheckpoint: {
    ...closed(
      [
        "schemaVersion",
        "journeyId",
        "checkpointId",
        "revisionId",
        "phase",
        "target",
        "sessionId",
        "profileLeaseId",
        "verificationHandle",
        "leaseExpiresAt",
      ],
      {
      schemaVersion: { const: 1 },
      journeyId: journeyIdentifier,
      checkpointId: opaqueIdentifier("checkpoint"),
      revisionId: opaqueIdentifier("revision"),
      phase: {
        enum: [
          "preflight",
          "account_access",
          "mailbox_verification",
          "verification_navigation",
          "live_application",
          "recovery",
          "review",
        ],
      },
      target: targetIdentity,
      sessionId: {
        oneOf: [opaqueIdentifier("live_session"), { type: "null" }],
      },
      profileLeaseId: {
        oneOf: [opaqueIdentifier("profile_lease"), { type: "null" }],
      },
      verificationHandle: {
        oneOf: [opaqueIdentifier("verification_handle"), { type: "null" }],
      },
      leaseExpiresAt: timestamp,
      },
    ),
    allOf: [
      {
        if: {
          properties: {
            phase: { enum: ["mailbox_verification", "live_application"] },
          },
        },
        then: {
          properties: {
            sessionId: opaqueIdentifier("live_session"),
            profileLeaseId: opaqueIdentifier("profile_lease"),
          },
        },
      },
    ],
  },
  liveEvidence: closed(
    [
      "schemaVersion",
      "journeyId",
      "evidenceId",
      "manifestId",
      "recordCount",
      "sealedAt",
    ],
    {
      schemaVersion: { const: 1 },
      journeyId: journeyIdentifier,
      evidenceId: opaqueIdentifier("live_evidence"),
      manifestId: opaqueIdentifier("manifest"),
      recordCount: { type: "integer", minimum: 0 },
      sealedAt: timestamp,
    },
  ),
} as const;

export const liveContractVersions = {
  targetIdentity: 1,
  persistentBrowserSession: 1,
  secretHandleMetadata: 1,
  mailboxPollResult: 1,
  verificationArtifact: 1,
  liveCheckpoint: 1,
  liveEvidence: 1,
} as const;
