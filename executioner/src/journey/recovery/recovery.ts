import {
  s2StableErrorPolicy,
  type S2StableErrorCode,
} from "../../contracts/s2-common-wire.ts";
import { classifyRecoveryInterruption, RecoveryRetryBudget } from "./policy.ts";
import {
  reconcilableTruth,
  reconciliationRecord,
  reconciledVerification,
} from "./reconciliation.ts";
import type {
  RecoverBrowserInterruptionInput,
  RecoverBrowserInterruptionResult,
  RecoveryAttemptSnapshot,
  RecoveryBrowserPageTruth,
  RecoveryCheckpoint,
  RecoveryDependencies,
  RecoveryError,
  RecoveryKind,
  RecoveryReconciliationRecord,
  RecoveryTerminal,
  RecoveryTerminalCode,
} from "./types.ts";
import {
  sameCheckpoint,
  sameTarget,
  sameTerminal,
  validBrowserSnapshot,
  validCheckpoint,
  validTerminal,
} from "./validation.ts";

export async function recoverBrowserInterruption(
  dependencies: RecoveryDependencies,
  input: RecoverBrowserInterruptionInput,
  signal: AbortSignal,
): Promise<RecoverBrowserInterruptionResult> {
  if (signal.aborted) return failed("operation_cancelled");

  const loaded = await dependencies.state.load(
    {
      schemaVersion: 1,
      journeyId: input.journeyId,
      sourceRevision: input.sourceRevision,
    },
    signal,
  );
  if (!loaded.ok) return failed(loaded.error.code);
  if (loaded.value === null || !validCheckpoint(loaded.value)) {
    return failed("recovery_checkpoint_invalid");
  }
  const checkpoint = loaded.value;
  const budget = new RecoveryRetryBudget(input.retryLimits);

  if (
    checkpoint.journeyId !== input.journeyId ||
    checkpoint.sourceRevision !== input.sourceRevision
  ) {
    return stop(
      dependencies,
      input,
      budget.snapshot(),
      "recovery_state_ambiguous",
      signal,
    );
  }
  if (!sameTarget(checkpoint.target, input.expectedTarget)) {
    return stop(
      dependencies,
      input,
      budget.snapshot(),
      "recovery_target_mismatch",
      signal,
    );
  }
  if (checkpoint.terminal !== null) {
    return replayTerminal(dependencies, checkpoint.terminal, signal);
  }

  const initial = classifyRecoveryInterruption(input.interruption);
  if (!initial.recoverable) {
    return stop(
      dependencies,
      input,
      budget.snapshot(),
      initial.code,
      signal,
    );
  }

  while (true) {
    if (signal.aborted) return failed("operation_cancelled");
    const observed = await dependencies.browser.inspect(signal);
    if (observed.ok) {
      return reconcileBrowserTruth(
        dependencies,
        input,
        checkpoint,
        initial.kind,
        budget.snapshot(),
        observed.value,
        signal,
      );
    }
    if (observed.error.code === "operation_cancelled") {
      return failed("operation_cancelled");
    }
    const interruption = classifyRecoveryInterruption({
      code: observed.error.code as never,
      effect: observed.error.code === "browser_effect_uncertain"
        ? "possible"
        : "none",
    });
    if (!interruption.recoverable) {
      return stop(
        dependencies,
        input,
        budget.snapshot(),
        interruption.code,
        signal,
      );
    }
    if (!budget.consume(interruption.kind)) {
      return stop(
        dependencies,
        input,
        budget.snapshot(),
        "journey_retry_exhausted",
        signal,
      );
    }
    if (interruption.action === "inspect") continue;
    const repaired = interruption.action === "reload"
      ? await dependencies.browser.reload(signal)
      : await dependencies.browser.reattach(signal);
    if (!repaired.ok && repaired.error.code === "operation_cancelled") {
      return failed("operation_cancelled");
    }
  }
}

async function reconcileBrowserTruth(
  dependencies: RecoveryDependencies,
  input: RecoverBrowserInterruptionInput,
  checkpoint: RecoveryCheckpoint,
  interruption: RecoveryKind,
  attempts: RecoveryAttemptSnapshot,
  snapshot: { readonly pages: readonly RecoveryBrowserPageTruth[] },
  signal: AbortSignal,
): Promise<RecoverBrowserInterruptionResult> {
  const pages = validBrowserSnapshot(snapshot) ? snapshot.pages : [];
  const exact = pages.filter((page) => sameTarget(page.target, input.expectedTarget));
  if (exact.length === 0) {
    return recordedStop(
      dependencies,
      input,
      interruption,
      attempts,
      pages.length === 0 ? "ambiguous" : "mismatch",
      pages.length === 0
        ? "recovery_state_ambiguous"
        : "recovery_target_mismatch",
      signal,
    );
  }
  if (exact.length !== 1) {
    return recordedStop(
      dependencies,
      input,
      interruption,
      attempts,
      "ambiguous",
      "recovery_state_ambiguous",
      signal,
    );
  }
  const observed = exact[0];
  if (observed === undefined || !reconcilableTruth(checkpoint, observed)) {
    return recordedStop(
      dependencies,
      input,
      interruption,
      attempts,
      "matched",
      "recovery_state_ambiguous",
      signal,
    );
  }

  const verification = reconciledVerification(checkpoint, observed.verification);
  if (verification === null) {
    return recordedStop(
      dependencies,
      input,
      interruption,
      attempts,
      "matched",
      "recovery_state_ambiguous",
      signal,
    );
  }
  const state = Object.freeze({
    ...checkpoint,
    revision: checkpoint.revision + 1,
    page: Object.freeze({ ...observed.page }) as RecoveryCheckpoint["page"],
    verification,
  }) satisfies RecoveryCheckpoint;
  const record = reconciliationRecord(
    input,
    checkpoint,
    observed,
    interruption,
    attempts,
  );
  const saved = await dependencies.state.save(
    {
      schemaVersion: 1,
      journeyId: input.journeyId,
      operationId: input.operationId,
      expectedRevision: checkpoint.revision,
      state,
    },
    signal,
  );
  if (!saved.ok) return failed(saved.error.code);
  if (!validCheckpoint(saved.value) || !sameCheckpoint(saved.value, state)) {
    return failed("recovery_state_ambiguous");
  }
  const recorded = await dependencies.reconciliation.record({ record }, signal);
  if (!recorded.ok) return failed(recorded.error.code);
  return { ok: true, value: { kind: "resumed", state: saved.value, reconciliation: record } };
}

async function recordedStop(
  dependencies: RecoveryDependencies,
  input: RecoverBrowserInterruptionInput,
  interruption: RecoveryKind,
  attempts: RecoveryAttemptSnapshot,
  target: RecoveryReconciliationRecord["target"],
  code: RecoveryTerminalCode,
  signal: AbortSignal,
): Promise<RecoverBrowserInterruptionResult> {
  const record = Object.freeze({
    schemaVersion: 1,
    journeyId: input.journeyId,
    operationId: input.operationId,
    interruption,
    target,
    page: "unresolved",
    verification: "unresolved",
    outcome: "stop",
    attempts,
  }) satisfies RecoveryReconciliationRecord;
  const recorded = await dependencies.reconciliation.record({ record }, signal);
  if (!recorded.ok) return failed(recorded.error.code);
  return commitStop(dependencies, input, attempts, code, signal);
}

async function stop(
  dependencies: RecoveryDependencies,
  input: RecoverBrowserInterruptionInput,
  attempts: RecoveryAttemptSnapshot,
  code: RecoveryTerminalCode,
  signal: AbortSignal,
): Promise<RecoverBrowserInterruptionResult> {
  const classification = classifyRecoveryInterruption(input.interruption);
  const record = Object.freeze({
    schemaVersion: 1,
    journeyId: input.journeyId,
    operationId: input.operationId,
    interruption: classification.recoverable
      ? classification.kind
      : "nonrecoverable",
    target: code === "recovery_target_mismatch" ? "mismatch" : "ambiguous",
    page: "unresolved",
    verification: "unresolved",
    outcome: "stop",
    attempts,
  }) satisfies RecoveryReconciliationRecord;
  const recorded = await dependencies.reconciliation.record({ record }, signal);
  if (!recorded.ok) return failed(recorded.error.code);
  return commitStop(dependencies, input, attempts, code, signal);
}

async function commitStop(
  dependencies: RecoveryDependencies,
  input: RecoverBrowserInterruptionInput,
  attempts: RecoveryAttemptSnapshot,
  code: RecoveryTerminalCode,
  signal: AbortSignal,
): Promise<RecoverBrowserInterruptionResult> {
  const terminal = Object.freeze({
    schemaVersion: 1,
    journeyId: input.journeyId,
    operationId: input.operationId,
    code,
    retryable: false,
    attempts,
  }) satisfies RecoveryTerminal;
  return replayTerminal(dependencies, terminal, signal);
}

async function replayTerminal(
  dependencies: RecoveryDependencies,
  terminal: RecoveryTerminal,
  signal: AbortSignal,
): Promise<RecoverBrowserInterruptionResult> {
  const committed = await dependencies.terminal.commit({ terminal }, signal);
  if (!committed.ok) return failed(committed.error.code);
  if (!validTerminal(committed.value) || !sameTerminal(committed.value, terminal)) {
    return failed("recovery_state_ambiguous");
  }
  return { ok: true, value: { kind: "terminal", terminal: committed.value } };
}

function failed(code: S2StableErrorCode): { readonly ok: false; readonly error: RecoveryError } {
  const stableCode = Object.hasOwn(s2StableErrorPolicy, code)
    ? code
    : "recovery_state_ambiguous";
  const policy = s2StableErrorPolicy[stableCode];
  return {
    ok: false,
    error: { code: stableCode, retryable: policy.retryable },
  };
}
