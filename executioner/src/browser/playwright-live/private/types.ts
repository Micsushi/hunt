import type {
  LiveSessionId,
  TargetIdentityV1,
} from "../../../contracts/live/index.ts";
import type { SemanticAccountPageAdapter } from "./account-page-types.ts";
import type { SemanticPostingNavigationAdapter } from "./account-navigation-types.ts";
import type { SemanticVerificationNavigationAdapter } from "./verification-navigation-types.ts";

export interface PersistentBrowserRuntimeValues {
  readonly targetUrl: string;
  readonly profilePath: string;
  readonly admittedAt: string;
  readonly leaseExpiresAt: string;
}

export interface PersistentBrowserRuntimeBinding {
  forPersistentBrowser(): PersistentBrowserRuntimeValues;
}

export interface PersistentPage {
  goto(
    target: string,
    options?: { readonly waitUntil?: "commit" | "domcontentloaded" },
  ): Promise<unknown>;
  isClosed(): boolean;
  close(): Promise<unknown>;
}

export interface PersistentContext {
  pages(): PersistentPage[];
  newPage(): Promise<PersistentPage>;
  close(): Promise<unknown>;
}

export interface PersistentContextLauncher {
  launchPersistentContext(
    profilePath: string,
    options: { readonly headless: boolean },
  ): Promise<PersistentContext>;
}

export interface ApprovedTargetBinding {
  readonly identity: TargetIdentityV1;
  readonly approved: {
    readonly host: string;
    readonly tenant: string;
    readonly posting: string;
  };
}

export interface ValueFreeOwnedPageSnapshot {
  readonly schemaVersion: 1;
  readonly traitIds: readonly string[];
  readonly controlCount: number;
  readonly requiredControlCount: number;
  readonly optionCount: number;
}

export type OwnedTargetObservation =
  | { readonly ownership: "foreign" }
  | {
      readonly ownership: "owned";
      readonly snapshot: ValueFreeOwnedPageSnapshot;
      readonly target:
        | { readonly kind: "matched" }
        | {
            readonly kind: "target_mismatch";
            readonly dimension: "host" | "tenant" | "posting";
          }
        | { readonly kind: "target_ambiguous" }
        | {
            readonly kind: "posting_unavailable";
            readonly reason: "not_found" | "closed" | "removed" | "unavailable" | "maintenance" | "runtime_error";
          };
    };

export interface OwnedTargetProbe {
  inspect(
    page: PersistentPage,
    expectedTarget: ApprovedTargetBinding,
    signal: AbortSignal,
  ): Promise<OwnedTargetObservation>;
}

export interface OwnedTargetInspection {
  readonly target: Extract<OwnedTargetObservation, { ownership: "owned" }>["target"];
  readonly snapshot: ValueFreeOwnedPageSnapshot;
}

export interface ProfileMarkerV1 {
  readonly schemaVersion: 1;
  readonly journeyId: string;
  readonly profileLeaseId: string;
  readonly sessionId: LiveSessionId;
  readonly target: TargetIdentityV1;
  readonly admittedAt: string;
  readonly leaseExpiresAt: string;
}

export interface ProfileStore {
  read(profilePath: string): Promise<unknown>;
  write(profilePath: string, marker: ProfileMarkerV1): Promise<void>;
  cleanup(profilePath: string, marker: ProfileMarkerV1): Promise<void>;
  cleanupPartial(profilePath: string): Promise<void>;
}

export interface PlaywrightPersistentBrowserSessionOptions {
  readonly binding: PersistentBrowserRuntimeBinding;
  readonly launcher: PersistentContextLauncher;
  readonly probe: OwnedTargetProbe;
  readonly profiles: ProfileStore;
  readonly accountPage?: SemanticAccountPageAdapter;
  readonly postingNavigation?: SemanticPostingNavigationAdapter;
  readonly verificationNavigation?: SemanticVerificationNavigationAdapter;
  readonly inspectionHoldBeforeCleanup?: () => Promise<void>;
  readonly ids: () => LiveSessionId;
  readonly timeoutMs: number;
}
