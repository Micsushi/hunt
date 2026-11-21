import type { Page } from "playwright";
import { applicationTarget } from "./target.ts";
import { workdayReviewSignatures } from "../interaction/review/index.ts";
import { ApplicationPause } from './application-contract.ts';
import { reviewDigest } from './application-review.ts';

/** Separate from the filling engine: called only by a fresh, explicit per-job confirmation. */
export async function submitReviewedApplication(page: Page, expectedDigest: string): Promise<"submitted" | "submission_uncertain"> {
  if (applicationTarget(page.url()).ats !== "workday") throw new ApplicationPause("Submission is not enabled for this ATS. Review and submit on the employer site.");
  if (await reviewDigest(page) !== expectedDigest) throw new ApplicationPause("The application changed. Review it again before submitting.");
  await page.getByRole("button", { name: workdayReviewSignatures.finalSubmitName }).click({ timeout: 15_000 });
  try {
    await page.getByText(/your application (?:has been|was) submitted|thank you for applying/i).first().waitFor({ state: "visible", timeout: 30_000 });
    return "submitted";
  } catch { return "submission_uncertain"; }
}
