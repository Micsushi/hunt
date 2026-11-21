import { recordComponentFailure, componentFailure } from './component-diagnostics.ts';
import { observeWorkdayPage, workdayObservationMessage } from '../ats/workday/page-observation.ts';
import { fillHostedApplication } from "./hosted-application.ts";
import type { Page } from "playwright";
import { WORKDAY_APPLICATION_PAGE_SELECTORS } from "../ats/workday/application/page-walk-contract.ts";
import { applicationTarget, productApplicationTarget } from "./target.ts";
import { prepareCurrentPage } from "./current-page-workflow.ts";
import { ApplicationPause, type ProductInput } from './application-contract.ts';
import { pause } from './application-wait.ts';
import { AccountAccessPause } from './application-authentication.ts';
import { fillApplicationAttempt } from './workday-workflow.ts';
export { ApplicationPause, type ProductInput, type ResumeUploadReceipt } from './application-contract.ts';
export { restoreSavedReview, reviewDigest, reviewSnapshot } from './application-review.ts';
export { submitReviewedApplication } from './application-submission.ts';

export async function fillApplication(page: Page, input: ProductInput, signal: AbortSignal,
  progress: (stage: string) => void): Promise<{ reviewDigest: string; completedPages: number; needsOwnerReview?: boolean; resumeExpected?: boolean }> {
  if ((input.profile as {profilePlan?:{mode?:unknown}} | null)?.profilePlan?.mode === 'synthetic_test_non_submittable') {
    throw new ApplicationPause('This is a synthetic test profile. Choose your saved personal profile before running a real application.');
  }
  const target = productApplicationTarget(input.url);
  if (target.ats === "generic") {
    return prepareCurrentPage(page, input, signal, progress);
  }
  if (target.ats !== "workday") return fillHostedApplication(page, input, signal, progress);
  const assertTarget = () => {
    signal.throwIfAborted();
    const current = new URL(page.url());
    if (current.hostname !== target.host) throw new ApplicationPause("The job tab moved to a different site. Resume from the original job.");
    if (/\/job\//i.test(current.pathname) && applicationTarget(current.href).key !== target.key) {
      throw new ApplicationPause("The tab now shows a different job.");
    }
  };
  let accountAttemptStarted = false;
  const attemptInput:ProductInput = {...input, recordAccountAction:input.recordAccountAction ? (event, trace) => {
    input.recordAccountAction!(event, trace);
    if (event === 'sign_in_attempted') accountAttemptStarted = true;
  } : undefined};
  let reloads = 0;
  let siteRecoveries = 0;
  let siteReopened = false;
  // Optional recovery probes must not replace the exception that stopped the run.
  const preserveFailure = async <T>(error: unknown, probe: () => Promise<T>): Promise<T> => {
    try { return await probe(); } catch { throw error; }
  };
  for (;;) {
    try {
      return await fillApplicationAttempt(page, attemptInput, signal, progress, assertTarget);
    } catch (error) {
      if (accountAttemptStarted && !signal.aborted) {
        const wrapped = new AccountAccessPause(error instanceof ApplicationPause
        ? error.message
        : 'The application stopped after sign-in. Inspect the tab before retrying; C3 will not repeat account access automatically.');
        const boundary = componentFailure(error);
        if (boundary) recordComponentFailure(wrapped, boundary.component, boundary.operation);
        throw wrapped;
      }
      if (error instanceof AccountAccessPause) throw error;
      if (page.isClosed()) throw error;
      assertTarget();
      if (await preserveFailure(error, async () =>
        await page.locator(`${WORKDAY_APPLICATION_PAGE_SELECTORS.assessment}:visible`).count() === 1 &&
        await page.getByText("You must complete the assessment test to continue with your job application.", { exact: true }).isVisible())) {
        throw new ApplicationPause("This employer requires an assessment before Review. Complete Take Assessment in the job tab, then resume C3.");
      }
      const recoveryObservation = await preserveFailure(error, () => observeWorkdayPage(page));
      if (recoveryObservation.kind === 'employer_coded_error') {
        const stopped = new ApplicationPause(workdayObservationMessage(recoveryObservation)!);
        recordComponentFailure(stopped, 'workflow', 'employer_coded_error');
        throw stopped;
      }
      const siteError = recoveryObservation.kind === 'employer_error';
      const sourceCommitFailed = error instanceof ApplicationPause &&
        error.message.startsWith('Application paused: profile_port_unavailable (source.how_did_you_hear).');
      const busyCatalog = error instanceof ApplicationPause && (sourceCommitFailed || /\bprofile_answer_missing\b/.test(error.message)) &&
        await preserveFailure(error, () => page.locator('[data-automation-id="responsiveMonikerPrompt"][aria-busy="true"]:visible').evaluateAll((prompts, sourceOnly) => {
          const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
          return prompts.some(prompt => {
            const widget = prompt.getAttribute("data-associated-widget");
            if (!widget) return false;
            const controls = [...document.querySelectorAll('[data-automation-id="applyFlowPage"] input[data-uxi-multiselect-id]')]
              .filter(control => control.getAttribute("data-uxi-multiselect-id") === widget && visible(control));
            return controls.length === 1 && controls[0]!.getAttribute("aria-required") === "true" &&
              (!sourceOnly || controls[0]!.id === 'source--source') &&
              ![...prompt.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]')].some(visible);
          });
        }, sourceCommitFailed));
      if (!siteError && !busyCatalog) throw error;
      if (siteError && siteRecoveries >= 3 && !siteReopened) {
        // Reloading can preserve a broken Workday route. Reopen the original
        // posting once, retaining the account session and saved application.
        siteReopened = true;
        progress("Reopening saved application after employer error");
        assertTarget();
        await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        continue;
      }
      if (siteError ? siteRecoveries >= 3 : reloads > 0) throw new ApplicationPause(!siteError && busyCatalog
        ? "Workday is still loading required choices after refreshing. The draft is preserved; retry when the site is available."
        : "Workday is still showing a site error after refreshing. The draft is preserved; retry when the site is available.");
      progress("Recovering employer page");
      if (siteError) {
        const backoff = [2_000, 5_000, 10_000][siteRecoveries++]!;
        for (let waited = 0; waited < backoff; waited += 500) {
          await pause(signal);
          assertTarget();
        }
        // A transient employer error can clear itself during the backoff.
        if ((await observeWorkdayPage(page)).kind !== 'employer_error') continue;
      }
      assertTarget();
      reloads++;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      assertTarget();
      if (siteError) {
        const settleDeadline = Date.now() + 15_000;
        while ((await observeWorkdayPage(page)).kind === 'employer_error' && Date.now() < settleDeadline) {
          await pause(signal);
          assertTarget();
        }
      } else {
        // Required-choice recovery retains its original single-reload behavior.
        for (let wait = 0; wait < 4; wait++) await pause(signal);
      }
    }
  }
}
