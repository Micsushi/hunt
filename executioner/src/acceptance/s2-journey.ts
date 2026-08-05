import type {
  ApplicationWalkResult,
  ApplicationWalkResume,
} from "../ats/workday/application/page-walk.ts";
import type { ReviewStopRequest, ReviewReadOnlyPage } from "../interaction/review/index.ts";
import { inspectWorkdayReview, stopAtVerifiedReview } from "../interaction/review/index.ts";
import {
  recoverBrowserInterruption,
  type RecoverBrowserInterruptionInput,
  type RecoveryCheckpoint,
  type RecoveryDependencies,
} from "../journey/recovery/index.ts";
import { writeLiveEvidencePacket } from "../evidence/live/packet.ts";
import type {
  Stage2ConfigCapture,
  Stage2RealAcceptanceArgs,
  Stage2ReviewAcceptance,
  Stage2SourceCapture,
} from "./s2-gate.ts";

export interface Stage2RealJourneyInvocation {
  readonly args: Stage2RealAcceptanceArgs;
  readonly source: Stage2SourceCapture;
  readonly config: Stage2ConfigCapture;
}

export interface Stage2RealJourneyRecoveryPlan {
  readonly input: RecoverBrowserInterruptionInput;
  readonly dependencies: RecoveryDependencies;
  readonly resume: (state: RecoveryCheckpoint) => ApplicationWalkResume;
}

export interface Stage2RealJourneyRuntime {
  readonly recovery: {
    pending(signal: AbortSignal): Promise<Stage2RealJourneyRecoveryPlan | null>;
  };
  readonly application: {
    run(signal: AbortSignal, resume?: ApplicationWalkResume): Promise<ApplicationWalkResult>;
  };
  readonly review: {
    capture(signal: AbortSignal): Promise<{
      readonly page: ReviewReadOnlyPage;
      readonly request: Omit<ReviewStopRequest, "structure">;
    }>;
  };
  readonly privacy: {
    forbiddenTokens(signal: AbortSignal): Promise<readonly string[]>;
  };
  readonly cleanup: {
    close(signal: AbortSignal, accepted?: boolean): Promise<boolean>;
  };
}

export interface Stage2RealJourneyRuntimeBinding {
  bind(
    invocation: Stage2RealJourneyInvocation,
    signal: AbortSignal,
  ): Promise<Stage2RealJourneyRuntime>;
}

export interface Stage2RealJourneyPorts {
  now(): string;
  writeAcceptance(
    evidenceRoot: string,
    value: Stage2ReviewAcceptance,
  ): Promise<void>;
}

export type Stage2RealJourneyFailureCode =
  | "runtime_binding_failed"
  | "recovery_failed"
  | "pre_review_failed"
  | "review_failed"
  | "evidence_failed"
  | "cleanup_failed"
  | "operation_cancelled";

export type Stage2RealJourneyResult =
  | { readonly ok: true; readonly acceptance: Stage2ReviewAcceptance }
  | { readonly ok: false; readonly code: Stage2RealJourneyFailureCode };

type PendingJourneyResult =
  | { readonly ok: true; readonly acceptance: Stage2ReviewAcceptance }
  | { readonly ok: false; readonly code: Exclude<Stage2RealJourneyFailureCode, "runtime_binding_failed" | "cleanup_failed"> };

export async function runStage2RealJourney(
  invocation: Stage2RealJourneyInvocation,
  binding: Stage2RealJourneyRuntimeBinding | undefined,
  ports: Stage2RealJourneyPorts,
  signal: AbortSignal,
): Promise<Stage2RealJourneyResult> {
  if (signal.aborted) return failed("operation_cancelled");
  if (binding === undefined) return failed("runtime_binding_failed");

  let runtime: Stage2RealJourneyRuntime;
  try {
    runtime = await binding.bind(invocation, signal);
  } catch {
    return failed(signal.aborted ? "operation_cancelled" : "runtime_binding_failed");
  }

  const pending = await executeBoundJourney(invocation, runtime, ports, signal);
  if (pending.ok && !signal.aborted) {
    try {
      await ports.writeAcceptance(invocation.args.evidenceRoot, pending.acceptance);
    } catch {
      const retained = await closeRuntime(runtime, false);
      return retained ? failed("evidence_failed") : failed("cleanup_failed");
    }
    const finalized = await closeRuntime(runtime, true);
    return finalized ? pending : failed("cleanup_failed");
  }
  const retained = await closeRuntime(runtime, false);
  if (!retained) return failed("cleanup_failed");
  return signal.aborted ? failed("operation_cancelled") : pending;
}

async function closeRuntime(
  runtime: Stage2RealJourneyRuntime,
  accepted: boolean,
): Promise<boolean> {
  let cleaned = false;
  try {
    cleaned = await runtime.cleanup.close(
      new AbortController().signal,
      accepted,
    );
  } catch {
    cleaned = false;
  }
  return cleaned;
}

async function executeBoundJourney(
  invocation: Stage2RealJourneyInvocation,
  runtime: Stage2RealJourneyRuntime,
  ports: Stage2RealJourneyPorts,
  signal: AbortSignal,
): Promise<PendingJourneyResult> {
  if (signal.aborted) return failed("operation_cancelled");
  let resume: ApplicationWalkResume | undefined;
  try {
    const plan = await runtime.recovery.pending(signal);
    if (plan !== null) {
      if (
        plan.input.journeyId !== invocation.config.journeyId ||
        plan.input.sourceRevision !== invocation.config.revisionId
      ) return failed("recovery_failed");
      const recovered = await recoverBrowserInterruption(
        plan.dependencies,
        plan.input,
        signal,
      );
      if (!recovered.ok || recovered.value.kind !== "resumed") {
        return failed(signal.aborted ? "operation_cancelled" : "recovery_failed");
      }
      resume = plan.resume(recovered.value.state);
    }
  } catch {
    return failed(signal.aborted ? "operation_cancelled" : "recovery_failed");
  }

  if (signal.aborted) return failed("operation_cancelled");
  let application: Extract<ApplicationWalkResult, { ok: true }>;
  try {
    const result = await runtime.application.run(signal, resume);
    if (!verifiedPreReview(result)) return failed("pre_review_failed");
    application = result;
  } catch {
    return failed(signal.aborted ? "operation_cancelled" : "pre_review_failed");
  }

  if (signal.aborted) return failed("operation_cancelled");
  let review: ReturnType<typeof stopAtVerifiedReview>;
  try {
    const captured = await runtime.review.capture(signal);
    const structure = await inspectWorkdayReview(captured.page);
    review = stopAtVerifiedReview({ ...captured.request, structure });
  } catch {
    return failed(signal.aborted ? "operation_cancelled" : "review_failed");
  }
  if (
    review.kind !== "review_confirmed" ||
    review.transition.journeyId !== invocation.config.journeyId ||
    review.transition.status !== "review_reached" ||
    review.proof.finalSubmit.present !== true ||
    review.proof.validationErrorCount !== 0
  ) return failed("review_failed");

  if (signal.aborted) return failed("operation_cancelled");
  try {
    const forbiddenTokens = await runtime.privacy.forbiddenTokens(signal);
    if (forbiddenTokens.length === 0) throw new TypeError("privacy corpus missing");
    writeLiveEvidencePacket({
      schemaVersion: 1,
      packetRevision: "s2-real-evidence-packet-v1",
      root: invocation.args.evidenceRoot,
      sourceRevision: invocation.source.sourceRevision,
      configurationRevisionId: invocation.config.revisionId,
      configurationApprovalId: invocation.config.approvalId,
      journeyId: invocation.config.journeyId,
      sealedAt: ports.now(),
      retentionDays: 30,
      milestones: [
        { kind: "account_verified", status: "verified" },
        { kind: "application_completed", status: "verified" },
        { kind: "review_reached", status: "verified" },
        { kind: "submit_guarded", status: "verified" },
      ],
      verificationSummaries: [
        { kind: "account", status: "verified", verifiedCount: 1 },
        { kind: "resume", status: "verified", verifiedCount: 1 },
        {
          kind: "required_fields",
          status: "verified",
          verifiedCount: application.value.pageChecks.reduce(
            (total, check) => total + check.verifiedFields,
            0,
          ),
        },
        {
          kind: "review",
          status: "verified",
          verifiedCount: review.proof.verifiedRequiredFieldCount,
        },
        { kind: "submit_guard", status: "verified", verifiedCount: 1 },
      ],
      errors: [],
      missingEvidence: [],
      browserTruth: {
        schemaVersion: 1,
        observer: "independent_browser",
        page: "review",
        reviewSignatureIds: [
          "review_signature_workday_review_root_v1",
          "review_signature_workday_active_step_v1",
        ],
        completionEvidenceIds: [
          "completion_evidence_application_pages_v1",
          "completion_evidence_required_fields_v1",
        ],
        submitStructurallyPresent: true,
        submitActivated: false,
      },
      diagnosticProjection: {
        reviewReached: true,
        requiredFieldsComplete: true,
        submitActivated: false,
      },
      unknownCandidate: null,
      forbiddenTokens,
    });
  } catch {
    return failed(signal.aborted ? "operation_cancelled" : "evidence_failed");
  }

  return {
    ok: true,
    acceptance: Object.freeze({
      schemaVersion: 1,
      evidenceRevision: "s2-review-acceptance-v1",
      sourceRevision: invocation.source.sourceRevision,
      configSha256: invocation.config.configSha256,
      contractRevision: invocation.config.contractRevision,
      revisionId: invocation.config.revisionId,
      approvalId: invocation.config.approvalId,
      journeyId: invocation.config.journeyId,
      targetHandleId: invocation.config.targetHandleId,
      checkpoint: "review",
      status: "passed",
      reviewProof: "independently_verified",
      submitPresent: true,
      submitActivated: false,
      privacyScan: "pass",
    }),
  };
}

function verifiedPreReview(value: ApplicationWalkResult): value is Extract<ApplicationWalkResult, { ok: true }> {
  if (
    !value.ok || value.value.checkpoint !== "pre_review" ||
    value.value.completedPages !== 3 || value.value.submitActivated !== false ||
    value.value.privacyScan !== "pass" || value.value.pageChecks.length !== 3
  ) return false;
  const pages = ["resume", "profile", "questionnaire"] as const;
  const checkpoints = [
    "resume_verified",
    "profile_verified",
    "questionnaire_verified",
  ] as const;
  return value.value.pageChecks.every((check, index) =>
    check.page === pages[index] && check.checkpoint === checkpoints[index] &&
    check.independentlyVerified === true &&
    Number.isSafeInteger(check.requiredFields) && check.requiredFields >= 0 &&
    check.verifiedFields === check.requiredFields && check.duplicateRows === 0
  );
}

function failed<Code extends Stage2RealJourneyFailureCode>(
  code: Code,
): { readonly ok: false; readonly code: Code } {
  return Object.freeze({ ok: false, code });
}
