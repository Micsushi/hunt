import { randomBytes } from "node:crypto";

import type { LiveSessionId } from "../../contracts/live/index.ts";
import { FileProfileStore } from "./private/file-profile-store.ts";
import { PlaywrightPersistentContextLauncher } from "./private/playwright-launcher.ts";
import {
  PlaywrightAccountPageAdapter,
  type PlaywrightAccountPageTraceEvent,
} from "./private/playwright-account-page.ts";
import {
  PlaywrightPostingNavigationAdapter,
  type PlaywrightPostingNavigationTraceEvent,
} from "./private/playwright-posting-navigation.ts";
import {
  PlaywrightVerificationNavigationAdapter,
  type PlaywrightVerificationNavigationTraceEvent,
} from "./private/playwright-verification-navigation.ts";
import type { PersistentBrowserRuntimeBinding } from "./private/types.ts";
import { WorkdayOwnedTargetProbe } from "./private/workday-owned-target-probe.ts";
import { PlaywrightPersistentBrowserSession } from "./session.ts";

export interface PlaywrightPersistentBrowserFactoryOptions {
  readonly binding: PersistentBrowserRuntimeBinding;
  readonly timeoutMs?: number;
  readonly inspectionHold?: () => Promise<void>;
  readonly accountTrace?: (
    event: PlaywrightAccountPageTraceEvent | PlaywrightPostingNavigationTraceEvent |
      PlaywrightVerificationNavigationTraceEvent,
  ) => void;
}

export function createPlaywrightPersistentBrowserSession(
  options: PlaywrightPersistentBrowserFactoryOptions,
): PlaywrightPersistentBrowserSession {
  const inspection = resolveLiveInspectionHoldPolicy(
    process.env.HUNT_C3_LIVE_INSPECTION_HOLD,
    options.timeoutMs,
  );
  const holdAction = options.inspectionHold ?? (inspection.holdMs === 0
    ? undefined
    : () => delay(inspection.holdMs));
  const inspectionHold = holdAction === undefined ? undefined : oneShot(holdAction);
  return new PlaywrightPersistentBrowserSession({
    binding: options.binding,
    launcher: new PlaywrightPersistentContextLauncher(),
    probe: new WorkdayOwnedTargetProbe(),
    profiles: new FileProfileStore(),
    accountPage: new PlaywrightAccountPageAdapter({
      trace: options.accountTrace,
      unsettledInspectionHold: inspectionHold,
    }),
    postingNavigation: new PlaywrightPostingNavigationAdapter({
      trace: options.accountTrace,
    }),
    verificationNavigation: new PlaywrightVerificationNavigationAdapter({
      trace: options.accountTrace,
    }),
    ids: nextSessionId,
    inspectionHoldBeforeCleanup: inspectionHold,
    timeoutMs: inspection.timeoutMs,
  });
}

export function resolveLiveInspectionHoldPolicy(
  flag: string | undefined,
  requestedTimeoutMs: number | undefined,
): { readonly holdMs: number; readonly timeoutMs: number } {
  const timeoutMs = requestedTimeoutMs ?? 30_000;
  return flag === "1"
    ? { holdMs: 180_000, timeoutMs: Math.max(timeoutMs, 210_000) }
    : { holdMs: 0, timeoutMs };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function oneShot(action: () => Promise<void>): () => Promise<void> {
  let held: Promise<void> | undefined;
  return () => held ??= action();
}

function nextSessionId(): LiveSessionId {
  return `live_session_${randomBytes(16).toString("hex")}` as LiveSessionId;
}
