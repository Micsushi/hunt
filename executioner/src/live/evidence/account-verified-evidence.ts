import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

export interface AccountVerifiedAcceptanceV1 {
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

export interface WriteAccountVerifiedEvidenceRequest {
  readonly root: string;
  readonly acceptance: AccountVerifiedAcceptanceV1;
  readonly sensitiveValues: readonly string[];
}

export async function writeAccountVerifiedEvidence(
  request: WriteAccountVerifiedEvidenceRequest,
): Promise<void> {
  writeAtomicJsonEvidence({
    root: request.root,
    value: exactAcceptance(request.acceptance),
    sensitiveValues: request.sensitiveValues,
    label: "account-verified",
  });
}

function exactAcceptance(value: AccountVerifiedAcceptanceV1): AccountVerifiedAcceptanceV1 {
  const expected = [
    "schemaVersion", "evidenceRevision", "checkpoint", "status", "sourceRevision",
    "revisionId", "approvalId", "journeyId", "targetHandleId", "accountState",
    "independentlyObservedVerifiedState", "provider", "consumedCandidateCount",
    "messageBodyRetained", "submitActivated", "privacyScan", "cleanup",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key, index) => keys[index] !== key) ||
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-account-verified-acceptance-v1" ||
    value.checkpoint !== "account_verified" ||
    value.status !== "passed" ||
    !/^[0-9a-f]{40}$/u.test(value.sourceRevision) ||
    !/^revision_[A-Za-z0-9_-]{16,64}$/u.test(value.revisionId) ||
    !/^approval_[A-Za-z0-9_-]{16,64}$/u.test(value.approvalId) ||
    !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
    !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) ||
    value.accountState !== "application_ready" ||
    value.independentlyObservedVerifiedState !== true ||
    value.provider !== "gmail-api-v1" ||
    value.consumedCandidateCount !== 1 ||
    value.messageBodyRetained !== false ||
    value.submitActivated !== false ||
    value.privacyScan !== "pass" ||
    value.cleanup !== "pass"
  ) denied();
  return Object.freeze({ ...value });
}

function denied(): never {
  throw new Error("account-verified evidence denied");
}
