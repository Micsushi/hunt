import { randomBytes } from "node:crypto";

import type { LiveSessionId } from "../../contracts/live/index.ts";
import { FileProfileStore } from "./private/file-profile-store.ts";
import { PlaywrightPersistentContextLauncher } from "./private/playwright-launcher.ts";
import {
  PlaywrightAccountPageAdapter,
  type PlaywrightAccountPageTraceEvent,
} from "./private/playwright-account-page.ts";
import { PlaywrightPostingNavigationAdapter } from "./private/playwright-posting-navigation.ts";
import type { PersistentBrowserRuntimeBinding } from "./private/types.ts";
import { WorkdayOwnedTargetProbe } from "./private/workday-owned-target-probe.ts";
import { PlaywrightPersistentBrowserSession } from "./session.ts";

export interface PlaywrightPersistentBrowserFactoryOptions {
  readonly binding: PersistentBrowserRuntimeBinding;
  readonly timeoutMs?: number;
  readonly accountTrace?: (event: PlaywrightAccountPageTraceEvent) => void;
}

export function createPlaywrightPersistentBrowserSession(
  options: PlaywrightPersistentBrowserFactoryOptions,
): PlaywrightPersistentBrowserSession {
  return new PlaywrightPersistentBrowserSession({
    binding: options.binding,
    launcher: new PlaywrightPersistentContextLauncher(),
    probe: new WorkdayOwnedTargetProbe(),
    profiles: new FileProfileStore(),
    accountPage: new PlaywrightAccountPageAdapter({ trace: options.accountTrace }),
    postingNavigation: new PlaywrightPostingNavigationAdapter(),
    ids: nextSessionId,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
}

function nextSessionId(): LiveSessionId {
  return `live_session_${randomBytes(16).toString("hex")}` as LiveSessionId;
}
