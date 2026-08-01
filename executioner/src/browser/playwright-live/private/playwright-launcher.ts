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
    const context = await this.#launch(
      profilePath,
      visibleWindow === undefined
        ? { headless: options.headless }
        : {
            headless: false,
            viewport: null,
            args: [
              "--start-minimized",
              `--window-position=${visibleWindow.x},${visibleWindow.y}`,
              `--window-size=${visibleWindow.width},${visibleWindow.height}`,
            ],
          },
    );
    if (visibleWindow === undefined) return context;
    try {
      const page = context.pages()[0] ?? await context.newPage();
      const session = await context.newCDPSession(page);
      try {
        const { windowId } = await session.send("Browser.getWindowForTarget") as {
          readonly windowId: number;
        };
        await session.send("Browser.setWindowBounds", {
          windowId,
          bounds: {
            left: visibleWindow.x,
            top: visibleWindow.y,
            width: visibleWindow.width,
            height: visibleWindow.height,
            windowState: "normal",
          },
        });
      } finally {
        await session.detach();
      }
      return context;
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }
}
