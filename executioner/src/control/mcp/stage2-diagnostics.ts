import { isDeepStrictEqual } from "node:util";

import {
  parseMcpRequest,
  parseMcpResponseV4,
  providerError,
  s2StableErrorPolicy,
} from "../../contracts/index.ts";
import type {
  ErrorEnvelopeV3,
  McpRequest,
  McpRequestId,
  McpResponseV4,
  OperationId,
  OperationIdentityError,
  PortResult,
  S2CommonPhaseId,
  S2StableErrorCode,
  TerminalResultV4,
  JourneyId,
} from "../../contracts/index.ts";

export interface Stage2DiagnosticsReadback {
  read(): {
    readonly journeyId: JourneyId;
    readonly status: "passed" | "blocked" | "failed";
    readonly completedSteps: number;
    readonly terminal: TerminalResultV4 | null;
  };
}

export interface Stage2DiagnosticsMcpFacadeOptions {
  readonly readback: Stage2DiagnosticsReadback;
  readonly nextOperationId: () => PortResult<OperationId, OperationIdentityError>;
}

export function createStage2DiagnosticsMcpFacade(
  options: Stage2DiagnosticsMcpFacadeOptions,
) {
  const recorded = new Map<
    McpRequestId,
    {
      readonly operationId: OperationId;
      readonly request: McpRequest;
      readonly response: McpResponseV4;
    }
  >();

  return Object.freeze({
    async handle(input: unknown, signal: AbortSignal) {
      if (signal.aborted) {
        return { ok: false, error: providerError("operation_cancelled") } as const;
      }
      let request: McpRequest;
      try {
        request = parseMcpRequest(input);
      } catch {
        return { ok: false, error: providerError("mcp_request_invalid") } as const;
      }

      const existing = recorded.get(request.requestId);
      if (existing !== undefined) {
        if (isDeepStrictEqual(existing.request, request)) {
          return { ok: true, value: existing.response } as const;
        }
        return {
          ok: true,
          value: errorResponse(
            request.requestId,
            "journey_request_conflict",
            existing.operationId,
            "mcp",
          ),
        } as const;
      }

      const operation = options.nextOperationId();
      if (!operation.ok) {
        return { ok: false, error: providerError("mcp_internal_error") } as const;
      }
      const response = execute(request, operation.value, options.readback);
      recorded.set(request.requestId, {
        operationId: operation.value,
        request,
        response,
      });
      return { ok: true, value: response } as const;
    },
  });
}

function execute(
  request: McpRequest,
  operationId: OperationId,
  readback: Stage2DiagnosticsReadback,
): McpResponseV4 {
  if (
    request.method !== "journey_status" &&
    request.method !== "journey_result"
  ) {
    return errorResponse(
      request.requestId,
      "mcp_method_unknown",
      operationId,
      "mcp",
    );
  }

  let diagnostics;
  try {
    diagnostics = readback.read();
  } catch {
    return errorResponse(
      request.requestId,
      "evidence_unavailable",
      operationId,
      "account_access",
    );
  }
  if (diagnostics.journeyId !== request.params.journeyId) {
    return errorResponse(
      request.requestId,
      "journey_not_found",
      operationId,
      "account_access",
    );
  }

  if (request.method === "journey_status") {
    return admitted({
      schemaVersion: 4,
      requestId: request.requestId,
      ok: true,
      result: {
        kind: "status",
        progress: {
          journeyId: diagnostics.journeyId,
          status: diagnostics.status === "passed" ? "running" : diagnostics.status,
          completedSteps: diagnostics.completedSteps,
        },
      },
    });
  }
  if (diagnostics.terminal === null) {
    return errorResponse(
      request.requestId,
      "journey_busy",
      operationId,
      "account_access",
    );
  }
  return admitted({
    schemaVersion: 4,
    requestId: request.requestId,
    ok: true,
    result: { kind: "terminal", terminal: diagnostics.terminal },
  });
}

function errorResponse(
  requestId: McpRequestId,
  code: S2StableErrorCode,
  operationId: OperationId,
  phase: S2CommonPhaseId,
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
      step: "readback",
      retryable: policy.retryable,
      source: { kind: "operation", id: operationId },
    } as ErrorEnvelopeV3,
  });
}

function admitted(value: McpResponseV4): McpResponseV4 {
  return parseMcpResponseV4(value);
}
