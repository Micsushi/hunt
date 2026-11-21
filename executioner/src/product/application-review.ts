import type { ReviewExpectedField } from '../browser/playwright-live/private/workday-application-runtime.ts';
import type { OwnedApplicationOperation } from '../browser/playwright-live/private/application-page-types.ts';
import { observeWorkdayPage, workdayObservationMessage } from '../ats/workday/page-observation.ts';
import { hostedReviewDigest, hostedReviewSnapshot } from "./hosted-application.ts";
import { createHash, randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { PlaywrightWorkdayApplicationPage } from "../ats/workday/application/playwright-page.ts";
import { applicationNextPages } from "../ats/workday/application/page-walk-contract.ts";
import { applicationTarget } from "./target.ts";
import { inspectWorkdayReview } from "../interaction/review/index.ts";
import { ApplicationPause, type ResumeUploadReceipt } from './application-contract.ts';
import { pause } from './application-wait.ts';

/** Explicit Review refresh only: navigate saved pages without answering anything. */
export async function restoreSavedReview(page: Page, reviewedUrl: string): Promise<void> {
  if (applicationTarget(reviewedUrl).ats !== "workday") {
    if(applicationTarget(page.url()).key !== applicationTarget(reviewedUrl).key) throw new ApplicationPause("The tab moved to a different job.");
    // The queue verifies this single page with its saved resume receipt next.
    return;
  }
  const expected = new URL(reviewedUrl);
  const signal = AbortSignal.timeout(120_000);
  const assertTarget = () => {
    signal.throwIfAborted();
    const current = new URL(page.url());
    if (current.origin !== expected.origin || current.pathname !== expected.pathname) {
      throw new ApplicationPause("The tab moved away from this saved application.");
    }
  };
  const observer = new PlaywrightWorkdayApplicationPage(page, { navigationSettleTimeoutMs: 15_000 });
  const journeyId = `review_${randomBytes(16).toString("hex")}` as never;
  for (let step = 0; step < 12; step++) {
    assertTarget();
    // Native tab reload may finish before Workday mounts its saved application.
    // Only observation is retried; never repeat a navigation effect here.
    const readinessDeadline = Date.now() + 30_000;
    let observed = await observer.observe(signal);
    while (!observed.ok && Date.now() < readinessDeadline) {
      await pause(signal);
      assertTarget();
      observed = await observer.observe(signal);
    }
    assertTarget();
    if (!observed.ok) throw new ApplicationPause("The saved application is not ready. Open it and inspect the employer page.");
    if (observed.value.page === "pre_review") {
      while (true) {
        assertTarget();
        try { await reviewDigest(page); assertTarget(); return; }
        catch (error) {
          if (!(error instanceof ApplicationPause) || Date.now() >= readinessDeadline) throw error;
          await pause(signal);
        }
      }
    }
    const advanced = await observer.next({ journeyId,
      from: observed.value.page, fromPageId: observed.value.pageId, allowed: applicationNextPages(observed.value.page) }, signal);
    assertTarget();
    if (!advanced.ok) throw new ApplicationPause("The saved application needs attention before Review. Open the tab and check missing or invalid fields; C3 has not filled any answers during this refresh.");
  }
  throw new ApplicationPause("The saved application did not reach Review within the navigation limit. Inspect its current page.");
}

export async function reviewSnapshot(page: Page, expectedResumeSha256?: string, resumeExpected?: boolean, resumeUpload?: ResumeUploadReceipt): Promise<{ digest: string; resumeExpected?: boolean }> {
  if (applicationTarget(page.url()).ats !== "workday") return hostedReviewSnapshot(page, expectedResumeSha256, resumeExpected, resumeUpload);
  return { digest: await reviewDigest(page) };
}

export async function reviewDigest(page: Page, expectedResumeSha256?: string): Promise<string> {
  if (applicationTarget(page.url()).ats !== "workday") return hostedReviewDigest(page, expectedResumeSha256);
  const observation = await observeWorkdayPage(page);
  if (observation.kind !== 'review') throw new ApplicationPause(workdayObservationMessage(observation) ?? 'The current employer page is not a confirmed Review. Inspect the tab again.');
  const review = page.locator('[data-automation-id="applyFlowReviewPage"]:visible');
  const structure = await inspectWorkdayReview(page);
  if (structure.reviewRoot.count !== 1 || !structure.reviewRoot.visible || structure.activeStep.count !== 1 ||
      !structure.activeStep.visible || structure.validationErrorCount !== 0 || structure.finalSubmit.count !== 1 ||
      !structure.finalSubmit.visible || !structure.finalSubmit.enabled) {
    throw new ApplicationPause("Review this application before submitting.");
  }
  const content = await review.evaluate(root => ({ text: (root as HTMLElement).innerText,
    controls: [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea")].map(el => ({
      name: el.name, value: el.value, checked: el instanceof HTMLInputElement ? el.checked : undefined,
    })) }));
  return createHash("sha256").update(page.url()).update(JSON.stringify(content)).digest("hex");
}

export async function verifyPreparedReview(
  page: Page,
  signal: AbortSignal,
  assertTarget: () => void,
  operation: <T>(op: OwnedApplicationOperation) => Promise<T>,
  continuingSavedDraft: boolean,
  reviewIssues: readonly { code: string; fieldIds: string[] }[],
  recordDiagnostic: (name: string, value: object) => void,
) {
  const expected=await operation<readonly ReviewExpectedField[]>({kind:'review_expectations'});
  let reviewReason:string|undefined=expected.length===0?'current_run_expectations_absent':undefined;
  if(!reviewReason)try {await operation({kind:'capture_review'});}
  catch(error) {
    if(!(error instanceof TypeError))throw error;
    if(/^Review field mismatch(?::|$)/.test(error.message))reviewReason='answer_mismatch';
    else if(/^Review (?:fields unavailable|field identity unavailable|identities ambiguous|row attribution unavailable|rows incomplete or ambiguous|fields incomplete|field hidden)$/.test(error.message))reviewReason='answer_verification_unavailable';
    else throw error;
  }
  const beforeReviewDigest=await reviewDigest(page);
  if(reviewReason)await pause(signal);
  assertTarget();
  const digest=await reviewDigest(page);
  if(beforeReviewDigest!==digest)throw new ApplicationPause('The Review page changed during verification. Inspect the draft before retrying.');
  const provisional=expected.filter(field=>field.provenance==='generated_default').map(field=>field.fieldId);
  recordDiagnostic('review-verification.json',{schemaVersion:1,status:reviewReason||provisional.length||continuingSavedDraft?'owner_review_required':'committed_answers_verified',
    reason:reviewReason??(provisional.length?'provisional_answers_present':continuingSavedDraft?'earlier_pages_not_reverified':null),earlierPagesNotReverified:continuingSavedDraft,
    expectedFields:expected.map(({fieldId,provenance})=>({fieldId,provenance})),issues:reviewIssues,provisionalFieldIds:provisional});
  return { reviewDigest: digest, needsOwnerReview: !!reviewReason || provisional.length>0 || continuingSavedDraft };
}
