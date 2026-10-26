export type RealRunAccountMode = "fresh_create" | "sign_in";

export interface ExternalRootV1 {
  readonly rootId: string;
  readonly path: string;
  readonly access: "current_user_only";
}

export interface ApprovedTargetV1 {
  readonly handleId: string;
  readonly url: string;
  readonly host: string;
  readonly tenant: string;
  readonly posting: string;
}

export interface OwnerApprovalV1 {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly revisionId: string;
  readonly approved: true;
  readonly liveAccess: true;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly ownerId: string;
  readonly runtimeOperatorId: string;
  readonly secretCustodianId: string;
  readonly evidenceCustodianId: string;
}

export interface ScopedSecretReferenceV1 {
  readonly schemaVersion: 1;
  readonly handleId: string;
  readonly journeyId: string;
  readonly provider: "windows-dpapi-current-user-v1";
  readonly purpose: "account_credentials" | "gmail_oauth";
  readonly consumer: "credential_mutation_adapter" | "gmail_auth_executor";
  readonly scope: "account_access" | "mailbox_verification";
  readonly expiresAt: string;
}

export interface RealRunOwnerInputsV1 {
  readonly schemaVersion: 1;
  readonly contractRevision: "s2-owner-inputs-v1";
  readonly revisionId: string;
  readonly journeyId: string;
  readonly accountMode: RealRunAccountMode;
  readonly target: ApprovedTargetV1;
  readonly profileRef: string;
  readonly resumeRef: string;
  readonly recipientBindingId: string;
  readonly roots: {
    readonly runtime: ExternalRootV1;
    readonly secrets: ExternalRootV1;
    readonly evidence: ExternalRootV1;
  };
  readonly policy: {
    readonly cleanupLeaseHours: 24;
    readonly retentionDays: 30;
  };
  readonly approval: OwnerApprovalV1;
  readonly adapters: {
    readonly secretStore: "windows-dpapi-current-user-v1";
    readonly mailboxProvider: "gmail-api-v1";
  };
  readonly accountSecret: ScopedSecretReferenceV1 & {
    readonly purpose: "account_credentials";
    readonly consumer: "credential_mutation_adapter";
    readonly scope: "account_access";
  };
  readonly gmailAuthorization: ScopedSecretReferenceV1 & {
    readonly purpose: "gmail_oauth";
    readonly consumer: "gmail_auth_executor";
    readonly scope: "mailbox_verification";
  };
}

export interface PreflightContext {
  readonly now: string;
  readonly forbiddenRoots: readonly string[];
}

export type PreflightFailureCode =
  | "owner_config_invalid"
  | "runtime_root_invalid"
  | "secret_root_invalid"
  | "evidence_root_invalid";

export interface RealRunPreflightReportV1 {
  readonly schemaVersion: 1;
  readonly kind: "ready";
  readonly contractRevision: "s2-owner-inputs-v1";
  readonly revisionId: string;
  readonly journeyId: string;
  readonly accountMode: RealRunAccountMode;
  readonly approvalId: string;
  readonly targetHandleId: string;
  readonly profileRef: string;
  readonly resumeRef: string;
  readonly recipientBindingId: string;
  readonly rootIds: {
    readonly runtime: string;
    readonly secrets: string;
    readonly evidence: string;
  };
  readonly secretHandleIds: {
    readonly account: string;
    readonly gmail: string;
  };
  readonly adapters: {
    readonly secretStore: "windows-dpapi-current-user-v1";
    readonly mailboxProvider: "gmail-api-v1";
  };
  readonly cleanupLeaseHours: 24;
  readonly retentionDays: 30;
  readonly approvedTargetDimensions: readonly ["host", "tenant", "posting"];
}

export type RealRunPreflightResult =
  | { readonly ok: true; readonly report: RealRunPreflightReportV1 }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: PreflightFailureCode;
        readonly dimension: string;
      };
    };
