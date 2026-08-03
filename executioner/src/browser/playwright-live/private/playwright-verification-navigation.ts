import type { PersistentPage } from "./types.ts";
import { PlaywrightPostingNavigationAdapter } from "./playwright-posting-navigation.ts";
import type { SemanticVerificationNavigationAdapter } from "./verification-navigation-types.ts";

export type PlaywrightVerificationNavigationTraceEvent =
  | "verification_navigation_goto_started"
  | "verification_navigation_commit_succeeded"
  | "verification_navigation_goto_failed"
  | "verification_navigation_email_sign_in_absent"
  | "verification_navigation_email_sign_in_started"
  | "verification_navigation_email_sign_in_succeeded"
  | "verification_navigation_email_sign_in_failed";

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
        await this.#enterEmailSignInIfPresent(page);
      } catch (error) {
        this.#emit("verification_navigation_goto_failed");
        throw error;
      }
    } finally {
      transientTarget = "";
    }
  }

  async #enterEmailSignInIfPresent(page: PersistentPage): Promise<void> {
    const semanticPage = page as unknown as {
      readonly getByRole?: unknown;
      readonly locator?: unknown;
    };
    if (
      typeof semanticPage.getByRole !== "function" ||
      typeof semanticPage.locator !== "function"
    ) {
      this.#emit("verification_navigation_email_sign_in_absent");
      return;
    }
    const navigation = new PlaywrightPostingNavigationAdapter();
    const control = await navigation.inspect(page, "sign_in_with_email");
    if (control.cardinality === 0) {
      this.#emit("verification_navigation_email_sign_in_absent");
      return;
    }
    if (control.cardinality !== 1 || !control.actionable) {
      this.#emit("verification_navigation_email_sign_in_failed");
      throw new TypeError("verification email sign-in control is not exact");
    }
    this.#emit("verification_navigation_email_sign_in_started");
    try {
      await navigation.activate(page, "sign_in_with_email");
      this.#emit("verification_navigation_email_sign_in_succeeded");
    } catch (error) {
      this.#emit("verification_navigation_email_sign_in_failed");
      throw error;
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
