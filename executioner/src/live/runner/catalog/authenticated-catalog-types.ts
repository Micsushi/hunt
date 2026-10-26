export type AccountHistory = "fresh_candidate" | "historical_realm";
export type VerificationRequirement = "yes" | "no" | "unknown";
export type VerificationMethod = "email_link" | "email_code" | "none" | "unknown";
export type VerificationResult =
  | "verified"
  | "not_required"
  | "not_found"
  | "ambiguous"
  | "expired"
  | "unsupported_code"
  | "navigation_failed"
  | "unknown";
export type BrowserClassification =
  | "application_ready"
  | "posting_unavailable"
  | "maintenance"
  | "runtime_error"
  | "account_entry"
  | "verification_required"
  | "manual_action_required"
  | "unknown";

export interface AuthenticatedCatalogJobV1 {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly catalogRow: number;
  readonly companyName: string;
  readonly jobName: string;
  readonly country: string;
  readonly targetUrl: string;
  readonly accountRealm: string;
  readonly accountHistory: AccountHistory;
  readonly shard: number;
  readonly verificationRequired: "unknown";
  readonly status: "pending";
}

export interface AuthenticatedCatalogPlanV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly catalogSha256: string;
  readonly historySha256: string;
  readonly catalogCount: number;
  readonly historicalRealmCount: number;
  readonly freshCandidateCount: number;
  readonly shardCount: number;
  readonly jobs: readonly AuthenticatedCatalogJobV1[];
}

export interface AuthenticatedCatalogFindingV1 {
  readonly severity: "minor" | "major";
  readonly phase:
    | "account_entry"
    | "mailbox"
    | "verification_navigation"
    | "post_verification_sign_in"
    | "application_entry"
    | "monitoring";
  readonly code:
    | "page_misclassification"
    | "account_flow_misclassification"
    | "mailbox_misclassification"
    | "wrong_value_typed"
    | "wrong_click"
    | "missed_click"
    | "verification_not_detected"
     | "verification_delay"
     | "wrong_verification_parameters"
     | "navigation_misclassification"
     | "monitor_ack_missing"
     | "unexpected_wait"
    | "other";
  readonly summary: string;
}

export interface AuthenticatedCatalogResultV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly jobId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: "application_reached" | "blocked" | "failed";
  readonly observedAccountFlow: "fresh_create" | "existing_sign_in" | "already_ready" | "unknown";
  readonly verificationRequired: VerificationRequirement;
  readonly verificationMethod: VerificationMethod;
  readonly verificationResult: VerificationResult;
  readonly postVerificationSignIn:
    | "required_succeeded"
    | "required_failed"
    | "not_required"
    | "unknown";
  readonly applicationPageReached: boolean;
  readonly c3PageClassification: BrowserClassification;
  readonly independentBrowserClassification: BrowserClassification;
  readonly classificationAgreement: "match" | "minor_mismatch" | "major_mismatch" | "unknown";
  readonly timingsMs: {
    readonly accountEntry: number;
    readonly mailboxWait: number;
    readonly verificationNavigation: number;
    readonly postVerificationSignIn: number;
    readonly total: number;
  };
  readonly findings: readonly AuthenticatedCatalogFindingV1[];
  readonly evidence: {
    readonly acceptanceSha256: string | null;
    readonly monitorAckSha256: string | null;
    readonly screenshotSha256: string | null;
  };
}

export interface CompiledAuthenticatedCatalogResults {
  readonly csv: string;
  readonly summary: {
    readonly schemaVersion: 1;
    readonly runId: string;
    readonly expected: number;
    readonly completed: number;
    readonly verificationRequired: number;
    readonly applicationReached: number;
    readonly minorFindings: number;
    readonly majorFindings: number;
  };
}
