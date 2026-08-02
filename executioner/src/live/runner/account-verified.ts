import type { JourneyId } from "../../contracts/index.ts";
import {
  s2StableErrorPolicy,
  type S2StableErrorCode,
} from "../../contracts/s2-common-wire.ts";

export interface Stage2AccountVerifiedInput {
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: JourneyId;
  readonly targetHandleId: string;
}

export interface AccountVerifiedAcceptance {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-account-verified-acceptance-v1";
  readonly checkpoint: "account_verified";
  readonly status: "passed";
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly accountState: "application_ready";
  readonly independentlyObservedVerifiedState: true;
  readonly provider: "gmail-api-v1";
  readonly consumedCandidateCount: 1;
  readonly messageBodyRetained: false;
  readonly submitActivated: false;
  readonly privacyScan: "pass";
  readonly cleanup: "pass";
}

export interface AccountVerifiedLifecycleSuccess {
  readonly kind: "account_ready";
  readonly path: "already_ready" | "reused_account" | "verified_account";
  readonly independentlyObserved: boolean;
  readonly verificationCandidateCount: number;
  readonly verificationConsumed: boolean;
}

export type AccountVerifiedLifecycleResult =
  | {
      readonly ok: true;
      readonly cleanup: "pass";
      readonly value: AccountVerifiedLifecycleSuccess | unknown;
    }
  | { readonly ok: false; readonly error: { readonly code: string } };

export interface AccountVerifiedLifecycleRunner {
  run(signal: AbortSignal): Promise<AccountVerifiedLifecycleResult>;
}

export interface AccountVerifiedEvidenceWriter {
  write(value: AccountVerifiedAcceptance): Promise<void>;
}

export interface Stage2AccountVerifiedDependencies {
  readonly lifecycle: AccountVerifiedLifecycleRunner;
  readonly evidence: AccountVerifiedEvidenceWriter;
}

export type Stage2AccountVerifiedResult =
  | { readonly ok: true; readonly acceptance: AccountVerifiedAcceptance }
  | {
      readonly ok: false;
      readonly code: string;
      readonly fact?: AccountVerifiedFact;
    };

export type AccountVerifiedFact =
  | { readonly kind: "target_mismatch"; readonly dimension: "host" | "tenant" | "posting" }
  | { readonly kind: "target_ambiguous" }
  | {
      readonly kind: "posting_unavailable";
      readonly reason: "not_found" | "closed" | "removed" | "unavailable";
    }
  | {
      readonly kind: "manual_intervention";
      readonly reason: "captcha" | "mfa" | "access_control";
    };

export async function runStage2AccountVerified(
  input: Stage2AccountVerifiedInput,
  dependencies: Stage2AccountVerifiedDependencies,
  signal: AbortSignal,
): Promise<Stage2AccountVerifiedResult> {
  if (signal.aborted) return failure("operation_cancelled");
  let lifecycle: AccountVerifiedLifecycleResult;
  try {
    lifecycle = await dependencies.lifecycle.run(signal);
  } catch {
    return failure(signal.aborted ? "operation_cancelled" : "account_proof_invalid");
  }
  if (!lifecycle.ok) return failure(stableCode(lifecycle.error.code));
  if (lifecycle.cleanup !== "pass") return failure("account_proof_invalid");
  const factual = factualResult(lifecycle.value);
  if (factual !== null) return failure(factual.code, factual.fact);
  if (!exactVerified(lifecycle.value)) {
    return failure("account_proof_invalid");
  }

  const acceptance = Object.freeze({
    schemaVersion: 1 as const,
    evidenceRevision: "s2-account-verified-acceptance-v1" as const,
    checkpoint: "account_verified" as const,
    status: "passed" as const,
    sourceRevision: input.sourceRevision,
    revisionId: input.revisionId,
    approvalId: input.approvalId,
    journeyId: input.journeyId,
    targetHandleId: input.targetHandleId,
    accountState: "application_ready" as const,
    independentlyObservedVerifiedState: true as const,
    provider: "gmail-api-v1" as const,
    consumedCandidateCount: 1 as const,
    messageBodyRetained: false as const,
    submitActivated: false as const,
    privacyScan: "pass" as const,
    cleanup: "pass" as const,
  });
  try {
    await dependencies.evidence.write(acceptance);
    return { ok: true, acceptance };
  } catch {
    return failure("evidence_unavailable");
  }
}

function exactVerified(value: unknown): value is AccountVerifiedLifecycleSuccess {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 5 &&
    keys[0] === "kind" && keys[1] === "path" &&
    keys[2] === "independentlyObserved" &&
    keys[3] === "verificationCandidateCount" &&
    keys[4] === "verificationConsumed" &&
    value.kind === "account_ready" && value.path === "verified_account" &&
    value.independentlyObserved === true &&
    value.verificationCandidateCount === 1 && value.verificationConsumed === true;
}

function factualResult(
  value: unknown,
): { readonly code: string; readonly fact?: AccountVerifiedFact } | null {
  if (!record(value) || value.kind !== "blocked") return null;
  if (!exactKeys(value, ["kind", "factualOutcome"]) ||
      !record(value.factualOutcome) ||
      !exactKeys(value.factualOutcome, ["source", "result"]) ||
      !record(value.factualOutcome.result)) return { code: "account_proof_invalid" };
  const source = value.factualOutcome.source;
  const result = value.factualOutcome.result;
  if (source === "mailbox_verification" && exactKeys(result, ["kind"]) &&
      typeof result.kind === "string" && [
        "mailbox_none", "mailbox_ambiguous", "mailbox_expired", "mailbox_consumed",
      ].includes(result.kind)) return { code: result.kind };
  if (source === "verification_navigation" && exactKeys(result, ["kind"]) &&
      result.kind === "verification_target_unavailable") {
    return { code: "verification_target_unavailable" };
  }
  if (source === "ats_family" && exactKeys(result, ["kind"]) &&
      typeof result.kind === "string" &&
      ["ats_unsupported", "ats_unknown", "ats_ambiguous"].includes(result.kind)) {
    return { code: result.kind };
  }
  if (source === "workday_page_type" && exactKeys(result, ["kind"]) &&
      typeof result.kind === "string" &&
      ["workday_page_unknown", "workday_page_ambiguous"].includes(result.kind)) {
    return { code: result.kind };
  }
  if (source === "account_access" &&
      exactKeys(result, ["kind", "reason"]) &&
      result.kind === "manual_intervention" &&
      (result.reason === "captcha" || result.reason === "mfa" ||
        result.reason === "access_control")) {
    return {
      code: "manual_intervention",
      fact: { kind: result.kind, reason: result.reason },
    };
  }
  if (source === "target_identity") return targetFact(result);
  return { code: "account_proof_invalid" };
}

function targetFact(
  result: Record<string, unknown>,
): { readonly code: string; readonly fact?: AccountVerifiedFact } {
  if (exactKeys(result, ["kind", "dimension"]) &&
      result.kind === "target_mismatch" &&
      (result.dimension === "host" || result.dimension === "tenant" ||
        result.dimension === "posting")) {
    return { code: result.kind, fact: { kind: result.kind, dimension: result.dimension } };
  }
  if (exactKeys(result, ["kind"]) && result.kind === "target_ambiguous") {
    return { code: result.kind, fact: { kind: result.kind } };
  }
  if (exactKeys(result, ["kind", "reason"]) &&
      result.kind === "posting_unavailable" &&
      (result.reason === "not_found" || result.reason === "closed" ||
        result.reason === "removed" || result.reason === "unavailable")) {
    return { code: result.kind, fact: { kind: result.kind, reason: result.reason } };
  }
  return { code: "account_proof_invalid" };
}

function stableCode(value: unknown): S2StableErrorCode | "account_proof_invalid" {
  return typeof value === "string" && Object.hasOwn(s2StableErrorPolicy, value)
    ? value as S2StableErrorCode
    : "account_proof_invalid";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key, index) => keys[index] === key);
}

function failure(
  code: string,
  fact?: AccountVerifiedFact,
): Stage2AccountVerifiedResult {
  return Object.freeze({ ok: false, code, ...(fact === undefined ? {} : { fact }) });
}
