import { chromium } from "playwright";

import type {
  PersistentContext,
  PersistentContextLauncher,
} from "./types.ts";

export class PlaywrightPersistentContextLauncher
  implements PersistentContextLauncher
{
  async launchPersistentContext(
    profilePath: string,
    options: { readonly headless: boolean },
  ): Promise<PersistentContext> {
    return chromium.launchPersistentContext(profilePath, {
      headless: options.headless,
    });
  }
}
