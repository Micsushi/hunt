import {
  chromium,
  type BrowserContext,
} from "playwright";

import type {
  PersistentContext,
  PersistentContextLauncher,
} from "./types.ts";
import {
  visibleSecondaryWindowFromEnvironment,
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
    this.#visibleWindow = options.visibleWindow ?? visibleSecondaryWindowFromEnvironment;
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
      await revealVisibleWindow(context, visibleWindow);
      return context;
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }
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

export async function revealVisibleWindow(
  context: Pick<BrowserContext, "pages" | "newPage" | "newCDPSession">,
  window: VisibleSecondaryWindow,
): Promise<void> {
  const page = context.pages()[0] ?? await context.newPage();
  const session = await context.newCDPSession(page);
  try {
    const { windowId } = await session.send("Browser.getWindowForTarget") as {
      readonly windowId: number;
    };
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: window.x,
        top: window.y,
        width: window.width,
        height: window.height,
        windowState: "normal",
      },
    });
  } finally {
    await session.detach();
  }
}
