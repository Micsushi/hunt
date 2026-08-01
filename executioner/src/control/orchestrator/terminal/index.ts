import { isDeepStrictEqual } from "node:util";

import {
  providerError,
  stableErrorPolicy,
  type CancellationError,
  type DurableJourneyState,
  type JourneyControl,
  type JourneyOperationResult,
  type JourneyStatus,
  type OperationId,
  type OrchestratorError,
  type PortError,
  type PortResult,
  type StableErrorCode,
  type StartJourneyCommand,
  type TerminalResult,
} from "../../../contracts/index.ts";
import { recordStartEvidence } from "../evidence/index.ts";
import { appendJourneyEvent } from "./events.ts";
import { reportJourneyFailure } from "./reporting.ts";
import { runPageLoop, type PageLoopFailure } from "../loop/index.ts";
import { boundedRetry, cancelledResult, contextualError, pageLoopFailure } from "./errors.ts";
import type {
  JourneyOrchestratorDependencies,
  JourneyOrchestratorOptions,
  TerminalIntent,
} from "./types.ts";

export type { JourneyOrchestratorDependencies, JourneyOrchestratorOptions } from "./types.ts";

type ControlResult = PortResult<
  JourneyOperationResult,
  OrchestratorError | CancellationError
>;

interface OperationRecord {
  readonly request: StartJourneyCommand | Parameters<JourneyControl["cancel"]>[0];
  readonly result: Promise<ControlResult>;
}

interface JourneyRun {
  readonly controller: AbortController;
  state: DurableJourneyState;
  status: JourneyStatus;
  completedPages: number;
  cancelRequested: boolean;
  task?: Promise<void>;
  terminal?: TerminalResult;
  terminalPromise?: Promise<TerminalResult | null>;
  terminalizationError?: OrchestratorError;
}

const terminalStatuses = new Set<JourneyStatus>([
  "review_reached",
  "blocked",
  "cancelled",
  "failed",
]);

export function createJourneyOrchestrator(
  dependencies: JourneyOrchestratorDependencies,
  options: JourneyOrchestratorOptions = {},
): JourneyControl {
  const stateRetryLimit = boundedRetry(options.stateRetryLimit ?? 1);
  const operations = new Map<OperationId, OperationRecord>();
  const journeys = new Map<string, JourneyRun>();
  let activeStart = false;
  let activeRun: JourneyRun | undefined;

  return {
    start(request, signal) {
      return ownOperation(request, signal, () => start(request, signal));
    },
    cancel(request, signal) {
      return ownOperation(request, signal, () => cancel(request, signal));
    },
    async status(request, signal) {
      if (signal.aborted) return cancelledResult();
      const run = journeys.get(request.journeyId);
      return run === undefined
        ? { ok: false, error: providerError("journey_not_found") }
        : { ok: true, value: run.status };
    },
    async result(request, signal) {
      if (signal.aborted) return cancelledResult();
      const run = journeys.get(request.journeyId);
      if (run === undefined) {
        return { ok: false, error: providerError("journey_not_found") };
      }
      return run.terminal === undefined
        ? {
            ok: false,
            error:
              run.terminalizationError ?? providerError("journey_busy"),
          }
        : { ok: true, value: run.terminal };
    },
  };

  function ownOperation(
    request: OperationRecord["request"],
    signal: AbortSignal,
    execute: () => Promise<ControlResult>,
  ): Promise<ControlResult> {
    if (signal.aborted) return Promise.resolve(cancelledResult());
    const existing = operations.get(request.operationId);
    if (existing !== undefined) {
      return isDeepStrictEqual(existing.request, request)
        ? existing.result
        : Promise.resolve({
            ok: false,
            error: providerError("journey_request_conflict"),
          });
    }
    const result = execute();
    operations.set(request.operationId, {
      request: structuredClone(request),
      result,
    });
    return result;
  }

  async function start(
    request: StartJourneyCommand,
    signal: AbortSignal,
  ): Promise<ControlResult> {
    if (
      activeStart ||
      (activeRun !== undefined && activeRun.terminal === undefined)
    ) {
      return { ok: false, error: providerError("journey_busy") };
    }
    activeStart = true;
    try {
      const bootstrapped = await dependencies.intake.bootstrap(request, signal);
      if (!bootstrapped.ok) {
        if (bootstrapped.error.code === "operation_cancelled") return cancelledResult();
        return {
          ok: false,
          error: contextualError(
            "journey_request_conflict",
            bootstrapped.error,
            request.operationId,
          ),
        };
      }
      if (signal.aborted) return cancelledResult();
      const bootstrap = bootstrapped.value;
      const previous = journeys.get(bootstrap.journeyId);
      if (previous !== undefined) {
        return {
          ok: false,
          error: providerError(
            previous.terminal === undefined
              ? "journey_busy"
              : "journey_already_terminal",
          ),
        };
      }
      if (terminalStatuses.has(bootstrap.state.status)) {
        return { ok: false, error: providerError("journey_already_terminal") };
      }
      if (bootstrap.state.status !== "ready") {
        return { ok: false, error: providerError("journey_busy") };
      }

      const run: JourneyRun = {
        controller: new AbortController(),
        state: bootstrap.state,
        status: bootstrap.state.status,
        completedPages: 0,
        cancelRequested: false,
      };
      const running = await transition(run, "running", null, signal);
      if (!running.ok) {
        if (running.error.code === "operation_cancelled") return cancelledResult();
        return {
          ok: false,
          error: contextualError(
            "journey_request_conflict",
            running.error,
            request.operationId,
          ),
        };
      }
      run.state = running.value;
      run.status = "running";
      journeys.set(bootstrap.journeyId, run);
      activeRun = run;
      run.task = executeJourney(run, bootstrap.inputs, request.operationId);
      return {
        ok: true,
        value: {
          operationId: request.operationId,
          journeyId: bootstrap.journeyId,
          accepted: true,
        },
      };
    } finally {
      activeStart = false;
    }
  }

  async function cancel(
    request: Parameters<JourneyControl["cancel"]>[0],
    signal: AbortSignal,
  ): Promise<ControlResult> {
    const run = journeys.get(request.journeyId);
    if (run === undefined) {
      return { ok: false, error: providerError("journey_not_found") };
    }
    if (run.terminal !== undefined) {
      return { ok: false, error: providerError("journey_already_terminal") };
    }
    if (run.terminalPromise !== undefined || run.cancelRequested) {
      return { ok: false, error: providerError("journey_busy") };
    }
    const cancelling = await transition(run, "cancelling", run.state.pageId, signal);
    if (!cancelling.ok) {
      if (cancelling.error.code === "operation_cancelled") return cancelledResult();
      return {
        ok: false,
        error: contextualError("journey_busy", cancelling.error, request.operationId),
      };
    }
    run.state = cancelling.value;
    run.status = "cancelling";
    run.cancelRequested = true;
    run.controller.abort();
    await run.task;
    return {
      ok: true,
      value: {
        operationId: request.operationId,
        journeyId: request.journeyId,
        accepted: true,
      },
    };
  }

  async function executeJourney(
    run: JourneyRun,
    inputs: Parameters<typeof runPageLoop>[1]["inputs"],
    sourceId: OperationId,
  ): Promise<void> {
    const started = await appendJourneyEvent(
      dependencies,
      run.state.journeyId,
      {
        kind: "step_started",
        component: "F9",
        phase: "orchestration",
        step: "start",
        sourceId,
      },
      run.controller.signal,
    );
    if (!started.ok) {
      await failJourney(run, pageLoopFailure(started.error, "observability", "append", sourceId));
      return;
    }
    const evidence = await recordStartEvidence(
      dependencies,
      run.state.journeyId,
      run.controller.signal,
    );
    if (!evidence.ok) {
      if (
        run.cancelRequested ||
        evidence.error.code === "operation_cancelled"
      ) {
        await commitTerminal(run, {
          status: "cancelled",
          step: "cancel",
          sourceId,
        });
        return;
      }
      await failJourney(
        run,
        pageLoopFailure(evidence.error, "evidence", "append", sourceId),
      );
      return;
    }
    const loop = await runPageLoop(
      dependencies,
      { journeyId: run.state.journeyId, inputs, sourceId },
      run.controller.signal,
      options,
    );
    if (!loop.ok) {
      if (loop.error.sessionId !== undefined) {
        const closed = await closeSession(loop.error.sessionId);
        if (!closed.ok) {
          await failJourney(
            run,
            pageLoopFailure(
              closed.error,
              "browser",
              "close",
              sourceId,
              "uncertain",
            ),
          );
          return;
        }
      }
      if (
        run.cancelRequested ||
        loop.error.error.code === "operation_cancelled"
      ) {
        await commitTerminal(run, {
          status: "cancelled",
          step: "cancel",
          sourceId,
        });
      } else {
        await failJourney(run, loop.error);
      }
      return;
    }
    run.completedPages = loop.value.completedPages;
    const closed = await closeSession(loop.value.sessionId);
    if (!closed.ok) {
      await failJourney(
        run,
        pageLoopFailure(closed.error, "browser", "close", sourceId, "uncertain"),
      );
      return;
    }
    if (run.cancelRequested) {
      await commitTerminal(run, {
        status: "cancelled",
        step: "cancel",
        sourceId,
      });
      return;
    }
    if (loop.value.kind === "blocked") {
      await commitTerminal(run, {
        status: "blocked",
        step: loop.value.step,
        phase: loop.value.phase,
        component: loop.value.component,
        sourceId: loop.value.sourceId,
        factualOutcome: loop.value.factualOutcome,
      });
      return;
    }
    await commitTerminal(run, {
      status: "review_reached",
      step: "stop_review",
      sourceId,
    });
  }

  async function failJourney(
    run: JourneyRun,
    loopFailure: PageLoopFailure,
  ): Promise<void> {
    await reportJourneyFailure(
      dependencies,
      run.state.journeyId,
      loopFailure,
    );
    await commitTerminal(run, {
      status: "failed",
      step: "report",
      sourceId: loopFailure.sourceId,
      errorCode: loopFailure.error.code,
    });
  }

  async function commitTerminal(
    run: JourneyRun,
    intent: TerminalIntent,
  ): Promise<TerminalResult | null> {
    if (run.terminal !== undefined) return run.terminal;
    if (run.terminalPromise !== undefined) return run.terminalPromise;
    run.terminalPromise = (async () => {
      const persisted = await transition(
        run,
        intent.status,
        run.state.pageId,
        new AbortController().signal,
      );
      if (!persisted.ok) {
        run.terminalizationError = contextualError(
          "journey_busy",
          persisted.error,
          intent.sourceId,
        );
        return null;
      }
      run.state = persisted.value;
      run.status = persisted.value.status;
      const terminal: TerminalResult =
        intent.status === "failed"
          ? {
              schemaVersion: 3,
              journeyId: run.state.journeyId,
              status: "failed",
              completedPages: run.completedPages,
              errorCode: intent.errorCode,
            }
          : intent.status === "blocked"
            ? {
                schemaVersion: 3,
                journeyId: run.state.journeyId,
                status: "blocked",
                completedPages: run.completedPages,
                factualOutcome: intent.factualOutcome,
              }
          : {
              schemaVersion: 3,
              journeyId: run.state.journeyId,
              status: intent.status,
              completedPages: run.completedPages,
            };
      const appended = await appendJourneyEvent(
        dependencies,
        run.state.journeyId,
        {
          kind: "journey_terminal",
          component:
            intent.status === "failed"
              ? stableErrorPolicy[intent.errorCode].owner
              : intent.status === "blocked"
                ? intent.component
                : "F9",
          phase:
            intent.status === "failed"
              ? "terminal"
              : intent.status === "blocked"
                ? intent.phase
                : "orchestration",
          step: intent.step,
          sourceId: intent.sourceId,
        },
        new AbortController().signal,
        stateRetryLimit,
      );
      if (!appended.ok) {
        run.terminalizationError = contextualError(
          "journey_busy",
          appended.error,
          intent.sourceId,
        );
        return null;
      }
      run.terminal = terminal;
      run.terminalizationError = undefined;
      return terminal;
    })();
    const terminal = await run.terminalPromise;
    if (terminal === null) run.terminalPromise = undefined;
    if (terminal !== null && activeRun === run) activeRun = undefined;
    return terminal;
  }

  async function transition(
    run: JourneyRun,
    status: JourneyStatus,
    pageId: DurableJourneyState["pageId"],
    signal: AbortSignal,
  ): Promise<PortResult<DurableJourneyState, PortError<StableErrorCode>>> {
    const operationId = nextOperationId();
    if (!operationId.ok) return operationId;
    const command = {
      journeyId: run.state.journeyId,
      operationId: operationId.value,
      expectedRevision: run.state.revision,
      status,
      pageId,
    } as const;
    for (let attempt = 0; ; attempt += 1) {
      const result = await dependencies.state.transition(command, signal);
      if (result.ok) return { ok: true, value: result.value.state };
      if (!result.error.retryable || attempt >= stateRetryLimit) return result;
    }
  }

  function nextOperationId() {
    return dependencies.nextOperationId();
  }

  async function closeSession(sessionId: Parameters<JourneyOrchestratorDependencies["browser"]["close"]>[0]["sessionId"]) {
    return dependencies.browser.close(
      { sessionId },
      new AbortController().signal,
    );
  }

}
