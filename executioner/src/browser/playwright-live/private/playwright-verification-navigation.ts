import type { PersistentPage } from "./types.ts";
import type { SemanticVerificationNavigationAdapter } from "./verification-navigation-types.ts";

export type PlaywrightVerificationNavigationTraceEvent =
  | "verification_navigation_goto_started"
  | "verification_navigation_commit_succeeded"
  | "verification_navigation_goto_failed";

export interface PlaywrightVerificationNavigationAdapterOptions {
  readonly trace?: (event: PlaywrightVerificationNavigationTraceEvent) => void;
}

export class PlaywrightVerificationNavigationAdapter
  implements SemanticVerificationNavigationAdapter
{
  readonly #trace: ((event: PlaywrightVerificationNavigationTraceEvent) => void) | undefined;

  constructor(options: PlaywrightVerificationNavigationAdapterOptions = {}) {
    this.#trace = options.trace;
  }

  async navigate(page: PersistentPage, rawTargetBytes: Uint8Array): Promise<void> {
    let transientTarget = new TextDecoder("utf-8", { fatal: true }).decode(rawTargetBytes);
    try {
      this.#emit("verification_navigation_goto_started");
      try {
        await page.goto(transientTarget, { waitUntil: "commit" });
        this.#emit("verification_navigation_commit_succeeded");
      } catch (error) {
        this.#emit("verification_navigation_goto_failed");
        throw error;
      }
    } finally {
      transientTarget = "";
    }
  }

  #emit(event: PlaywrightVerificationNavigationTraceEvent): void {
    try {
      this.#trace?.(event);
    } catch {
      // Observability cannot alter the browser effect.
    }
  }
}
