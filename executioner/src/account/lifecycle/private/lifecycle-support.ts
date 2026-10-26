import { liveCoordinatorError } from "../../../control/orchestrator/live/types.ts";
import type { AccountLifecycleInput, AccountLifecycleResult } from "../types.ts";

export function ready(
  path: "already_ready" | "reused_account" | "created_account" | "verified_account",
  verificationCandidateCount: 0 | 1,
  verificationConsumed: boolean,
): AccountLifecycleResult {
  return {
    ok: true,
    value: {
      kind: "account_ready",
      path,
      independentlyObserved: true,
      verificationCandidateCount,
      verificationConsumed,
    },
  };
}

export function navigationRequired(
  path: "reused_account" | "created_account" | "verified_account",
  verificationCandidateCount: 0 | 1,
  verificationConsumed: boolean,
): AccountLifecycleResult {
  return {
    ok: true,
    value: {
      kind: "navigation_required",
      pageType: "job_posting",
      path,
      verificationCandidateCount,
      verificationConsumed,
    },
  };
}

export function blocked(
  source: "account_access",
  result: {
    readonly kind: "manual_intervention";
    readonly reason: "captcha" | "mfa" | "access_control";
  },
): AccountLifecycleResult {
  return { ok: true, value: { kind: "blocked", factualOutcome: { source, result } } };
}

export function denied(): AccountLifecycleResult {
  return { ok: false, error: liveCoordinatorError("credential_mutation_denied") };
}

export function mailboxInvalid(): AccountLifecycleResult {
  return { ok: false, error: liveCoordinatorError("mailbox_query_invalid") };
}

export function replayed(): AccountLifecycleResult {
  return { ok: false, error: liveCoordinatorError("verification_artifact_replayed") };
}

export function navigationDenied(): AccountLifecycleResult {
  return { ok: false, error: liveCoordinatorError("verification_navigation_denied") };
}

export function mailboxBlocked(
  kind: "mailbox_none" | "mailbox_ambiguous" | "mailbox_expired" | "mailbox_consumed",
): AccountLifecycleResult {
  return {
    ok: true,
    value: {
      kind: "blocked",
      factualOutcome: { source: "mailbox_verification", result: { kind } },
    },
  };
}

export function navigationBlocked(): AccountLifecycleResult {
  return {
    ok: true,
    value: {
      kind: "blocked",
      factualOutcome: {
        source: "verification_navigation",
        result: { kind: "verification_target_unavailable" },
      },
    },
  };
}

export function targetBlocked(
  result:
    | { readonly kind: "target_mismatch"; readonly dimension: "host" | "tenant" | "posting" }
    | { readonly kind: "target_ambiguous" }
    | {
        readonly kind: "posting_unavailable";
        readonly reason: "not_found" | "closed" | "removed" | "unavailable" | "maintenance" | "runtime_error";
      },
): AccountLifecycleResult {
  return {
    ok: true,
    value: {
      kind: "blocked",
      factualOutcome: { source: "target_identity", result },
    },
  };
}

export function classificationBlocked(
  source: "ats_family" | "workday_page_type",
  kind:
    | "ats_unsupported"
    | "ats_unknown"
    | "ats_ambiguous"
    | "workday_page_unknown"
    | "workday_page_ambiguous",
): AccountLifecycleResult {
  if (source === "ats_family") {
    return {
      ok: true,
      value: {
        kind: "blocked",
        factualOutcome: {
          source,
          result: { kind: kind as "ats_unsupported" | "ats_unknown" | "ats_ambiguous" },
        },
      },
    };
  }
  return {
    ok: true,
    value: {
      kind: "blocked",
      factualOutcome: {
        source,
        result: { kind: kind as "workday_page_unknown" | "workday_page_ambiguous" },
      },
    },
  };
}

export function sameTarget(
  left: AccountLifecycleInput["target"],
  right: AccountLifecycleInput["target"],
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.atsFamily === right.atsFamily &&
    left.hostId === right.hostId &&
    left.tenantId === right.tenantId &&
    left.postingId === right.postingId;
}

export function validInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function requestFingerprint(input: AccountLifecycleInput): string {
  return JSON.stringify([
    input.schemaVersion,
    input.operationId,
    input.approvalId,
    input.journeyId,
    input.session.schemaVersion,
    input.session.sessionId,
    input.session.journeyId,
    input.session.profileLeaseId,
    input.session.leaseExpiresAt,
    input.target.schemaVersion,
    input.target.atsFamily,
    input.target.hostId,
    input.target.tenantId,
    input.target.postingId,
    input.credential.handleId,
    input.credential.journeyId,
    input.credential.expiresAt,
    input.mailboxRequest.schemaVersion,
    input.mailboxRequest.queryId,
    input.mailboxRequest.recipientBindingId,
    input.mailboxRequest.notBefore,
    input.mailboxRequest.notAfter,
    input.now,
    input.accountIntent,
    input.operations.initialCredentialMutation,
    input.operations.createCredentialMutation,
    input.operations.accountExistsSignIn,
    input.operations.requestVerificationEmail,
    input.operations.navigateVerification,
    input.operations.postVerificationSignIn,
    input.operations.postVerificationCredentialSubmit,
  ]);
}

export function frozen(result: AccountLifecycleResult): AccountLifecycleResult {
  if (result.ok) Object.freeze(result.value);
  else Object.freeze(result.error);
  return Object.freeze(result);
}
