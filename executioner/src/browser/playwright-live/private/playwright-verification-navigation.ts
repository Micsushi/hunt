import type { PersistentPage } from "./types.ts";
import type { SemanticVerificationNavigationAdapter } from "./verification-navigation-types.ts";

export class PlaywrightVerificationNavigationAdapter
  implements SemanticVerificationNavigationAdapter
{
  async navigate(page: PersistentPage, rawTargetBytes: Uint8Array): Promise<void> {
    let transientTarget = new TextDecoder("utf-8", { fatal: true }).decode(rawTargetBytes);
    try {
      await page.goto(transientTarget, { waitUntil: "domcontentloaded" });
    } finally {
      transientTarget = "";
    }
  }
}
