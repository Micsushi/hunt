import { isDeepStrictEqual } from "node:util";

import {
  parseMcpRequest,
  parseMcpResponseV4,
  parseTerminalResultV4,
  providerError,
  s2StableErrorPolicy,
  type ErrorEnvelopeV3,
  type JourneyId,
  type McpRequest,
  type McpRequestId,
  type McpResponseV4,
  type McpTransportError,
  type OperationId,
  type OperationIdentityError,
  type PortError,
  type PortResult,
  type ProfileId,
  type ResumeId,
  type S2CommonPhaseId,
  type S2StableErrorCode,
  type TerminalResultV4,
  type JobId,
} from "../../contracts/index.ts";

export interface Stage2McpBoundJourney {
  readonly journeyId: JourneyId;
  readonly targetHandleId: JobId;
  readonly resumeRef: ResumeId;
  readonly profileRef: ProfileId;
}

export interface Stage2McpControlOptions {
  readonly bound: Stage2McpBoundJourney;
  readonly nextOperationId: () => PortResult<
    OperationId,
    OperationIdentityError
  >;
  readonly run: (signal: AbortSignal) => Promise<TerminalResultV4>;
}

type HandleResult = PortResult<
  McpResponseV4,
  McpTransportError | PortError<"operation_cancelled">
>;

export interface Stage2McpControl {
  handle(input: unknown, signal: AbortSignal): Promise<HandleResult>;
  close(): Promise<void>;
}

/**
 * Controls one already-prepared Stage 2 journey. Paths, browser objects,
 * selectors, applicant values, and Submit authority are deliberately absent.
 */
export function createStage2McpControl(
  options: Stage2McpControlOptions,
): Stage2McpControl {
  const bound = Object.freeze({ ...options.bound });
  const recorded = new Map<
    McpRequestId,
    {
      readonly operationId: OperationId;
      readonly request: McpRequest;
      response: Promise<McpResponseV4>;
    }
  >();
  const controller = new AbortController();
  const reservedRecords = new Set<ReservedRecord>();
  let state: "idle" | "running" | "terminal" = "idle";
  let task: Promise<TerminalResultV4> | undefined;
  let terminal: TerminalResultV4 | undefined;

  return Object.freeze({
    async handle(input: unknown, signal: AbortSignal): Promise<HandleResult> {
      if (signal.aborted) {
        return { ok: false, error: providerError("operation_cancelled") };
      }
      let request: McpRequest;
      try {
        request = parseMcpRequest(input);
      } catch {
        return { ok: false, error: providerError("mcp_request_invalid") };
      }

      const existing = recorded.get(request.requestId);
      if (existing !== undefined) {
        return {
          ok: true,
          value: isDeepStrictEqual(existing.request, request)
            ? await existing.response
            : errorResponse(
                request.requestId,
                "journey_request_conflict",
                existing.operationId,
                "orchestration",
                "validate",
              ),
        };
      }

      const reservation = recordReservation(request);
      if (reservation === null) {
        return { ok: false, error: providerError("mcp_internal_error") };
      }
      const allocated = options.nextOperationId();
      if (!allocated.ok) {
        return { ok: false, error: providerError("mcp_internal_error") };
      }
      if (reservation !== "ordinary") reservedRecords.add(reservation);
      const record = {
        operationId: allocated.value,
        request,
        response: Promise.resolve(null as never) as Promise<McpResponseV4>,
      };
      const response = execute(request, allocated.value).catch(() =>
        errorResponse(
          request.requestId,
          "mcp_internal_error",
          allocated.value,
          "mcp",
          "readback",
        )
      );
      record.response = response;
      recorded.set(request.requestId, record);
      return { ok: true, value: await response };
    },
    async close(): Promise<void> {
      if (state === "terminal") return;
      controller.abort();
      if (task !== undefined) {
        await task;
        reconcileCancellation();
        state = "terminal";
        return;
      }
      terminal = cancelledTerminal(0);
      state = "terminal";
    },
  });

  async function execute(
    request: McpRequest,
    operationId: OperationId,
  ): Promise<McpResponseV4> {
    if (request.method === "start_journey") {
      if (!matchesBinding(request, bound)) {
        return errorResponse(
          request.requestId,
          "journey_input_invalid",
          operationId,
          "orchestration",
          "validate",
        );
      }
      if (state !== "idle") {
        return errorResponse(
          request.requestId,
          state === "running" ? "journey_busy" : "journey_already_terminal",
          operationId,
          "orchestration",
          "start",
        );
      }
      state = "running";
      task = Promise.resolve()
        .then(() => options.run(controller.signal))
        .then(validTerminal, () => failedTerminal("mcp_internal_error"))
        .then((value) => {
          terminal = value;
          state = "terminal";
          return value;
        });
      return admitted({
        schemaVersion: 4,
        requestId: request.requestId,
        ok: true,
        result: { kind: "accepted", operationId, journeyId: bound.journeyId },
      });
    }

    if (request.params.journeyId !== bound.journeyId || state === "idle") {
      return errorResponse(
        request.requestId,
        "journey_not_found",
        operationId,
        "orchestration",
        "readback",
      );
    }

    if (request.method === "cancel_journey") {
      if (state === "terminal") {
        return errorResponse(
          request.requestId,
          "journey_already_terminal",
          operationId,
          "orchestration",
          "cancel",
        );
      }
      controller.abort();
      await task;
      reconcileCancellation();
      state = "terminal";
      return admitted({
        schemaVersion: 4,
        requestId: request.requestId,
        ok: true,
        result: { kind: "accepted", operationId, journeyId: bound.journeyId },
      });
    }

    if (request.method === "journey_status") {
      return admitted({
        schemaVersion: 4,
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "status",
          progress: {
            journeyId: bound.journeyId,
            status: terminal?.status ?? "running",
            completedSteps: terminal?.completedPages ?? 0,
          },
        },
      });
    }

    return terminal === undefined
      ? errorResponse(
          request.requestId,
          "journey_busy",
          operationId,
          "orchestration",
          "readback",
        )
      : admitted({
          schemaVersion: 4,
          requestId: request.requestId,
          ok: true,
          result: { kind: "terminal", terminal },
        });
  }

  function recordReservation(request: McpRequest): "ordinary" | ReservedRecord | null {
    if (recorded.size < MAX_ORDINARY_RECORDED_REQUESTS) return "ordinary";
    if (recorded.size >= MAX_RECORDED_REQUESTS) return null;
    if (
      request.method === "start_journey" ||
      request.params.journeyId !== bound.journeyId
    ) return null;
    const eligible = request.method === "cancel_journey"
      ? state === "running"
      : state === "terminal";
    return eligible && !reservedRecords.has(request.method)
      ? request.method
      : null;
  }

  function reconcileCancellation(): void {
    if (terminal?.status === "failed") return;
    terminal = cancelledTerminal(terminal?.completedPages ?? 0);
  }

  function validTerminal(value: TerminalResultV4): TerminalResultV4 {
    try {
      const parsed = parseTerminalResultV4(value);
      return parsed.journeyId === bound.journeyId
        ? parsed
        : failedTerminal("mcp_internal_error");
    } catch {
      return failedTerminal("mcp_internal_error");
    }
  }

  function failedTerminal(errorCode: S2StableErrorCode): TerminalResultV4 {
    return {
      schemaVersion: 4,
      journeyId: bound.journeyId,
      status: "failed",
      completedPages: 0,
      errorCode,
    };
  }

  function cancelledTerminal(completedPages: number): TerminalResultV4 {
    return {
      schemaVersion: 4,
      journeyId: bound.journeyId,
      status: "cancelled",
      completedPages,
    };
  }
}

const MAX_RECORDED_REQUESTS = 256;
const MAX_ORDINARY_RECORDED_REQUESTS = MAX_RECORDED_REQUESTS - 3;
type ReservedRecord = "cancel_journey" | "journey_status" | "journey_result";

function matchesBinding(
  request: Extract<McpRequest, { readonly method: "start_journey" }>,
  bound: Stage2McpBoundJourney,
): boolean {
  return request.params.jobId === bound.targetHandleId &&
    request.params.resumeId === bound.resumeRef &&
    request.params.profileId === bound.profileRef;
}

function errorResponse(
  requestId: McpRequestId,
  code: S2StableErrorCode,
  operationId: OperationId,
  phase: S2CommonPhaseId,
  step: ErrorEnvelopeV3["step"],
): McpResponseV4 {
  const policy = s2StableErrorPolicy[code];
  return admitted({
    schemaVersion: 4,
    requestId,
    ok: false,
    error: {
      schemaVersion: 3,
      code,
      component: policy.owner,
      phase,
      step,
      retryable: policy.retryable,
      source: { kind: "operation", id: operationId },
    } as ErrorEnvelopeV3,
  });
}

function admitted(value: McpResponseV4): McpResponseV4 {
  return parseMcpResponseV4(value);
}
