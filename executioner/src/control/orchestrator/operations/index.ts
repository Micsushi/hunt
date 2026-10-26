import {
  decideMcpReplay,
  type McpRecordedState,
  type McpReplayDecision,
  type McpRequest,
  type McpRequestId,
  type McpResponse,
  type OperationId,
  type OperationIdentityError,
  type OrchestratorError,
  type PortResult,
} from "../../../contracts/index.ts";

export type OperationAdmission =
  | { readonly kind: "execute"; readonly operationId: OperationId }
  | Exclude<McpReplayDecision, { readonly kind: "admit" }>
  | { readonly kind: "failed"; readonly error: OperationIdentityError };

export interface OperationRegistry {
  admit(request: McpRequest): OperationAdmission;
  complete(requestId: McpRequestId, response: McpResponse): void;
  fail(requestId: McpRequestId, error: OrchestratorError): void;
  discard(requestId: McpRequestId): void;
  snapshot(requestId: McpRequestId): McpRecordedState | null;
}

export function createOperationRegistry(
  allocateOperationId: () => PortResult<OperationId, OperationIdentityError>,
): OperationRegistry {
  const records = new Map<
    McpRequestId,
    { readonly request: McpRequest; state: McpRecordedState }
  >();
  let activeRequestId: McpRequestId | null = null;

  return {
    admit(request) {
      const existing = records.get(request.requestId) ?? null;
      const decision = decideMcpReplay(request, existing, activeRequestId);
      if (decision.kind !== "admit") {
        if (decision.kind === "record_busy") {
          records.set(request.requestId, {
            request: structuredClone(request),
            state: immutableCopy(decision.state),
          });
        }
        return immutableCopy(decision);
      }

      const allocated = allocateOperationId();
      if (!allocated.ok) return { kind: "failed", error: allocated.error };
      records.set(request.requestId, {
        request: structuredClone(request),
        state: { kind: "pending" },
      });
      activeRequestId = request.requestId;
      return { kind: "execute", operationId: allocated.value };
    },
    complete(requestId, response) {
      finish(requestId, { kind: "final", response });
    },
    fail(requestId, error) {
      finish(requestId, { kind: "failed", error });
    },
    discard(requestId) {
      const record = records.get(requestId);
      if (record?.state.kind !== "pending") return;
      records.delete(requestId);
      if (activeRequestId === requestId) activeRequestId = null;
    },
    snapshot(requestId) {
      const state = records.get(requestId)?.state;
      return state === undefined ? null : immutableCopy(state);
    },
  };

  function finish(requestId: McpRequestId, state: McpRecordedState): void {
    const record = records.get(requestId);
    if (record === undefined || record.state.kind !== "pending") {
      throw new Error("operation is not pending");
    }
    record.state = immutableCopy(state);
    if (activeRequestId === requestId) activeRequestId = null;
  }
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
