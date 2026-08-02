import type { JourneyId } from "../../../contracts/index.ts";
import type {
  LivePortResult,
  LiveSessionId,
  PersistentBrowserErrorCode,
  TargetIdentityV1,
  VerificationNavigationResult,
} from "../../../contracts/live/index.ts";
import type { PersistentPage } from "./types.ts";

export interface OwnedVerificationNavigationAccessRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly sessionId: LiveSessionId;
  readonly target: TargetIdentityV1;
  readonly now: string;
}

export interface ByteScopedVerificationTarget {
  readonly verificationTarget: Readonly<Uint8Array>;
  readonly approvedHost: Readonly<Uint8Array>;
  readonly approvedTenant: Readonly<Uint8Array>;
}

export interface ByteScopedVerificationBrowserCapability {
  navigateVerificationTarget(
    values: ByteScopedVerificationTarget,
    signal: AbortSignal,
  ): Promise<LivePortResult<VerificationNavigationResult, PersistentBrowserErrorCode>>;
}

export interface SemanticVerificationNavigationAdapter {
  navigate(page: PersistentPage, rawTargetBytes: Uint8Array): Promise<void>;
}
