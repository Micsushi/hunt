import type { Locator, Page } from "playwright";

import type {
  PostingNavigationAction,
  SemanticPostingNavigationAdapter,
} from "./account-navigation-types.ts";
import type { PersistentPage } from "./types.ts";

const ACCOUNT_OR_APPLICATION_DESTINATION = [
  '[data-automation-id="email"]',
  '[data-automation-id="signInPage"]',
  '[data-automation-id="createAccountPage"]',
  '[data-automation-id="authPage"]',
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
  | "posting_apply_manually_same_page_destination_observed"
  | "posting_apply_manually_popup_destination_observed"
  | "posting_apply_manually_destination_wait_failed";

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
  ): Promise<{ readonly cardinality: number; readonly actionable: boolean }> {
    await waitForAnyCandidate(page, action);
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
    }
  }

  #emit(event: PlaywrightPostingNavigationTraceEvent): void {
    try {
      this.#trace?.(event);
    } catch {
      // Diagnostics must never change navigation behavior.
    }
  }
}

async function waitForDestination(page: Pick<Page, "locator">): Promise<void> {
  await page.locator(ACCOUNT_OR_APPLICATION_DESTINATION).first().waitFor({
    state: "attached",
    timeout: 10_000,
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
  const candidates = candidateLocators(page, action);
  const matching: Locator[] = [];
  for (const candidate of candidates) {
    const count = await candidate.count();
    for (let index = 0; index < count; index += 1) matching.push(candidate.nth(index));
  }
  return matching;
}

function candidateLocators(
  page: PersistentPage,
  action: PostingNavigationAction,
): Locator[] {
  const semanticPage = page as unknown as Pick<Page, "getByRole">;
  return action === "apply_manually"
    ? [
        semanticPage.getByRole("button", { name: "Apply Manually", exact: true }),
        semanticPage.getByRole("link", { name: "Apply Manually", exact: true }),
      ]
    : [
        semanticPage.getByRole("button", { name: "Apply", exact: true }),
        semanticPage.getByRole("link", { name: "Apply", exact: true }),
        semanticPage.getByRole("button", { name: "Apply Now", exact: true }),
        semanticPage.getByRole("link", { name: "Apply Now", exact: true }),
        semanticPage.getByRole("button", { name: "Start Your Application", exact: true }),
        semanticPage.getByRole("link", { name: "Start Your Application", exact: true }),
      ];
}

async function waitForAnyCandidate(
  page: PersistentPage,
  action: PostingNavigationAction,
): Promise<void> {
  await Promise.any(candidateLocators(page, action).map((candidate) =>
    candidate.first().waitFor({ state: "visible", timeout: 5_000 })
  )).catch(() => undefined);
}
