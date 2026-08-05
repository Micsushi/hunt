import type { JourneyId, OperationId } from "../../../contracts/index.ts";
import type {
  LiveSessionId,
  PersistentBrowserErrorCode,
  TargetIdentityV1,
} from "../../../contracts/live/index.ts";
export const ownedApplicationPageAccess = Symbol("ownedApplicationPageAccess");
export const suspendOwnedApplicationSession = Symbol("suspendOwnedApplicationSession");

export interface OwnedApplicationPageRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly sessionId: LiveSessionId;
  readonly target: TargetIdentityV1;
  readonly now: string;
}

export type OwnedApplicationOperation =
  | { readonly kind: "observe" }
  | { readonly kind: "next"; readonly input: unknown }
  | { readonly kind: "reconcile_resume"; readonly input: unknown }
  | { readonly kind: "reconcile_profile"; readonly input: unknown }
  | { readonly kind: "reconcile_questionnaire"; readonly input: unknown }
  | { readonly kind: "inspect_recovery" }
  | { readonly kind: "reload" }
  | { readonly kind: "review_expectations" }
  | { readonly kind: "capture_review" };

export interface OwnedApplicationPageCapability {
  [ownedApplicationPageAccess](
    request: OwnedApplicationPageRequest,
    operation: OwnedApplicationOperation,
    signal: AbortSignal,
  ): Promise<import("../../../contracts/live/index.ts").LivePortResult<
    unknown,
    PersistentBrowserErrorCode
  >>;
  [suspendOwnedApplicationSession](
    request: import("../../../contracts/live/index.ts").PersistentBrowserCloseRequest,
    signal: AbortSignal,
  ): Promise<import("../../../contracts/live/index.ts").LivePortResult<
    void,
    PersistentBrowserErrorCode
  >>;
}

export function applicationOperationEffect(
  operation: OwnedApplicationOperation,
): "read" | "mutation" {
  return operation.kind === "observe" || operation.kind === "inspect_recovery" ||
      operation.kind === "review_expectations" || operation.kind === "capture_review"
    ? "read"
    : "mutation";
}

export function isOwnedApplicationOperation(
  value: unknown,
): value is OwnedApplicationOperation {
  if (typeof value !== "object" || value === null || !("kind" in value) ||
      typeof value.kind !== "string") return false;
  return new Set([
    "observe", "next", "reconcile_resume", "reconcile_profile",
    "reconcile_questionnaire", "inspect_recovery", "reload", "review_expectations",
    "capture_review",
  ]).has(value.kind);
}
