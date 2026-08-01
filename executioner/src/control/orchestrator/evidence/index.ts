import { createHash } from "node:crypto";

import {
  bindAdmissionRequest,
  type AdmittedSnapshot,
  type EvidenceAdmissionSnapshot,
  type EvidenceId,
  type EvidenceStore,
  type GuardRevision,
  type JourneyId,
  type OperationId,
  type OperationIdentityError,
  type PortError,
  type PortResult,
  type PrivacyGuard,
  type StableErrorCode,
} from "../../../contracts/index.ts";

export interface StartEvidenceDependencies {
  readonly privacy: PrivacyGuard;
  readonly evidence: EvidenceStore;
  readonly nextOperationId: () => PortResult<
    OperationId,
    OperationIdentityError
  >;
  readonly nextEvidenceId: () => EvidenceId;
  readonly guardRevision: GuardRevision;
}

export async function recordStartEvidence(
  dependencies: StartEvidenceDependencies,
  journeyId: JourneyId,
  signal: AbortSignal,
): Promise<PortResult<void, PortError<StableErrorCode>>> {
  const operation = dependencies.nextOperationId();
  if (!operation.ok) return operation;
  const input = {
    journeyId,
    operationId: operation.value,
    record: {
      id: dependencies.nextEvidenceId(),
      kind: "semantic_snapshot",
      component: "F9",
      phase: "orchestration",
      step: "start",
      sha256: createHash("sha256").update("F9:start").digest("hex"),
    },
  } as const satisfies EvidenceAdmissionSnapshot;
  const admitted = await dependencies.privacy.admit(
    {
      binding: {
        journeyId,
        attemptId: operation.value,
        guardRevision: dependencies.guardRevision,
      },
      purpose: "evidence",
      input,
    },
    signal,
  );
  if (!admitted.ok) return admitted;
  const written = await dependencies.evidence.write(
    bindAdmissionRequest(
      admitted.value as AdmittedSnapshot<"evidence", typeof input>,
    ),
    signal,
  );
  return written.ok ? { ok: true, value: undefined } : written;
}
