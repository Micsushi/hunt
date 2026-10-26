import type { JourneyId } from "../../contracts/index.ts";
import type {
  LiveIdentifier,
  MailboxProvider,
  RecipientBindingId,
  TargetIdentityV1,
  VerificationHandleId,
} from "../../contracts/live/index.ts";

export interface Stage2MailboxCandidateInput {
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: JourneyId;
  readonly targetHandleId: string;
  readonly recipientBindingId: RecipientBindingId;
  readonly target: TargetIdentityV1;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly now: string;
}

export interface MailboxCandidateAcceptance {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-mailbox-candidate-acceptance-v1";
  readonly checkpoint: "mailbox_candidate";
  readonly status: "passed";
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly provider: "gmail-api-v1";
  readonly candidateCount: 1;
  readonly messageBodyRetained: false;
  readonly submitActivated: false;
  readonly privacyScan: "pass";
  readonly cleanup: "pass";
}

export interface MailboxCandidateEvidenceWriter {
  write(value: MailboxCandidateAcceptance): Promise<void>;
}

export interface Stage2MailboxCandidateDependencies {
  readonly mailbox: MailboxProvider;
  readonly releaseCandidate: (handleId: VerificationHandleId) => void;
  readonly evidence: MailboxCandidateEvidenceWriter;
  readonly nextQueryId: () => LiveIdentifier<"mailbox_query">;
}

export type Stage2MailboxCandidateResult =
  | { readonly ok: true; readonly acceptance: MailboxCandidateAcceptance }
  | { readonly ok: false; readonly code: string };

export async function runStage2MailboxCandidate(
  input: Stage2MailboxCandidateInput,
  dependencies: Stage2MailboxCandidateDependencies,
  signal: AbortSignal,
): Promise<Stage2MailboxCandidateResult> {
  if (signal.aborted) return failure("operation_cancelled");
  let result: Awaited<ReturnType<MailboxProvider["poll"]>>;
  try {
    result = await dependencies.mailbox.poll({
      schemaVersion: 1,
      journeyId: input.journeyId,
      queryId: dependencies.nextQueryId(),
      recipientBindingId: input.recipientBindingId,
      target: input.target,
      notBefore: input.notBefore,
      notAfter: input.notAfter,
    }, signal);
  } catch {
    return failure(signal.aborted ? "operation_cancelled" : "gmail_network_unavailable");
  }
  if (!result.ok) return failure(result.error.code);
  const value = result.value;
  if (value.provider !== "gmail_api_v1") return failure("mailbox_query_invalid");
  if (value.candidateCount === 0) {
    return value.receivedTimeBucket === null && value.expiresAt === null &&
        value.verificationHandle === null
      ? failure("mailbox_none")
      : failure("mailbox_query_invalid");
  }
  if (value.candidateCount > 1) {
    return value.verificationHandle === null
      ? failure("mailbox_ambiguous")
      : failure("mailbox_query_invalid");
  }
  if (value.candidateCount !== 1 || value.receivedTimeBucket === null ||
      value.expiresAt === null) return failure("mailbox_query_invalid");
  if (value.verificationHandle === null) {
    return Date.parse(value.expiresAt) <= Date.parse(input.now)
      ? failure("mailbox_expired")
      : failure("mailbox_consumed");
  }
  if (
    !validMinuteBucket(value.receivedTimeBucket) ||
    !validInstant(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(input.now)
  ) return failure("mailbox_query_invalid");

  try {
    dependencies.releaseCandidate(value.verificationHandle);
  } catch {
    return failure("mailbox_query_invalid");
  }
  const acceptance = Object.freeze({
    schemaVersion: 1 as const,
    evidenceRevision: "s2-mailbox-candidate-acceptance-v1" as const,
    checkpoint: "mailbox_candidate" as const,
    status: "passed" as const,
    sourceRevision: input.sourceRevision,
    revisionId: input.revisionId,
    approvalId: input.approvalId,
    journeyId: input.journeyId,
    targetHandleId: input.targetHandleId,
    provider: "gmail-api-v1" as const,
    candidateCount: 1 as const,
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

function validInstant(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validMinuteBucket(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function failure(code: string): Stage2MailboxCandidateResult {
  return Object.freeze({ ok: false, code });
}
