import type {
  BrowserSession,
} from "../ports.ts";
import type {
  CancellationError,
  JourneyId,
  OperationId,
  PortError,
  PortResult,
} from "../types.ts";
import type {
  LiveBrowserSessionV1,
  LiveSessionId,
  TargetIdentityV1,
} from "./types.ts";

export const pinnedPageLoopBindingPolicy = {
  owner: "F3",
  schemaVersion: 1,
  opensPage: false,
  navigatesOnStart: false,
  retainsStartTarget: false,
  scheduler: "F9",
} as const;

export interface PinnedPageLoopBindingRequestV1 {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly session: LiveBrowserSessionV1;
  readonly expectedSessionId: LiveSessionId;
  readonly expectedTarget: TargetIdentityV1;
}

export interface PinnedPageLoopBrowserBinder {
  bind(
    request: PinnedPageLoopBindingRequestV1,
    signal: AbortSignal,
  ): Promise<
    PortResult<
      BrowserSession,
      PinnedPageLoopBindingError | CancellationError
    >
  >;
}

export type PinnedPageLoopBindingError = PortError<
  | "browser_target_invalid"
  | "browser_session_missing"
  | "browser_target_stale"
  | "browser_operation_replayed"
>;
