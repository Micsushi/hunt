import type { Locator, Page } from "playwright";

import type {
  PostingNavigationAction,
  SemanticPostingNavigationAdapter,
} from "./account-navigation-types.ts";
import type { PersistentPage } from "./types.ts";

const ACCOUNT_OR_APPLICATION_DESTINATION = [
  '[data-automation-id="email"]',
  '[data-automation-id="signInSubmitButton"]',
  '[data-automation-id="createAccountSubmitButton"]',
  '[data-automation-id="emailVerificationPage"]',
  '[data-automation-id="candidateHomePage"]',
  '[data-automation-id="applyFlowMyInfoPage"]',
  '[data-automation-id="applyFlowApplicationQuestionsPage"]',
  '[data-automation-id="applyFlowReviewPage"]',
].join(", ");

export class PlaywrightPostingNavigationAdapter
  implements SemanticPostingNavigationAdapter
{
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
    await candidates[0]!.click();
    if (action === "apply_manually") {
      const semanticPage = page as unknown as Pick<Page, "locator">;
      await semanticPage.locator(ACCOUNT_OR_APPLICATION_DESTINATION).first().waitFor({
        state: "attached",
        timeout: 10_000,
      });
    }
  }
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
