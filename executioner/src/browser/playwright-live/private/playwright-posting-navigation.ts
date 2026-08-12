import type { Locator, Page } from "playwright";

import type {
  PostingNavigationAction,
  SemanticPostingNavigationAdapter,
} from "./account-navigation-types.ts";
import type { PersistentPage } from "./types.ts";
import {
  WORKDAY_COMPLETE_SIGN_IN_SELECTOR,
  WORKDAY_MODERN_SIGN_IN_SELECTOR,
} from "./workday-structural-catalog.ts";

const ACCOUNT_OR_APPLICATION_DESTINATION = [
  '[data-automation-id="email"]',
  '[data-automation-id="signInPage"]',
  '[data-automation-id="createAccountPage"]',
  '[data-automation-id="authPage"]',
  '[data-automation-id="signInContent"]:has([data-automation-id="SignInWithEmailButton"])',
  '[data-automation-id="emailVerificationPage"]',
  '[data-automation-id="candidateHomePage"]',
  '[data-automation-id="applyFlowMyInfoPage"]',
  '[data-automation-id="applyFlowApplicationQuestionsPage"]',
  '[data-automation-id="applyFlowReviewPage"]',
].join(", ");

const EMAIL_SIGN_IN_DESTINATION = [
  WORKDAY_MODERN_SIGN_IN_SELECTOR,
  WORKDAY_COMPLETE_SIGN_IN_SELECTOR,
  '[data-automation-id="signInPage"]',
  '[data-automation-id="createAccountPage"]',
  '[data-automation-id="emailVerificationPage"]',
  '[data-automation-id="candidateHomePage"]',
  '[data-automation-id="applyFlowMyInfoPage"]',
  '[data-automation-id="applyFlowApplicationQuestionsPage"]',
  '[data-automation-id="applyFlowReviewPage"]',
].join(", ");

export type PlaywrightPostingNavigationTraceEvent =
  | `posting_${PostingNavigationAction}_click_started`
  | `posting_${PostingNavigationAction}_click_succeeded`
  | `posting_${PostingNavigationAction}_click_failed`
  | "posting_cookie_decline_started"
  | "posting_cookie_decline_succeeded"
  | "posting_cookie_decline_failed"
  | "posting_apply_manually_same_page_destination_observed"
  | "posting_apply_manually_popup_destination_observed"
  | "posting_apply_manually_destination_wait_failed"
  | "posting_sign_in_with_email_same_page_destination_observed"
  | "posting_sign_in_with_email_destination_wait_failed"
  | "posting_account_sign_in_same_page_destination_observed"
  | "posting_account_sign_in_destination_wait_failed";

export interface PlaywrightPostingNavigationAdapterOptions {
  readonly trace?: (event: PlaywrightPostingNavigationTraceEvent) => void;
}

export class PlaywrightPostingNavigationAdapter
  implements SemanticPostingNavigationAdapter
{
  readonly #trace: PlaywrightPostingNavigationAdapterOptions["trace"];

  constructor(options: PlaywrightPostingNavigationAdapterOptions = {}) {
    this.#trace = options.trace;
  }

  async inspect(
    page: PersistentPage,
    action: PostingNavigationAction,
    options: { readonly waitForCandidate?: boolean } = {},
  ): Promise<{ readonly cardinality: number; readonly actionable: boolean }> {
    if (options.waitForCandidate !== false) await waitForAnyCandidate(page, action);
    const candidates = await matchingCandidates(page, action);
    const cardinality = candidates.length;
    const actionable = cardinality === 1 &&
      await candidates[0]!.isVisible() &&
      await candidates[0]!.isEnabled();
    return { cardinality, actionable };
  }

  async activate(
    page: PersistentPage,
    action: PostingNavigationAction,
  ): Promise<void> {
    await this.#declineCookieBanner(page);
    const candidates = await matchingCandidates(page, action);
    if (
      candidates.length !== 1 ||
      !await candidates[0]!.isVisible() ||
      !await candidates[0]!.isEnabled()
    ) throw new TypeError("posting navigation control changed before activation");
    const semanticPage = page as unknown as Pick<Page, "locator" | "waitForEvent">;
    const popupDestination = action === "apply_manually"
      ? waitForPopupDestination(semanticPage)
      : undefined;
    void popupDestination?.catch(() => undefined);
    this.#emit(`posting_${action}_click_started`);
    try {
      await candidates[0]!.click();
    } catch (error) {
      this.#emit(`posting_${action}_click_failed`);
      throw error;
    }
    this.#emit(`posting_${action}_click_succeeded`);
    if (action === "apply_manually") {
      const samePage = waitForDestination(semanticPage).then(
        () => "same_page" as const,
      );
      let destination: "same_page" | "popup";
      try {
        destination = await Promise.any([samePage, popupDestination!]);
      } catch {
        this.#emit("posting_apply_manually_destination_wait_failed");
        throw new TypeError("account or application destination did not settle");
      }
      this.#emit(
        destination === "popup"
          ? "posting_apply_manually_popup_destination_observed"
          : "posting_apply_manually_same_page_destination_observed",
      );
    } else if (action === "sign_in_with_email" || action === "account_sign_in") {
      try {
        await waitForEmailSignInDestination(semanticPage);
      } catch {
        this.#emit(`posting_${action}_destination_wait_failed`);
        throw new TypeError("account or application destination did not settle");
      }
      this.#emit(`posting_${action}_same_page_destination_observed`);
    }
  }

  #emit(event: PlaywrightPostingNavigationTraceEvent): void {
    try {
      this.#trace?.(event);
    } catch {
      // Diagnostics must never change navigation behavior.
    }
  }

  async #declineCookieBanner(page: PersistentPage): Promise<void> {
    const semanticPage = page as unknown as Pick<Page, "getByRole">;
    const candidate = semanticPage.getByRole("button", { name: "Decline", exact: true });
    const count = await candidate.count();
    if (count === 0) return;
    if (count !== 1) throw new TypeError("cookie decline control ambiguous");
    if (!await candidate.isVisible()) return;
    if (!await candidate.isEnabled()) throw new TypeError("cookie decline control unavailable");
    this.#emit("posting_cookie_decline_started");
    try {
      await candidate.click();
      await candidate.waitFor({ state: "hidden", timeout: 5_000 });
    } catch (error) {
      this.#emit("posting_cookie_decline_failed");
      throw error;
    }
    this.#emit("posting_cookie_decline_succeeded");
  }
}

async function waitForDestination(page: Pick<Page, "locator">): Promise<void> {
  await page.locator(ACCOUNT_OR_APPLICATION_DESTINATION).first().waitFor({
    state: "attached",
    timeout: 20_000,
  });
}

async function waitForPopupDestination(
  page: Pick<Page, "waitForEvent">,
): Promise<"popup"> {
  const popup = await page.waitForEvent("popup", { timeout: 10_000 });
  await waitForDestination(popup);
  return "popup";
}

async function matchingCandidates(
  page: PersistentPage,
  action: PostingNavigationAction,
): Promise<Locator[]> {
  for (const candidates of candidateLocatorTiers(page, action)) {
    const matching: Locator[] = [];
    for (const candidate of candidates) {
      const count = await candidate.count();
      for (let index = 0; index < count; index += 1) matching.push(candidate.nth(index));
    }
    if (matching.length > 0) return matching;
  }
  return [];
}

function candidateLocatorTiers(
  page: PersistentPage,
  action: PostingNavigationAction,
): Locator[][] {
  const semanticPage = page as unknown as Pick<Page, "getByRole" | "getByText">;
  return action === "account_sign_in"
    ? [
        [
          semanticPage.getByRole("link", { name: "Sign In", exact: true }),
          semanticPage.getByRole("button", { name: "Sign In", exact: true }),
        ],
        [semanticPage.getByText("Sign In", { exact: true })],
      ]
    : action === "apply_manually"
    ? [[
          semanticPage.getByRole("button", { name: "Apply Manually", exact: true }),
          semanticPage.getByRole("link", { name: "Apply Manually", exact: true }),
        ]]
    : action === "sign_in_with_email"
      ? [[
          semanticPage.getByRole("button", { name: "Sign in with email", exact: true }),
          semanticPage.getByRole("link", { name: "Sign in with email", exact: true }),
        ]]
      : [[
        semanticPage.getByRole("button", { name: "Apply", exact: true }),
        semanticPage.getByRole("link", { name: "Apply", exact: true }),
        semanticPage.getByRole("button", { name: "Apply Now", exact: true }),
        semanticPage.getByRole("link", { name: "Apply Now", exact: true }),
        semanticPage.getByRole("button", { name: "Start Your Application", exact: true }),
        semanticPage.getByRole("link", { name: "Start Your Application", exact: true }),
      ]];
}

async function waitForEmailSignInDestination(
  page: Pick<Page, "locator">,
): Promise<void> {
  await page.locator(EMAIL_SIGN_IN_DESTINATION).first().waitFor({
    state: "attached",
    timeout: 20_000,
  });
}

async function waitForAnyCandidate(
  page: PersistentPage,
  action: PostingNavigationAction,
): Promise<void> {
  await Promise.any(candidateLocatorTiers(page, action).flat().map((candidate) =>
    candidate.first().waitFor({ state: "visible", timeout: 20_000 })
  )).catch(() => undefined);
}
