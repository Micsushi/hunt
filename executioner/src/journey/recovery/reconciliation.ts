import type {
  RecoverBrowserInterruptionInput,
  RecoveryAttemptSnapshot,
  RecoveryBrowserPageTruth,
  RecoveryCheckpoint,
  RecoveryKind,
  RecoveryPageKind,
  RecoveryReconciliationRecord,
  RecoveryVerificationTruth,
} from "./types.ts";
import { recoveryPageOrder } from "./validation.ts";

export function reconciliationRecord(
  input: RecoverBrowserInterruptionInput,
  checkpoint: RecoveryCheckpoint,
  observed: RecoveryBrowserPageTruth,
  interruption: RecoveryKind,
  attempts: RecoveryAttemptSnapshot,
): RecoveryReconciliationRecord {
  const projectedOrder = recoveryPageOrder[checkpoint.page.kind];
  const observedOrder = recoveryPageOrder[observed.page.kind as RecoveryPageKind];
  const page = checkpoint.page.id === observed.page.id &&
      checkpoint.page.kind === observed.page.kind
    ? "matched"
    : projectedOrder === observedOrder
    ? "browser_replaced"
    : observedOrder > projectedOrder
    ? "browser_advanced"
    : "browser_regressed";
  const verification = observed.verification === "required"
    ? "verification_required"
    : observed.verification === "verified" && checkpoint.verification !== "verified"
    ? "browser_verified"
    : "matched";
  return Object.freeze({
    schemaVersion: 1,
    journeyId: input.journeyId,
    operationId: input.operationId,
    interruption,
    target: "matched",
    page,
    verification,
    outcome: "resume",
    attempts,
  });
}

export function reconcilableTruth(
  checkpoint: RecoveryCheckpoint,
  observed: RecoveryBrowserPageTruth,
): boolean {
  if (observed.page.kind === "unknown" || observed.page.kind === "ambiguous") {
    return false;
  }
  if (observed.verification === "unknown") return false;
  if (observed.page.kind === "verification") {
    return observed.verification === "required";
  }
  if (observed.verification === "required") return false;
  return !(checkpoint.verification === "required" && observed.verification !== "verified");
}

export function reconciledVerification(
  checkpoint: RecoveryCheckpoint,
  observed: RecoveryVerificationTruth,
): RecoveryCheckpoint["verification"] | null {
  if (observed === "unknown") return null;
  if (observed === "not_required" && checkpoint.verification === "required") {
    return null;
  }
  if (observed === "not_required" && checkpoint.verification === "verified") {
    return "verified";
  }
  return observed;
}
