import { randomBytes } from "node:crypto";

import type { LiveSessionId } from "../../contracts/live/index.ts";
import { FileProfileStore } from "./private/file-profile-store.ts";
import { PlaywrightPersistentContextLauncher } from "./private/playwright-launcher.ts";
import { PlaywrightAccountPageAdapter } from "./private/playwright-account-page.ts";
import type {
  OwnedTargetProbe,
  PersistentBrowserRuntimeBinding,
} from "./private/types.ts";
import { PlaywrightPersistentBrowserSession } from "./session.ts";

export interface PlaywrightPersistentBrowserFactoryOptions {
  readonly binding: PersistentBrowserRuntimeBinding;
  readonly probe: OwnedTargetProbe;
  readonly timeoutMs?: number;
}

export function createPlaywrightPersistentBrowserSession(
  options: PlaywrightPersistentBrowserFactoryOptions,
): PlaywrightPersistentBrowserSession {
  return new PlaywrightPersistentBrowserSession({
    binding: options.binding,
    launcher: new PlaywrightPersistentContextLauncher(),
    probe: options.probe,
    profiles: new FileProfileStore(),
    accountPage: new PlaywrightAccountPageAdapter(),
    ids: nextSessionId,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
}

function nextSessionId(): LiveSessionId {
  return `live_session_${randomBytes(16).toString("hex")}` as LiveSessionId;
}
