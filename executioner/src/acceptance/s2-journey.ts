import {
  checkpointForApplicationPage,
  isValidApplicationPageSequence,
  maximumApplicationPageVisits,
  type ApplicationWalkResult,
  type ApplicationWalkResume,
} from "../ats/workday/application/page-walk.ts";
import {
  s2StableErrorPolicy,
  type S2StableErrorCode,
  type TerminalResultV4,
} from "../contracts/index.ts";
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
  Stage2UnsealedAccountProofResult,
  Stage2UnsealedAccountProofV1,
} from "../composition/s2-account-verified-runner.ts";
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
  readonly account: {
    verify(signal: AbortSignal): Promise<Stage2UnsealedAccountProofResult>;
  };
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
  | "account_verification_failed"
  | "captcha"
  | "mfa"
  | "access_control"
  | "recovery_failed"
  | "pre_review_failed"
  | "review_failed"
  | "evidence_failed"
  | "cleanup_failed"
  | "operation_cancelled";

export type Stage2RealJourneyResult =
  | {
      readonly ok: true;
      readonly acceptance: Stage2ReviewAcceptance;
      readonly terminal: TerminalResultV4;
    }
  | {
      readonly ok: false;
      readonly code: Stage2RealJourneyFailureCode;
      readonly terminal: TerminalResultV4;
      readonly cleanupErrorCode?: "browser_profile_cleanup_failed";
    };

type PendingJourneyResult = Stage2RealJourneyResult;

export async function runStage2RealJourney(
  invocation: Stage2RealJourneyInvocation,
  binding: Stage2RealJourneyRuntimeBinding | undefined,
  ports: Stage2RealJourneyPorts,
  signal: AbortSignal,
): Promise<Stage2RealJourneyResult> {
  if (signal.aborted) return cancelled(invocation.config.journeyId, 0);
  if (binding === undefined) {
    return errorFailure(invocation.config.journeyId, "runtime_binding_failed", "owner_config_invalid", 0);
  }

  let runtime: Stage2RealJourneyRuntime;
  try {
    runtime = await binding.bind(invocation, signal);
  } catch {
    return signal.aborted
      ? cancelled(invocation.config.journeyId, 0)
      : errorFailure(invocation.config.journeyId, "runtime_binding_failed", "mcp_internal_error", 0);
  }

  const pending = await executeBoundJourney(invocation, runtime, ports, signal);
  if (pending.ok && !signal.aborted) {
    try {
      await ports.writeAcceptance(invocation.args.evidenceRoot, pending.acceptance);
    } catch {
      const retained = await closeRuntime(runtime, false);
      return retained
        ? errorFailure(invocation.config.journeyId, "evidence_failed", "mcp_internal_error", 3)
        : withCleanupFailure(errorFailure(
          invocation.config.journeyId, "evidence_failed", "mcp_internal_error", 3,
        ));
    }
    const finalized = await closeRuntime(runtime, true);
    return finalized
      ? pending
      : errorFailure(invocation.config.journeyId, "cleanup_failed", "browser_profile_cleanup_failed", 3);
  }
  const retained = await closeRuntime(runtime, false);
  if (pending.ok) {
    const outcome = cancelled(invocation.config.journeyId, pending.terminal.completedPages);
    return retained ? outcome : withCleanupFailure(outcome);
  }
  const outcome = signal.aborted
    ? cancelled(invocation.config.journeyId, pending.terminal.completedPages)
    : pending;
  return retained ? outcome : withCleanupFailure(outcome);
}

function withCleanupFailure(
  result: Extract<Stage2RealJourneyResult, { readonly ok: false }>,
): Extract<Stage2RealJourneyResult, { readonly ok: false }> {
  return Object.freeze({ ...result, cleanupErrorCode: "browser_profile_cleanup_failed" });
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
  if (signal.aborted) return cancelled(invocation.config.journeyId, 0);
  try {
    const result = await runtime.account.verify(signal);
    if (!result.ok) {
      if (result.fact !== undefined) {
        return factualAccountFailure(invocation.config.journeyId, result.fact);
      }
      if (result.code === "operation_cancelled") {
        return cancelled(invocation.config.journeyId, 0);
      }
      return errorFailure(
        invocation.config.journeyId,
        "account_verification_failed",
        stableAccountError(result.code),
        0,
      );
    }
    if (!verifiedAccount(result.proof, invocation)) {
      return errorFailure(
        invocation.config.journeyId,
        "account_verification_failed",
        "verification_input_invalid",
        0,
      );
    }
  } catch {
    return signal.aborted
      ? cancelled(invocation.config.journeyId, 0)
      : errorFailure(
          invocation.config.journeyId,
          "account_verification_failed",
          "mcp_internal_error",
          0,
        );
  }

  if (signal.aborted) return cancelled(invocation.config.journeyId, 0);
  let resume: ApplicationWalkResume | undefined;
  try {
    const plan = await runtime.recovery.pending(signal);
    if (plan !== null) {
      if (
        plan.input.journeyId !== invocation.config.journeyId ||
        plan.input.sourceRevision !== invocation.config.revisionId
      ) {
        return errorFailure(
          invocation.config.journeyId,
          "recovery_failed",
          "recovery_checkpoint_invalid",
          0,
        );
      }
      const recovered = await recoverBrowserInterruption(
        plan.dependencies,
        plan.input,
        signal,
      );
      if (!recovered.ok) {
        return signal.aborted || recovered.error.code === "operation_cancelled"
          ? cancelled(invocation.config.journeyId, 0)
          : errorFailure(
              invocation.config.journeyId,
              "recovery_failed",
              recovered.error.code,
              0,
            );
      }
      if (recovered.value.kind !== "resumed") {
        return errorFailure(
          invocation.config.journeyId,
          "recovery_failed",
          recovered.value.terminal.code,
          0,
        );
      }
      resume = plan.resume(recovered.value.state);
    }
  } catch {
    return signal.aborted
      ? cancelled(invocation.config.journeyId, 0)
      : errorFailure(
          invocation.config.journeyId,
          "recovery_failed",
          "mcp_internal_error",
          0,
        );
  }

  if (signal.aborted) return cancelled(invocation.config.journeyId, 0);
  let application: Extract<ApplicationWalkResult, { ok: true }>;
  try {
    const result = await runtime.application.run(signal, resume);
    if (!result.ok) {
      if (result.error.failure.code === "operation_cancelled") {
        return cancelled(
          invocation.config.journeyId,
          result.error.completedPages,
        );
      }
      return errorFailure(
        invocation.config.journeyId,
        "pre_review_failed",
        result.error.failure.code,
        result.error.completedPages,
      );
    }
    if (!verifiedPreReview(result)) {
      return errorFailure(
        invocation.config.journeyId,
        "pre_review_failed",
        "page_incomplete",
        boundedPages(result.value.completedPages),
      );
    }
    application = result;
  } catch {
    return signal.aborted
      ? cancelled(invocation.config.journeyId, 0)
      : errorFailure(
          invocation.config.journeyId,
          "pre_review_failed",
          "mcp_internal_error",
          0,
        );
  }

  const completedPages = application.value.completedPages;
  if (signal.aborted) return cancelled(invocation.config.journeyId, completedPages);
  let review: ReturnType<typeof stopAtVerifiedReview>;
  try {
    const captured = await runtime.review.capture(signal);
    const structure = await inspectWorkdayReview(captured.page);
    review = stopAtVerifiedReview({ ...captured.request, structure });
  } catch {
    return signal.aborted
      ? cancelled(invocation.config.journeyId, completedPages)
      : errorFailure(
          invocation.config.journeyId,
          "review_failed",
          "mcp_internal_error",
          completedPages,
        );
  }
  if (
    review.kind !== "review_confirmed" ||
    review.transition.journeyId !== invocation.config.journeyId ||
    review.transition.status !== "review_reached" ||
    review.proof.finalSubmit.present !== true ||
    review.proof.validationErrorCount !== 0
  ) {
    return errorFailure(
      invocation.config.journeyId,
      "review_failed",
      "page_incomplete",
      completedPages,
    );
  }

  if (signal.aborted) return cancelled(invocation.config.journeyId, completedPages);
  try {
    const forbiddenTokens = await runtime.privacy.forbiddenTokens(signal);
    if (forbiddenTokens.length === 0) {
      return errorFailure(
        invocation.config.journeyId,
        "evidence_failed",
        "evidence_unavailable",
        completedPages,
      );
    }
    const resumeVerified = application.value.pageChecks.some(
      ({ page }) => page === "resume",
    );
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
        resumeVerified
          ? { kind: "resume", status: "verified", verifiedCount: 1 }
          : { kind: "resume", status: "missing", verifiedCount: 0 },
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
      missingEvidence: resumeVerified ? [] : ["resume_verification"],
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
    return signal.aborted
      ? cancelled(invocation.config.journeyId, completedPages)
      : errorFailure(
          invocation.config.journeyId,
          "evidence_failed",
          "mcp_internal_error",
          completedPages,
        );
  }

  return {
    ok: true,
    terminal: reviewTerminal(invocation.config.journeyId, completedPages),
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

function verifiedAccount(
  value: Stage2UnsealedAccountProofV1,
  invocation: Stage2RealJourneyInvocation,
): boolean {
  return value.schemaVersion === 1 &&
    value.proofRevision === "s2-account-session-proof-v1" &&
    value.status === "unsealed" &&
    value.sourceRevision === invocation.source.sourceRevision &&
    value.configSha256 === invocation.config.configSha256 &&
    value.revisionId === invocation.config.revisionId &&
    value.approvalId === invocation.config.approvalId &&
    value.journeyId === invocation.config.journeyId &&
    value.targetHandleId === invocation.config.targetHandleId &&
    value.accountState === "application_ready" &&
    value.independentlyObservedVerifiedState === true &&
    value.messageBodyRetained === false && value.submitActivated === false;
}

function verifiedPreReview(
  value: Extract<ApplicationWalkResult, { readonly ok: true }>,
): boolean {
  if (
    !value.ok || value.value.checkpoint !== "pre_review" ||
    value.value.completedPages !== value.value.pageChecks.length ||
    value.value.completedPages > maximumApplicationPageVisits ||
    value.value.submitActivated !== false || value.value.privacyScan !== "pass" ||
    !isValidApplicationPageSequence(value.value.pageChecks.map(({ page }) => page))
  ) return false;
  return value.value.pageChecks.every((check) =>
    check.checkpoint === checkpointForApplicationPage(check.page) &&
    check.independentlyVerified === true &&
    Number.isSafeInteger(check.requiredFields) && check.requiredFields >= 0 &&
    check.verifiedFields === check.requiredFields && check.duplicateRows === 0
  );
}

function factualAccountFailure(
  journeyId: string,
  fact: NonNullable<Extract<Stage2UnsealedAccountProofResult, { readonly ok: false }>["fact"]>,
): Extract<Stage2RealJourneyResult, { readonly ok: false }> {
  if (fact.kind === "manual_intervention") {
    return failure(fact.reason, {
      schemaVersion: 4,
      journeyId: journeyId as TerminalResultV4["journeyId"],
      status: "blocked",
      completedPages: 0,
      factualOutcome: { source: "account_access", result: fact },
    });
  }
  return failure("account_verification_failed", {
    schemaVersion: 4,
    journeyId: journeyId as TerminalResultV4["journeyId"],
    status: "blocked",
    completedPages: 0,
    factualOutcome: { source: "target_identity", result: fact },
  });
}

function stableAccountError(value: string): S2StableErrorCode {
  return Object.hasOwn(s2StableErrorPolicy, value)
    ? value as S2StableErrorCode
    : "verification_input_invalid";
}

function errorFailure<Code extends Stage2RealJourneyFailureCode>(
  journeyId: string,
  code: Code,
  errorCode: S2StableErrorCode,
  completedPages: number,
): { readonly ok: false; readonly code: Code; readonly terminal: TerminalResultV4 } {
  return failure(code, {
    schemaVersion: 4,
    journeyId: journeyId as TerminalResultV4["journeyId"],
    status: "failed",
    completedPages: boundedPages(completedPages),
    errorCode,
  });
}

function cancelled(
  journeyId: string,
  completedPages: number,
): Extract<Stage2RealJourneyResult, { readonly ok: false }> {
  return failure("operation_cancelled", {
    schemaVersion: 4,
    journeyId: journeyId as TerminalResultV4["journeyId"],
    status: "cancelled",
    completedPages: boundedPages(completedPages),
  });
}

function failure<Code extends Stage2RealJourneyFailureCode>(
  code: Code,
  terminal: TerminalResultV4,
): { readonly ok: false; readonly code: Code; readonly terminal: TerminalResultV4 } {
  return Object.freeze({ ok: false, code, terminal });
}

function reviewTerminal(journeyId: string, completedPages: number): TerminalResultV4 {
  return {
    schemaVersion: 4,
    journeyId: journeyId as TerminalResultV4["journeyId"],
    status: "review_reached",
    completedPages: boundedPages(completedPages),
  };
}

function boundedPages(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximumApplicationPageVisits
    ? value
    : 0;
}
