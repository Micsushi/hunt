import { isDeepStrictEqual } from "node:util";

import { providerError } from "./types.ts";
import type {
  JourneyStatus,
  McpRequest,
  McpRequestId,
  McpResponse,
  OrchestratorError,
} from "./types.ts";

export type McpRecordedState =
  | { readonly kind: "pending" }
  | { readonly kind: "final"; readonly response: McpResponse }
  | { readonly kind: "failed"; readonly error: OrchestratorError };

export interface McpRequestRecord {
  readonly request: McpRequest;
  readonly state: McpRecordedState;
}

export type McpReplayDecision =
  | { readonly kind: "admit" }
  | { readonly kind: "replay"; readonly state: McpRecordedState }
  | {
      readonly kind: "record_busy";
      readonly state: Extract<McpRecordedState, { readonly kind: "failed" }>;
    }
  | {
      readonly kind: "conflict";
      readonly error: Extract<
        OrchestratorError,
        { readonly code: "journey_request_conflict" }
      >;
    };

export function decideMcpReplay(
  request: McpRequest,
  existing: McpRequestRecord | null,
  activeRequestId: McpRequestId | null,
): McpReplayDecision {
  if (existing !== null) {
    if (!isDeepStrictEqual(existing.request, request)) {
      return {
        kind: "conflict",
        error: providerError("journey_request_conflict"),
      };
    }
    return { kind: "replay", state: existing.state };
  }
  if (activeRequestId !== null) {
    return {
      kind: "record_busy",
      state: { kind: "failed", error: providerError("journey_busy") },
    };
  }
  return { kind: "admit" };
}

export type SessionLifecycle = "valid" | "invalidated";
export interface OperationLifecycle {
  readonly journey: JourneyStatus;
  readonly session: SessionLifecycle;
}

export type OperationLifecycleEvent =
  | "start"
  | "cancel_requested"
  | "cancel_confirmed"
  | "effect_uncertain"
  | "review_reached"
  | "failed";

export function transitionOperationLifecycle(
  current: OperationLifecycle,
  event: OperationLifecycleEvent,
): OperationLifecycle | null {
  if (current.journey === "ready" && event === "start") {
    return { journey: "running", session: "valid" };
  }
  if (current.journey === "running" && event === "cancel_requested") {
    return { journey: "cancelling", session: "invalidated" };
  }
  if (current.journey === "running" && event === "effect_uncertain") {
    return { journey: "running", session: "invalidated" };
  }
  if (current.journey === "running" && event === "review_reached") {
    return { journey: "review_reached", session: "invalidated" };
  }
  if (current.journey === "running" && event === "failed") {
    return { journey: "failed", session: "invalidated" };
  }
  if (current.journey === "cancelling" && event === "cancel_confirmed") {
    return { journey: "cancelled", session: "invalidated" };
  }
  return null;
}
