import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

export interface MailboxCandidateAcceptanceV1 {
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

export interface WriteMailboxCandidateEvidenceRequest {
  readonly root: string;
  readonly acceptance: MailboxCandidateAcceptanceV1;
  readonly sensitiveValues: readonly string[];
}

export async function writeMailboxCandidateEvidence(
  request: WriteMailboxCandidateEvidenceRequest,
): Promise<void> {
  writeAtomicJsonEvidence({
    root: request.root,
    value: exactAcceptance(request.acceptance),
    sensitiveValues: request.sensitiveValues,
    label: "mailbox-candidate",
  });
}

function exactAcceptance(
  value: MailboxCandidateAcceptanceV1,
): MailboxCandidateAcceptanceV1 {
  const expected = [
    "schemaVersion", "evidenceRevision", "checkpoint", "status", "sourceRevision",
    "revisionId", "approvalId", "journeyId", "targetHandleId", "provider",
    "candidateCount", "messageBodyRetained", "submitActivated", "privacyScan", "cleanup",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key, index) => keys[index] !== key) ||
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-mailbox-candidate-acceptance-v1" ||
    value.checkpoint !== "mailbox_candidate" ||
    value.status !== "passed" ||
    !/^[0-9a-f]{40}$/u.test(value.sourceRevision) ||
    !/^revision_[A-Za-z0-9_-]{16,64}$/u.test(value.revisionId) ||
    !/^approval_[A-Za-z0-9_-]{16,64}$/u.test(value.approvalId) ||
    !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
    !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) ||
    value.provider !== "gmail-api-v1" ||
    value.candidateCount !== 1 ||
    value.messageBodyRetained !== false ||
    value.submitActivated !== false ||
    value.privacyScan !== "pass" ||
    value.cleanup !== "pass"
  ) denied();
  return Object.freeze({ ...value });
}

function denied(): never {
  throw new Error("mailbox-candidate evidence denied");
}
