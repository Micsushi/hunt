import {
  parseMcpRequest,
  providerError,
  stableErrorPolicy,
  type ErrorEnvelope,
  type GuardRevision,
  type JourneyControl,
  type JourneyId,
  type McpJourneyApi,
  type McpRequest,
  type McpRequestId,
  type McpResponse,
  type McpTransportError,
  type OperationId,
  type OperationIdentityError,
  type PortError,
  type PortResult,
  type PrivacyGuard,
  type ProgressReader,
  type StableErrorCode,
} from "../../contracts/index.ts";
import { createOperationRegistry } from "../orchestrator/operations/index.ts";

export const mcpMethods = [
  "start_journey",
  "cancel_journey",
  "journey_status",
  "journey_result",
] as const satisfies readonly McpRequest["method"][];

export interface McpFacadeDependencies {
  readonly control: JourneyControl;
  readonly progress: ProgressReader;
  readonly privacy: PrivacyGuard;
  readonly nextOperationId: () => PortResult<
    OperationId,
    OperationIdentityError
  >;
  readonly guardRevision: GuardRevision;
  readonly startJourneyId: JourneyId;
}

type HandleResult = Awaited<ReturnType<McpJourneyApi["handle"]>>;

export function createMcpFacade(
  dependencies: McpFacadeDependencies,
): McpJourneyApi {
  const registry = createOperationRegistry(dependencies.nextOperationId);
  const pending = new Map<McpRequestId, Promise<HandleResult>>();
  const sources = new Map<McpRequestId, OperationId>();
  const recordedFailures = new Map<McpRequestId, McpResponse>();
  let activeOperationId: OperationId | undefined;

  return {
    async handle(input, signal) {
      if (signal.aborted) return cancelled();
      let request: McpRequest;
      try {
        request = parseMcpRequest(input);
      } catch {
        return { ok: false, error: providerError("mcp_request_invalid") };
      }

      const admission = registry.admit(request);
      if (admission.kind === "replay") {
        if (admission.state.kind === "final") {
          return { ok: true, value: admission.state.response };
        }
        if (admission.state.kind === "failed") {
          const recorded = recordedFailures.get(request.requestId);
          return recorded === undefined
            ? internalFailure()
            : { ok: true, value: recorded };
        }
        return (
          pending.get(request.requestId) ??
          Promise.resolve({
            ok: false,
            error: providerError("mcp_internal_error"),
          } as const)
        );
      }
      if (admission.kind === "conflict") {
        const sourceId = sourceFor(request.requestId);
        if (sourceId === null) return internalFailure();
        return {
          ok: true,
          value: errorResponse(
            request.requestId,
            admission.error,
            sourceId,
            "orchestration",
            "validate",
          ),
        };
      }
      if (admission.kind === "record_busy") {
        if (activeOperationId === undefined) return internalFailure();
        const response = errorResponse(
          request.requestId,
          admission.state.error,
          activeOperationId,
          "orchestration",
          "start",
        );
        recordedFailures.set(request.requestId, response);
        return { ok: true, value: response };
      }
      if (admission.kind === "failed") {
        return internalFailure();
      }

      sources.set(request.requestId, admission.operationId);
      activeOperationId = admission.operationId;
      const execution = execute(request, admission.operationId, signal);
      pending.set(request.requestId, execution);
      try {
        return await execution;
      } finally {
        pending.delete(request.requestId);
        if (activeOperationId === admission.operationId) {
          activeOperationId = undefined;
        }
      }
    },
  };

  async function execute(
    request: McpRequest,
    operationId: OperationId,
    signal: AbortSignal,
  ): Promise<HandleResult> {
    const journeyId =
      request.method === "start_journey"
        ? dependencies.startJourneyId
        : request.params.journeyId;
    const privacy = await dependencies.privacy.admit(
      {
        binding: {
          journeyId,
          attemptId: operationId,
          guardRevision: dependencies.guardRevision,
        },
        purpose: "privacy",
        input: {
          policyRevision: dependencies.guardRevision,
          semanticPayload: semanticPayload(request),
        },
      },
      signal,
    );
    if (!privacy.ok) {
      if (privacy.error.code === "operation_cancelled") {
        registry.discard(request.requestId);
        return cancelled();
      }
      return completeError(
        request,
        privacy.error,
        operationId,
        "privacy",
        "admit",
      );
    }

    if (request.method === "start_journey") {
      const result = await dependencies.control.start(
        { ...request.params, operationId },
        signal,
      );
      if (!result.ok) {
        if (result.error.code === "operation_cancelled") {
          registry.discard(request.requestId);
          return cancelled();
        }
        return completeError(
          request,
          result.error,
          operationId,
          "orchestration",
          "start",
        );
      }
      return complete(request, {
        schemaVersion: 3,
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "accepted",
          operationId: result.value.operationId,
          journeyId: result.value.journeyId,
        },
      });
    }

    if (request.method === "cancel_journey") {
      const result = await dependencies.control.cancel(
        { operationId, journeyId: request.params.journeyId },
        signal,
      );
      if (!result.ok) {
        if (result.error.code === "operation_cancelled") {
          registry.discard(request.requestId);
          return cancelled();
        }
        return completeError(
          request,
          result.error,
          operationId,
          "orchestration",
          "cancel",
        );
      }
      return complete(request, {
        schemaVersion: 3,
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "accepted",
          operationId: result.value.operationId,
          journeyId: result.value.journeyId,
        },
      });
    }

    if (request.method === "journey_status") {
      const status = await dependencies.control.status(request.params, signal);
      if (!status.ok) {
        if (status.error.code === "operation_cancelled") {
          registry.discard(request.requestId);
          return cancelled();
        }
        return completeError(
          request,
          status.error,
          operationId,
          "orchestration",
          "readback",
        );
      }
      const progress = await dependencies.progress.read(request.params, signal);
      if (!progress.ok) {
        if (progress.error.code === "operation_cancelled") {
          registry.discard(request.requestId);
          return cancelled();
        }
        return completeError(
          request,
          progress.error,
          operationId,
          "observability",
          "readback",
        );
      }
      return complete(request, {
        schemaVersion: 3,
        requestId: request.requestId,
        ok: true,
        result: { kind: "status", progress: progress.value },
      });
    }

    const result = await dependencies.control.result(request.params, signal);
    if (!result.ok) {
      if (result.error.code === "operation_cancelled") {
        registry.discard(request.requestId);
        return cancelled();
      }
      return completeError(
        request,
        result.error,
        operationId,
        "orchestration",
        "readback",
      );
    }
    return complete(request, {
      schemaVersion: 3,
      requestId: request.requestId,
      ok: true,
      result: { kind: "terminal", terminal: result.value },
    });
  }

  function complete(
    request: McpRequest,
    response: McpResponse,
  ): { readonly ok: true; readonly value: McpResponse } {
    registry.complete(request.requestId, response);
    return { ok: true, value: response };
  }

  function completeError(
    request: McpRequest,
    error: PortError<StableErrorCode>,
    operationId: OperationId,
    phase: ErrorEnvelope["phase"],
    step: ErrorEnvelope["step"],
  ) {
    return complete(
      request,
      errorResponse(request.requestId, error, operationId, phase, step),
    );
  }

  function sourceFor(requestId: McpRequestId): OperationId | null {
    const source = sources.get(requestId);
    if (source !== undefined) return source;
    const recorded = recordedFailures.get(requestId);
    return recorded?.ok === false && recorded.error.source.kind === "operation"
      ? recorded.error.source.id
      : null;
  }
}

function semanticPayload(request: McpRequest) {
  return request.method === "start_journey"
    ? {
        requestId: request.requestId,
        method: request.method,
        jobId: request.params.jobId,
        resumeId: request.params.resumeId,
        profileId: request.params.profileId,
      }
    : {
        requestId: request.requestId,
        method: request.method,
        journeyId: request.params.journeyId,
      };
}

export function errorResponse(
  requestId: McpRequestId,
  error: PortError<StableErrorCode>,
  operationId: OperationId,
  phase: ErrorEnvelope["phase"],
  step: ErrorEnvelope["step"],
): McpResponse {
  const cause = error.cause;
  return {
    schemaVersion: 3,
    requestId,
    ok: false,
    error: {
      schemaVersion: 2,
      code: error.code,
      component: stableErrorPolicy[error.code].owner,
      phase,
      step,
      retryable: error.retryable,
      source: { kind: "operation", id: operationId },
      ...(cause === undefined
        ? {}
        : {
            cause: {
              verification: "verified",
              code: cause.code,
              source: cause.source,
            },
          }),
    } as ErrorEnvelope,
  };
}

function cancelled() {
  return { ok: false, error: providerError("operation_cancelled") } as const;
}

function internalFailure() {
  return { ok: false, error: providerError("mcp_internal_error") } as const;
}
