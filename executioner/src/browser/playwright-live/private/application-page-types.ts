import type { JourneyId, OperationId } from "../../../contracts/index.ts";
import type {
  LiveSessionId,
  TargetIdentityV1,
} from "../../../contracts/live/index.ts";
import type { PersistentPage } from "./types.ts";

export const ownedApplicationPageAccess = Symbol("ownedApplicationPageAccess");

export interface OwnedApplicationPageRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly sessionId: LiveSessionId;
  readonly target: TargetIdentityV1;
  readonly now: string;
  readonly effect: "read" | "mutation";
}

export interface OwnedApplicationPageCapability {
  [ownedApplicationPageAccess]<Value>(
    request: OwnedApplicationPageRequest,
    signal: AbortSignal,
    use: (page: PersistentPage) => Promise<Value>,
  ): Promise<import("../../../contracts/live/index.ts").LivePortResult<
    Value,
    import("../../../contracts/live/index.ts").PersistentBrowserErrorCode
  >>;
}
