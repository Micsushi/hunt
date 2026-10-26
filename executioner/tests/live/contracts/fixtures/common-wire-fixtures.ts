// Contract-only golden values; never import this fixture from production code.
export const journeyId = "journey_0123456789abcdef";
export const requestId = "request-1";
export const operationSource = {
  kind: "operation",
  id: "operation_0123456789abcdef",
} as const;

export const s1FactualOutcomeCases = [
  {
    source: "page_understanding",
    result: { kind: "unknown", pageId: "page-questionnaire" },
  },
  {
    source: "page_understanding",
    result: { kind: "ambiguous", pageId: "page-questionnaire" },
  },
  {
    source: "answer_resolution",
    result: {
      kind: "profile_answer_missing",
      questionId: "question-work-authorization",
    },
  },
  {
    source: "answer_resolution",
    result: { kind: "unsupported", fieldId: "field-sponsorship" },
  },
  {
    source: "answer_resolution",
    result: { kind: "option_no_match", questionId: "question-country" },
  },
  {
    source: "answer_resolution",
    result: { kind: "option_ambiguous", questionId: "question-country" },
  },
  {
    source: "verification",
    result: {
      kind: "rejected",
      fieldId: "field-country",
      reason: "mismatch",
    },
  },
  {
    source: "verification",
    result: {
      kind: "rejected",
      fieldId: "field-country",
      reason: "stale",
    },
  },
  {
    source: "verification",
    result: { kind: "ambiguous", fieldId: "field-country" },
  },
  {
    source: "verification",
    result: { kind: "unavailable", fieldId: "field-country" },
  },
] as const;

export const s2FactualOutcomeCases = [
  ...(["host", "tenant", "posting"] as const).map((dimension) => ({
    source: "target_identity" as const,
    result: { kind: "target_mismatch" as const, dimension },
  })),
  {
    source: "target_identity",
    result: { kind: "target_ambiguous" },
  },
  ...(["not_found", "closed", "removed", "unavailable", "maintenance", "runtime_error"] as const).map(
    (reason) => ({
      source: "target_identity" as const,
      result: { kind: "posting_unavailable" as const, reason },
    }),
  ),
  ...(["captcha", "mfa", "access_control"] as const).map((reason) => ({
    source: "account_access" as const,
    result: { kind: "manual_intervention" as const, reason },
  })),
  ...([
    "mailbox_none",
    "mailbox_ambiguous",
    "mailbox_expired",
    "mailbox_consumed",
  ] as const).map((kind) => ({
    source: "mailbox_verification" as const,
    result: { kind },
  })),
  {
    source: "verification_navigation",
    result: { kind: "verification_target_unavailable" },
  },
  ...(["ats_unsupported", "ats_unknown", "ats_ambiguous"] as const).map(
    (kind) => ({ source: "ats_family" as const, result: { kind } }),
  ),
  ...(["workday_page_unknown", "workday_page_ambiguous"] as const).map(
    (kind) => ({ source: "workday_page_type" as const, result: { kind } }),
  ),
  ...(["ui_behavior_unknown", "ui_behavior_ambiguous"] as const).map(
    (kind) => ({ source: "ui_behavior" as const, result: { kind } }),
  ),
  {
    source: "ui_behavior",
    result: { kind: "ui_variant_unreviewed", variantId: "variant-search-select" },
  },
  ...(["question_unknown", "question_ambiguous"] as const).map((kind) => ({
    source: "question_classification" as const,
    result: { kind },
  })),
  ...(["answer_type_unknown", "answer_type_ambiguous"] as const).map(
    (kind) => ({
      source: "answer_resolution" as const,
      result: { kind, questionId: "question-country" },
    }),
  ),
] as const;

export const s2ComponentIds = [
  "S2_PREFLIGHT",
  "S2_SECRET_STORE",
  "S2_CREDENTIAL_MUTATION",
  "S2_GMAIL_AUTH",
  "S2_MAILBOX_PROVIDER",
  "S2_VERIFICATION_NAVIGATOR",
  "S2_RECOVERY_CHECKPOINT",
] as const;

export const s2PhaseIds = [
  "preflight",
  "account_access",
  "mailbox_verification",
  "verification_navigation",
  "live_application",
  "recovery",
  "review",
] as const;

export const s2ErrorPolicyCases = {
  runtime_root_invalid: ["S2_PREFLIGHT", false],
  runtime_root_cleanup_failed: ["S2_PREFLIGHT", false],
  owner_config_invalid: ["S2_PREFLIGHT", false],
  owner_config_cleanup_failed: ["S2_PREFLIGHT", false],
  secret_root_invalid: ["S2_SECRET_STORE", false],
  secret_root_cleanup_failed: ["S2_SECRET_STORE", false],
  secret_handle_invalid: ["S2_SECRET_STORE", false],
  secret_handle_expired: ["S2_SECRET_STORE", false],
  secret_handle_mismatched: ["S2_SECRET_STORE", false],
  secret_consumer_forbidden: ["S2_SECRET_STORE", false],
  secret_store_unavailable: ["S2_SECRET_STORE", true],
  account_secret_cleanup_failed: ["S2_SECRET_STORE", false],
  gmail_oauth_secret_cleanup_failed: ["S2_SECRET_STORE", false],
  credential_mutation_denied: ["S2_CREDENTIAL_MUTATION", false],
  credential_effect_uncertain: ["S2_CREDENTIAL_MUTATION", false],
  gmail_auth_denied: ["S2_GMAIL_AUTH", false],
  gmail_rate_limited: ["S2_GMAIL_AUTH", true],
  gmail_network_unavailable: ["S2_GMAIL_AUTH", true],
  mailbox_query_invalid: ["S2_MAILBOX_PROVIDER", false],
  mailbox_timeout: ["S2_MAILBOX_PROVIDER", true],
  verification_artifact_replayed: ["S2_MAILBOX_PROVIDER", false],
  verification_navigation_denied: ["S2_VERIFICATION_NAVIGATOR", false],
  recovery_checkpoint_invalid: ["S2_RECOVERY_CHECKPOINT", false],
  recovery_checkpoint_unavailable: ["S2_RECOVERY_CHECKPOINT", true],
  recovery_state_ambiguous: ["S2_RECOVERY_CHECKPOINT", false],
  recovery_target_mismatch: ["S2_RECOVERY_CHECKPOINT", false],
  recovery_checkpoint_cleanup_failed: ["S2_RECOVERY_CHECKPOINT", false],
  browser_profile_cleanup_failed: ["F3", false],
  resume_capture_cleanup_failed: ["F4", false],
  answer_provenance_invalid: ["F6", false],
  evidence_root_invalid: ["F11", false],
  evidence_root_cleanup_failed: ["F11", false],
  acceptance_evidence_cleanup_failed: ["F11", false],
} as const;

export function terminalV4(factualOutcome: unknown) {
  return {
    schemaVersion: 4,
    journeyId,
    status: "blocked",
    completedPages: 0,
    factualOutcome,
  };
}

export function errorV3(
  code: keyof typeof s2ErrorPolicyCases,
  component = s2ErrorPolicyCases[code][0],
  retryable = s2ErrorPolicyCases[code][1],
) {
  return {
    schemaVersion: 3,
    code,
    component,
    phase: "preflight",
    step: "validate",
    retryable,
    source: operationSource,
  };
}
