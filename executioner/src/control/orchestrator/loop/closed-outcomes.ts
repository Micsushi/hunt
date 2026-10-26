import {
  stableErrorPolicy,
  type FactualTerminalOutcome,
  type OperationId,
  type PhaseId,
  type PortError,
  type StableErrorCode,
  type StepId,
} from "../../../contracts/index.ts";

import type { PageLoopFailure } from "./index.ts";

export class ClosedFailure extends Error {
  readonly failure: PageLoopFailure;

  constructor(failure: PageLoopFailure) {
    super(failure.error.code);
    this.failure = failure;
  }
}

export class ClosedFactualOutcome extends Error {
  readonly factualOutcome: FactualTerminalOutcome;
  readonly component: "F5" | "F6" | "F8";
  readonly phase: "page_understanding" | "answer_resolution" | "verification";
  readonly step: "classify" | "resolve" | "verify";
  readonly sourceId: OperationId;

  constructor(
    factualOutcome: FactualTerminalOutcome,
    component: "F5" | "F6" | "F8",
    phase: "page_understanding" | "answer_resolution" | "verification",
    step: "classify" | "resolve" | "verify",
    sourceId: OperationId,
  ) {
    super(factualOutcome.result.kind);
    this.factualOutcome = factualOutcome;
    this.component = component;
    this.phase = phase;
    this.step = step;
    this.sourceId = sourceId;
  }
}

export function fail(
  error: PortError<StableErrorCode>,
  phase: PhaseId,
  step: StepId,
  effect: PageLoopFailure["effect"],
  sourceId: OperationId,
  verificationKind?: PageLoopFailure["verificationKind"],
): never {
  throw new ClosedFailure({
    error,
    component: stableErrorPolicy[error.code].owner,
    phase,
    step,
    sourceId,
    effect,
    ...(verificationKind === undefined ? {} : { verificationKind }),
  });
}

export function block(
  factualOutcome: FactualTerminalOutcome,
  component: "F5" | "F6" | "F8",
  phase: "page_understanding" | "answer_resolution" | "verification",
  step: "classify" | "resolve" | "verify",
  sourceId: OperationId,
): never {
  throw new ClosedFactualOutcome(
    factualOutcome,
    component,
    phase,
    step,
    sourceId,
  );
}
