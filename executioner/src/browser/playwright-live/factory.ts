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
import type { OwnedWorkdayApplicationRuntimeOptions } from
  "./private/workday-application-runtime.ts";
import { WorkdayOwnedTargetProbe } from "./private/workday-owned-target-probe.ts";
import { PlaywrightPersistentBrowserSession } from "./session.ts";
import type { ExternalMonitorPort } from "./private/external-monitor-port.ts";
import type { PostingNavigationSessionTraceEvent } from
  "./private/account-navigation-types.ts";

export interface PlaywrightPersistentBrowserFactoryOptions {
  readonly binding: PersistentBrowserRuntimeBinding;
  readonly timeoutMs?: number;
  readonly inspectionHold?: () => Promise<void>;
  readonly accountTrace?: (
    event: PlaywrightAccountPageTraceEvent | PlaywrightPostingNavigationTraceEvent |
      PlaywrightVerificationNavigationTraceEvent | PostingNavigationSessionTraceEvent,
  ) => void;
  readonly applicationRuntime?: OwnedWorkdayApplicationRuntimeOptions;
  readonly externalMonitor?: ExternalMonitorPort;
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
    launcher: new PlaywrightPersistentContextLauncher({ timeoutMs: inspection.timeoutMs }),
    probe: new WorkdayOwnedTargetProbe(),
    profiles: new FileProfileStore(),
    accountPage: new PlaywrightAccountPageAdapter({
      trace: options.accountTrace,
      unsettledInspectionHold: inspectionHold,
      externallyMonitored: options.externalMonitor !== undefined,
    }),
    postingNavigation: new PlaywrightPostingNavigationAdapter({
      trace: options.accountTrace,
    }),
    accountNavigationTrace: options.accountTrace,
    verificationNavigation: new PlaywrightVerificationNavigationAdapter({
      trace: options.accountTrace,
    }),
    applicationRuntime: options.applicationRuntime,
    externalMonitor: options.externalMonitor,
    ids: nextSessionId,
    inspectionHoldBeforeCleanup: inspectionHold,
    timeoutMs: inspection.timeoutMs,
    applicationOperationTimeoutMs: resolveExternalMonitorOperationTimeoutMs(
      options.externalMonitor !== undefined,
      inspection.timeoutMs,
    ),
  });
}

export function resolveExternalMonitorOperationTimeoutMs(
  monitored: boolean,
  requestedTimeoutMs: number,
): number | undefined {
  return monitored ? Math.max(requestedTimeoutMs, 390_000) : undefined;
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
