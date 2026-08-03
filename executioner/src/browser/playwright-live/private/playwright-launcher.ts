import {
  chromium,
  type BrowserContext,
} from "playwright";

import type {
  PersistentContext,
  PersistentContextLauncher,
} from "./types.ts";
import {
  minimizedSecondaryWindowForLiveTest,
  type VisibleSecondaryWindow,
} from "./windows-visible-secondary.ts";

type PersistentLaunch = (
  profilePath: string,
  options: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>,
) => Promise<BrowserContext>;

export interface PlaywrightPersistentContextLauncherOptions {
  readonly launch?: PersistentLaunch;
  readonly visibleWindow?: () => VisibleSecondaryWindow | undefined;
}

export class PlaywrightPersistentContextLauncher
  implements PersistentContextLauncher
{
  readonly #launch: PersistentLaunch;
  readonly #visibleWindow: () => VisibleSecondaryWindow | undefined;

  constructor(options: PlaywrightPersistentContextLauncherOptions = {}) {
    this.#launch = options.launch ?? ((profilePath, launchOptions) =>
      chromium.launchPersistentContext(profilePath, launchOptions));
    this.#visibleWindow = options.visibleWindow ?? minimizedSecondaryWindowForLiveTest;
  }

  async launchPersistentContext(
    profilePath: string,
    options: { readonly headless: boolean },
  ): Promise<PersistentContext> {
    const visibleWindow = options.headless ? undefined : this.#visibleWindow();
    const context = await this.#launch(profilePath, visibleWindow === undefined
      ? { headless: options.headless }
      : visiblePersistentLaunchOptions(visibleWindow));
    if (visibleWindow === undefined) return context;
    try {
      await verifyMinimizedSecondaryWindow(context, visibleWindow);
      return context;
    } catch (error) {
      await closeUnsafeWindowContext(context);
      throw error;
    }
  }
}

async function closeUnsafeWindowContext(context: BrowserContext): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await context.close();
      return;
    } catch {
      // One bounded retry handles a transient close race without hiding failure.
    }
  }
  throw new Error("live browser window safety cleanup failed");
}

export function visiblePersistentLaunchOptions(
  window: VisibleSecondaryWindow,
): NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]> {
  return {
    headless: false,
    viewport: null,
    args: [
      "--start-minimized",
      `--window-position=${window.x},${window.y}`,
      `--window-size=${window.width},${window.height}`,
    ],
  };
}

export async function verifyMinimizedSecondaryWindow(
  context: Pick<BrowserContext, "pages" | "newPage" | "newCDPSession">,
  window: VisibleSecondaryWindow,
): Promise<void> {
  const page = context.pages()[0] ?? await context.newPage();
  const session = await context.newCDPSession(page);
  try {
    const { windowId } = await session.send("Browser.getWindowForTarget") as {
      readonly windowId: number;
    };
    const { bounds } = await session.send("Browser.getWindowBounds", {
      windowId,
    }) as {
      readonly bounds: {
        readonly left?: number;
        readonly top?: number;
        readonly width?: number;
        readonly height?: number;
        readonly windowState?: string;
      };
    };
    if (bounds.windowState !== "minimized") {
      throw new Error("live browser did not remain minimized");
    }
    if (
      bounds.left !== window.x ||
      bounds.top !== window.y ||
      bounds.width !== window.width ||
      bounds.height !== window.height
    ) {
      throw new Error("live browser did not remain on the secondary monitor");
    }
  } finally {
    await session.detach();
  }
}
