import type { JourneyId } from "../../contracts/index.ts";

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
  | { readonly ok: true; readonly value: AccountVerifiedLifecycleSuccess | unknown }
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
  | { readonly ok: false; readonly code: string };

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
  if (!lifecycle.ok) return failure(lifecycle.error.code);
  const factual = factualCode(lifecycle.value);
  if (factual !== null) return failure(factual);
  if (!exactVerified(lifecycle.value)) return failure("account_proof_invalid");

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

function factualCode(value: unknown): string | null {
  if (!record(value) || value.kind !== "blocked" || !record(value.factualOutcome) ||
      !record(value.factualOutcome.result)) return null;
  const kind = value.factualOutcome.result.kind;
  return typeof kind === "string" && [
    "mailbox_none", "mailbox_ambiguous", "mailbox_expired", "mailbox_consumed",
    "verification_target_unavailable", "manual_intervention",
  ].includes(kind) ? kind : "account_proof_invalid";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: string): Stage2AccountVerifiedResult {
  return Object.freeze({ ok: false, code });
}
