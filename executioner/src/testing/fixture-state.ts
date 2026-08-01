import {
  fixturePageId,
  fixtureSemanticHash,
  providerError,
  type CancellationError,
  type FixtureFault,
  type FixtureResetResult,
  type FixtureRunId,
  type FixtureRunState,
  type FixtureRuntimeError,
  type FixtureStartResult,
  type PortResult,
} from "../contracts/index.ts";

type FixtureResult<T> = PortResult<T, FixtureRuntimeError | CancellationError>;

export class FixtureState {
  #run: FixtureRunState | undefined;

  get snapshot(): FixtureRunState | undefined {
    return this.#run;
  }

  get fault(): FixtureFault {
    return this.#run?.enabledFault ?? null;
  }

  start(
    fixtureRunId: FixtureRunId,
    origin: string,
    signal: AbortSignal,
  ): FixtureResult<FixtureStartResult> {
    if (signal.aborted) {
      return { ok: false, error: providerError("operation_cancelled") };
    }
    if (this.#run !== undefined && this.#run.fixtureRunId !== fixtureRunId) {
      return { ok: false, error: providerError("fixture_already_started") };
    }
    this.#run ??= Object.freeze({
      fixtureRunId,
      pageId: fixturePageId("fixture-account"),
      enabledFault: null,
    });
    return {
      ok: true,
      value: Object.freeze({
        fixtureRunId,
        origin,
        pageId: this.#run.pageId,
      }),
    };
  }

  reset(
    fixtureRunId: FixtureRunId,
    signal: AbortSignal,
  ): FixtureResult<FixtureResetResult> {
    if (signal.aborted) {
      return { ok: false, error: providerError("operation_cancelled") };
    }
    if (this.#run?.fixtureRunId !== fixtureRunId) {
      return { ok: false, error: providerError("fixture_not_found") };
    }
    this.#run = Object.freeze({
      fixtureRunId,
      pageId: fixturePageId("fixture-account"),
      enabledFault: null,
    });
    return {
      ok: true,
      value: Object.freeze({
        fixtureRunId,
        semanticHash: fixtureSemanticHash("sha256.fixture-reset"),
      }),
    };
  }

  setFault(
    fixtureRunId: FixtureRunId,
    fault: FixtureFault,
    signal: AbortSignal,
  ): FixtureResult<void> {
    if (signal.aborted) {
      return { ok: false, error: providerError("operation_cancelled") };
    }
    if (this.#run?.fixtureRunId !== fixtureRunId) {
      return { ok: false, error: providerError("fixture_not_found") };
    }
    this.#run = Object.freeze({ ...this.#run, enabledFault: fault });
    return { ok: true, value: undefined };
  }

  clear(): void {
    this.#run = undefined;
  }
}
