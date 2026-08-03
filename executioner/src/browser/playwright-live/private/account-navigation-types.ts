import type { JourneyId, OperationId } from "../../../contracts/index.ts";
import type {
  LivePortResult,
  LiveSessionId,
  PersistentBrowserErrorCode,
  TargetIdentityV1,
} from "../../../contracts/live/index.ts";
import type { PersistentPage } from "./types.ts";

export type PostingNavigationAction =
  | "start_application"
  | "apply_manually"
  | "sign_in_with_email";

export interface SemanticPostingNavigationAdapter {
  inspect(
    page: PersistentPage,
    action: PostingNavigationAction,
  ): Promise<{ readonly cardinality: number; readonly actionable: boolean }>;
  activate(page: PersistentPage, action: PostingNavigationAction): Promise<void>;
}

export interface AccountEntryAdvanceRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly sessionId: LiveSessionId;
  readonly target: TargetIdentityV1;
  readonly now: string;
}

export type AccountEntryAdvanceResult =
  | { readonly kind: "account_boundary" }
  | { readonly kind: "target_mismatch"; readonly dimension: "host" | "tenant" | "posting" }
  | { readonly kind: "target_ambiguous" }
  | {
      readonly kind: "posting_unavailable";
      readonly reason: "not_found" | "closed" | "removed" | "unavailable";
    };

export type AccountEntryAdvancePortResult = LivePortResult<
  AccountEntryAdvanceResult,
  PersistentBrowserErrorCode
>;
