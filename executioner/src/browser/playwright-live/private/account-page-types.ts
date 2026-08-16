import type {
  JourneyId,
  OperationId,
} from "../../../contracts/index.ts";
import type {
  LivePortResult,
  LiveSessionId,
  PersistentBrowserErrorCode,
  TargetIdentityV1,
} from "../../../contracts/live/index.ts";
import type { PersistentPage } from "./types.ts";

export const accountFieldNames = [
  "email",
  "password",
  "password_confirmation",
] as const;
export type AccountFieldName = (typeof accountFieldNames)[number];

export const accountActionIntents = [
  "show_sign_in",
  "show_create_account",
  "show_password_reset",
  "submit_sign_in",
  "submit_create_account",
  "submit_password_reset_request",
  "submit_password_reset",
  "accept_terms",
  "request_verification_email",
] as const;
export type AccountActionIntent = (typeof accountActionIntents)[number];

export interface SemanticControlFact {
  readonly cardinality: number;
  readonly actionable: boolean;
}

export interface SemanticAccountPageAdapter {
  inspect(
    page: PersistentPage,
    control: AccountFieldName | AccountActionIntent,
  ): Promise<SemanticControlFact>;
  fill(page: PersistentPage, field: AccountFieldName, bytes: Uint8Array): Promise<void>;
  matches(page: PersistentPage, field: AccountFieldName, bytes: Uint8Array): Promise<boolean>;
  clear(page: PersistentPage, field: AccountFieldName): Promise<void>;
  isEmpty(page: PersistentPage, field: AccountFieldName): Promise<boolean>;
  activate(page: PersistentPage, action: AccountActionIntent): Promise<void>;
}

export interface OwnedAccountPageAccessRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly sessionId: LiveSessionId;
  readonly target: TargetIdentityV1;
  readonly now: string;
}

export interface OwnedAccountPageAccess {
  inspectField(
    field: AccountFieldName,
  ): Promise<LivePortResult<SemanticControlFact, PersistentBrowserErrorCode>>;
  inspectAction(
    action: AccountActionIntent,
  ): Promise<LivePortResult<SemanticControlFact, PersistentBrowserErrorCode>>;
  fill(
    field: AccountFieldName,
    bytes: Uint8Array,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
  matches(
    field: AccountFieldName,
    bytes: Uint8Array,
  ): Promise<LivePortResult<boolean, PersistentBrowserErrorCode>>;
  clear(
    field: AccountFieldName,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
  isEmpty(
    field: AccountFieldName,
  ): Promise<LivePortResult<boolean, PersistentBrowserErrorCode>>;
  activate(
    action: AccountActionIntent,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
}
