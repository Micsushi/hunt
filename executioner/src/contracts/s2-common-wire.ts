import {
  phaseIds,
  stableErrorPolicy,
  type ComponentId,
  type EventId,
  type EventKind,
  type FactualTerminalOutcome,
  type JourneyId,
  type JourneyProgress,
  type McpRequestId,
  type OperationId,
  type PhaseId,
  type QuestionId,
  type SourceReference,
  type StepId,
} from "./types.ts";

export const s2NewComponentIds = [
  "S2_PREFLIGHT",
  "S2_SECRET_STORE",
  "S2_CREDENTIAL_MUTATION",
  "S2_GMAIL_AUTH",
  "S2_MAILBOX_PROVIDER",
  "S2_VERIFICATION_NAVIGATOR",
  "S2_RECOVERY_CHECKPOINT",
] as const;

export type S2ComponentId = (typeof s2NewComponentIds)[number];
export type S2CommonComponentId = ComponentId | S2ComponentId;

export const s2CommonComponentIds = [
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  ...s2NewComponentIds,
] as const satisfies readonly S2CommonComponentId[];

export const s2NewPhaseIds = [
  "preflight",
  "account_access",
  "mailbox_verification",
  "verification_navigation",
  "live_application",
  "recovery",
  "review",
] as const;

export type S2PhaseId = (typeof s2NewPhaseIds)[number];
export type S2CommonPhaseId = PhaseId | S2PhaseId;

export const s2CommonPhaseIds = [
  ...phaseIds,
  ...s2NewPhaseIds,
] as const satisfies readonly S2CommonPhaseId[];

export const s2StableErrorPolicy = {
  ...stableErrorPolicy,
  runtime_root_invalid: { owner: "S2_PREFLIGHT", retryable: false },
  runtime_root_cleanup_failed: { owner: "S2_PREFLIGHT", retryable: false },
  owner_config_invalid: { owner: "S2_PREFLIGHT", retryable: false },
  owner_config_cleanup_failed: { owner: "S2_PREFLIGHT", retryable: false },
  secret_root_invalid: { owner: "S2_SECRET_STORE", retryable: false },
  secret_root_cleanup_failed: { owner: "S2_SECRET_STORE", retryable: false },
  secret_handle_invalid: { owner: "S2_SECRET_STORE", retryable: false },
  secret_handle_expired: { owner: "S2_SECRET_STORE", retryable: false },
  secret_handle_mismatched: { owner: "S2_SECRET_STORE", retryable: false },
  secret_consumer_forbidden: { owner: "S2_SECRET_STORE", retryable: false },
  secret_store_unavailable: { owner: "S2_SECRET_STORE", retryable: true },
  account_secret_cleanup_failed: { owner: "S2_SECRET_STORE", retryable: false },
  gmail_oauth_secret_cleanup_failed: {
    owner: "S2_SECRET_STORE",
    retryable: false,
  },
  credential_mutation_denied: {
    owner: "S2_CREDENTIAL_MUTATION",
    retryable: false,
  },
  credential_effect_uncertain: {
    owner: "S2_CREDENTIAL_MUTATION",
    retryable: false,
  },
  gmail_auth_denied: { owner: "S2_GMAIL_AUTH", retryable: false },
  gmail_rate_limited: { owner: "S2_GMAIL_AUTH", retryable: true },
  gmail_network_unavailable: { owner: "S2_GMAIL_AUTH", retryable: true },
  mailbox_query_invalid: { owner: "S2_MAILBOX_PROVIDER", retryable: false },
  mailbox_timeout: { owner: "S2_MAILBOX_PROVIDER", retryable: true },
  verification_artifact_replayed: {
    owner: "S2_MAILBOX_PROVIDER",
    retryable: false,
  },
  verification_navigation_denied: {
    owner: "S2_VERIFICATION_NAVIGATOR",
    retryable: false,
  },
  recovery_checkpoint_invalid: {
    owner: "S2_RECOVERY_CHECKPOINT",
    retryable: false,
  },
  recovery_checkpoint_unavailable: {
    owner: "S2_RECOVERY_CHECKPOINT",
    retryable: true,
  },
  recovery_state_ambiguous: {
    owner: "S2_RECOVERY_CHECKPOINT",
    retryable: false,
  },
  recovery_target_mismatch: {
    owner: "S2_RECOVERY_CHECKPOINT",
    retryable: false,
  },
  recovery_checkpoint_cleanup_failed: {
    owner: "S2_RECOVERY_CHECKPOINT",
    retryable: false,
  },
  browser_profile_cleanup_failed: { owner: "F3", retryable: false },
  resume_capture_cleanup_failed: { owner: "F4", retryable: false },
  answer_provenance_invalid: { owner: "F6", retryable: false },
  evidence_root_invalid: { owner: "F11", retryable: false },
  evidence_root_cleanup_failed: { owner: "F11", retryable: false },
  acceptance_evidence_cleanup_failed: { owner: "F11", retryable: false },
} as const;

export type S2StableErrorCode = keyof typeof s2StableErrorPolicy;
type S2ErrorPolicy<C extends S2StableErrorCode> =
  (typeof s2StableErrorPolicy)[C];

export interface VerifiedCauseV3 {
  readonly verification: "verified";
  readonly code: S2StableErrorCode;
  readonly source: SourceReference;
}

export type ErrorEnvelopeV3 = {
  readonly [C in S2StableErrorCode]: {
    readonly schemaVersion: 3;
    readonly code: C;
    readonly component: S2ErrorPolicy<C>["owner"];
    readonly phase: S2CommonPhaseId;
    readonly step: StepId;
    readonly retryable: S2ErrorPolicy<C>["retryable"];
    readonly source: SourceReference;
    readonly cause?: VerifiedCauseV3;
  };
}[S2StableErrorCode];

export interface EventEnvelopeV3 {
  readonly schemaVersion: 3;
  readonly eventId: EventId;
  readonly journeyId: JourneyId;
  readonly component: S2CommonComponentId;
  readonly phase: S2CommonPhaseId;
  readonly step: StepId;
  readonly kind: EventKind;
  readonly at: string;
  readonly source: SourceReference;
}

export type S2FactualTerminalOutcome =
  | {
      readonly source: "target_identity";
      readonly result:
        | {
            readonly kind: "target_mismatch";
            readonly dimension: "host" | "tenant" | "posting";
          }
        | { readonly kind: "target_ambiguous" }
        | {
            readonly kind: "posting_unavailable";
            readonly reason: "not_found" | "closed" | "removed" | "unavailable" | "maintenance" | "runtime_error";
          };
    }
  | {
      readonly source: "account_access";
      readonly result: {
        readonly kind: "manual_intervention";
        readonly reason: "captcha" | "mfa" | "access_control";
      };
    }
  | {
      readonly source: "mailbox_verification";
      readonly result: {
        readonly kind:
          | "mailbox_none"
          | "mailbox_ambiguous"
          | "mailbox_expired"
          | "mailbox_consumed";
      };
    }
  | {
      readonly source: "verification_navigation";
      readonly result: { readonly kind: "verification_target_unavailable" };
    }
  | {
      readonly source: "ats_family";
      readonly result: {
        readonly kind: "ats_unsupported" | "ats_unknown" | "ats_ambiguous";
      };
    }
  | {
      readonly source: "workday_page_type";
      readonly result: {
        readonly kind: "workday_page_unknown" | "workday_page_ambiguous";
      };
    }
  | {
      readonly source: "ui_behavior";
      readonly result:
        | { readonly kind: "ui_behavior_unknown" | "ui_behavior_ambiguous" }
        | { readonly kind: "ui_variant_unreviewed"; readonly variantId: string };
    }
  | {
      readonly source: "question_classification";
      readonly result: {
        readonly kind: "question_unknown" | "question_ambiguous";
      };
    }
  | {
      readonly source: "answer_resolution";
      readonly result: {
        readonly kind: "answer_type_unknown" | "answer_type_ambiguous";
        readonly questionId: QuestionId;
      };
    };

export type FactualTerminalOutcomeV4 =
  | FactualTerminalOutcome
  | S2FactualTerminalOutcome;

export type TerminalResultV4 =
  | {
      readonly schemaVersion: 4;
      readonly journeyId: JourneyId;
      readonly status: "review_reached" | "cancelled";
      readonly completedPages: number;
    }
  | {
      readonly schemaVersion: 4;
      readonly journeyId: JourneyId;
      readonly status: "failed";
      readonly completedPages: number;
      readonly errorCode: S2StableErrorCode;
    }
  | {
      readonly schemaVersion: 4;
      readonly journeyId: JourneyId;
      readonly status: "blocked";
      readonly completedPages: number;
      readonly factualOutcome: FactualTerminalOutcomeV4;
    };

export type McpResultV4 =
  | {
      readonly kind: "accepted";
      readonly operationId: OperationId;
      readonly journeyId: JourneyId;
    }
  | { readonly kind: "status"; readonly progress: JourneyProgress }
  | { readonly kind: "terminal"; readonly terminal: TerminalResultV4 };

export type McpResponseV4 =
  | {
      readonly schemaVersion: 4;
      readonly requestId: McpRequestId;
      readonly ok: true;
      readonly result: McpResultV4;
    }
  | {
      readonly schemaVersion: 4;
      readonly requestId: McpRequestId;
      readonly ok: false;
      readonly error: ErrorEnvelopeV3;
    };
