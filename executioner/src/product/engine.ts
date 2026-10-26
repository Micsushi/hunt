import { fillHostedApplication, hostedReviewDigest } from "./hosted-application.ts";
import { createHash, randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { generatedOperationId, disposeResumeArtifact } from "../contracts/index.ts";
import type { LiveBrowserSessionV1 } from "../contracts/live/index.ts";
import { OwnedWorkdayApplicationRuntime } from "../browser/playwright-live/private/workday-application-runtime.ts";
import type { OwnedApplicationOperation } from "../browser/playwright-live/private/application-page-types.ts";
import { PlaywrightWorkdayApplicationPage } from "../ats/workday/application/playwright-page.ts";
import { WORKDAY_APPLICATION_PAGE_SELECTORS, applicationNextPages } from "../ats/workday/application/page-walk-contract.ts";
import { runApplicationPageWalk, type ApplicationWalkDependencies, type ApplicationPortResult } from "../ats/workday/application/page-walk.ts";
import { PlaywrightAccountPageAdapter } from "../browser/playwright-live/private/playwright-account-page.ts";
import { PlaywrightPostingNavigationAdapter } from "../browser/playwright-live/private/playwright-posting-navigation.ts";
import { productSources, productQuestionLearning } from "./sources.ts";
import { join } from "node:path";
import { applicationTarget } from "./target.ts";
import { matchingUnavailable, WORKDAY_INLINE_VERIFICATION_SELECTORS, WORKDAY_VERIFICATION_EMAIL_SENT_SELECTORS, WORKDAY_SIGN_IN_REJECTION_SELECTORS, WORKDAY_ACCOUNT_FACT_SELECTORS, WORKDAY_RUNTIME_ERROR_DESTINATION_SELECTORS } from "../browser/playwright-live/private/workday-structural-catalog.ts";
import { inspectWorkdayReview, workdayReviewSignatures } from "../interaction/review/index.ts";

export interface ProductInput {
  url: string;
  profile: unknown;
  resume: Buffer;
  credentials?: { email: string; password: string };
  verifyEmail?: (page: Page, since: number, signal: AbortSignal) => Promise<void>;
  /** Internal queue-owned path; never accepted from an HTTP application request. */
  learningRoot?: string;
}
export class ApplicationPause extends Error {}
const id = () => randomBytes(16).toString("hex");
const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
});

export async function fillApplication(page: Page, input: ProductInput, signal: AbortSignal,
  progress: (stage: string) => void): Promise<{ reviewDigest: string; completedPages: number; needsOwnerReview?: boolean }> {
  const target = applicationTarget(input.url);
  if (target.ats !== "workday") return fillHostedApplication(page, input, signal, progress);
  const assertTarget = () => {
    signal.throwIfAborted();
    const current = new URL(page.url());
    if (current.hostname !== target.host) throw new ApplicationPause("The job tab moved to a different site. Resume from the original job.");
    if (/\/job\//i.test(current.pathname) && applicationTarget(current.href).key !== target.key) {
      throw new ApplicationPause("The tab now shows a different job.");
    }
  };
  let reloads = 0;
  let siteRecoveries = 0;
  let siteReopened = false;
  let draftRecoveries = 0;
  for (;;) {
    try {
      return await fillApplicationAttempt(page, input, signal, progress, assertTarget);
    } catch (error) {
      assertTarget();
      if (await page.locator(`${WORKDAY_APPLICATION_PAGE_SELECTORS.assessment}:visible`).count() === 1 &&
          await page.getByText("You must complete the assessment test to continue with your job application.", { exact: true }).isVisible()) {
        throw new ApplicationPause("This employer requires an assessment before Review. Complete Take Assessment in the job tab, then resume C3.");
      }
      if (error instanceof ApplicationPause &&
          error.message === "The draft did not go back to the previous page. Retry after the site finishes loading." &&
          draftRecoveries++ === 0) {
        progress("Reopening saved application");
        await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        continue;
      }
      const siteError = await page.locator(WORKDAY_RUNTIME_ERROR_DESTINATION_SELECTORS.map(s => `${s}:visible`).join(",")).count();
      const busyCatalog = error instanceof ApplicationPause && /\bprofile_answer_missing\b/.test(error.message) &&
        await page.locator('[data-automation-id="responsiveMonikerPrompt"][aria-busy="true"]:visible').evaluateAll(prompts => {
          const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
          return prompts.some(prompt => {
            const widget = prompt.getAttribute("data-associated-widget");
            if (!widget) return false;
            const controls = [...document.querySelectorAll('[data-automation-id="applyFlowPage"] input[data-uxi-multiselect-id]')]
              .filter(control => control.getAttribute("data-uxi-multiselect-id") === widget && visible(control));
            return controls.length === 1 && controls[0]!.getAttribute("aria-required") === "true" &&
              ![...prompt.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]')].some(visible);
          });
        });
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
        if (!await page.locator(WORKDAY_RUNTIME_ERROR_DESTINATION_SELECTORS.map(s => `${s}:visible`).join(",")).count()) continue;
      }
      assertTarget();
      reloads++;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      assertTarget();
      if (siteError) {
        const settleDeadline = Date.now() + 15_000;
        while (await page.locator(WORKDAY_RUNTIME_ERROR_DESTINATION_SELECTORS.map(s => `${s}:visible`).join(",")).count() && Date.now() < settleDeadline) {
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

async function fillApplicationAttempt(page: Page, input: ProductInput, signal: AbortSignal,
  progress: (stage: string) => void, assertTarget: () => void): Promise<{ reviewDigest: string; completedPages: number; needsOwnerReview?: boolean }> {
  const target = applicationTarget(input.url);
  progress("Signing in");
  await enterApplication(page, input, signal, assertTarget, progress);
  assertTarget();
  const laterApplicationPages = Object.entries(WORKDAY_APPLICATION_PAGE_SELECTORS)
    .filter(([name]) => name !== "myInformation")
    .flatMap(([, selector]) => selector.split(",")).map(selector => `${selector.trim()}:visible`).join(",");
  if (await page.locator(`${WORKDAY_APPLICATION_PAGE_SELECTORS.myInformation}:visible`).count() !== 1 &&
      await page.locator(laterApplicationPages).count() > 0) {
    progress("Rechecking saved application");
    const observer = new PlaywrightWorkdayApplicationPage(page, { timeoutMs: 15_000 });
    for (let step = 0; ; step++) {
      assertTarget();
      if (await page.locator(`${WORKDAY_APPLICATION_PAGE_SELECTORS.myInformation}:visible`).count() === 1) break;
      if (step >= 12) throw new ApplicationPause("Could not return to the start of this draft to verify its answers.");
      const before = await observer.observe(signal);
      const back = page.locator('[data-automation-id="applyFlowPage"] [data-automation-id="pageFooterBackButton"]:visible');
      if (!before.ok || await back.count() !== 1 || !await back.isEnabled()) {
        throw new ApplicationPause("Open My Information in this draft so C3 can verify every page before Review.");
      }
      assertTarget();
      await back.click({ timeout: 15_000 });
      const deadline = Date.now() + 15_000;
      let changed = false;
      while (Date.now() < deadline) {
        await pause(signal);
        assertTarget();
        if (await page.locator(`${WORKDAY_APPLICATION_PAGE_SELECTORS.myInformation}:visible`).count() === 1) { changed = true; break; }
        const after = await observer.observe(signal);
        if (after.ok && after.value.pageId !== before.value.pageId) { changed = true; break; }
      }
      if (!changed) throw new ApplicationPause("The draft did not go back to the previous page. Retry after the site finishes loading.");
    }
  }
  const sources = productSources(input.profile, input.resume);
  const learning = productQuestionLearning(input.learningRoot === undefined ? undefined : join(input.learningRoot, id()), sources);
  const journey = `journey_${id()}`;
  const session: LiveBrowserSessionV1 = {
    schemaVersion: 1, journeyId: journey as never, sessionId: `session_${id()}` as never,
    profileLeaseId: `profile_${id()}` as never,
    target: { schemaVersion: 1, atsFamily: "workday", hostId: target.host as never,
      tenantId: target.host.split(".")[0] as never, postingId: target.posting as never },
    leaseExpiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
  };
  let failureCode: string | undefined;
  let failureField: string | undefined;
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: { ownerSources: sources, questionLearning: learning.sink }, acceptances: { record() {} },
    nextOperationId: () => generatedOperationId(`operation_${id()}`), timeoutMs: 45_000,
    initialReviewExpected: [], authorizationExpiresAt: session.leaseExpiresAt,
    now: () => new Date().toISOString(),
    trace: (event, detail) => {
      if (event === "profile_reconciliation_blocked" && detail && "code" in detail && typeof detail.code === "string") {
        failureCode = detail.code;
        failureField = "fieldId" in detail && typeof detail.fieldId === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(detail.fieldId) ? detail.fieldId : undefined;
      }
      if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1" && detail &&
          (["profile_driver_failed", "profile_file_upload_reconciled", "profile_row_mutation_failed", "profile_inspection_failed", "profile_option_observation_failed", "profile_option_observation_cleanup_failed", "profile_reconciliation_blocked", "questionnaire_reconciliation_failed",
            "questionnaire_reconciliation_uncertain", "questionnaire_reconciliation_exception",
            "questionnaire_field_rebind_failed", "questionnaire_field_drive_completed",
            "questionnaire_field_verification_completed"].includes(event))) {
        const diagnostic: Record<string, string> = { event };
        for (const key of ["code", "fieldId", "uiBehavior", "errorClass", "failureStage", "underlyingError", "profileInspectionClassification", "profileInspectionPhase", "profileInspectionDeadlineOutcome"] as const) {
          const value = (detail as Record<string, unknown>)[key];
          if (typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value)) diagnostic[key] = value;
        }
        try { process.stderr.write(`${JSON.stringify({ c3ProfileDiagnostic: diagnostic })}\n`); } catch { /* Diagnostics never change filling. */ }
      }
    },
  });
  runtime.bindSession(session);
  async function operation<T>(op: OwnedApplicationOperation): Promise<T> {
    // A profile failure belongs only to that operation. A recovered profile
    // must not relabel a later upload, navigation, questionnaire or Review error.
    failureCode = undefined;
    failureField = undefined;
    assertTarget();
    const result = await runtime.run(page, { schemaVersion: 1, journeyId: session.journeyId,
      operationId: generatedOperationId(`operation_${id()}`), sessionId: session.sessionId,
      target: session.target, now: new Date().toISOString() }, op, signal);
    if (result !== null && typeof result === "object" && "ok" in result && result.ok === true) {
      failureCode = undefined;
      failureField = undefined;
    }
    return result as T;
  }
  const dependencies: ApplicationWalkDependencies = {
    observer: { observe: () => operation({ kind: "observe" }) },
    navigation: { next: input => operation({ kind: "next", input }) },
    handlers: {
      profile: { reconcile: input => { progress("Filling profile"); return operation({ kind: "reconcile_profile", input }); } },
      resume: { reconcile: input => { progress("Uploading resume"); return operation({ kind: "reconcile_resume", input }); } },
      questionnaire: { reconcile: input => { progress("Answering questions"); return operation({ kind: "reconcile_questionnaire", input }); } },
    },
    progress: { record: async () => ({ ok: true, value: undefined }) },
  };
  try {
    const result = await runApplicationPageWalk(dependencies, { journeyId: session.journeyId, stopAfter: "pre_review" }, signal);
    if (!result.ok) throw new ApplicationPause(`Application paused: ${failureCode ?? result.error.failure.code}${failureField ? ` (${failureField})` : ""}. Review the tab before retrying.`);
    await operation({ kind: "capture_review" });
    return { reviewDigest: await reviewDigest(page), completedPages: result.value.pageChecks.length, needsOwnerReview: learning.needsOwnerReview };
  } catch (error) {
    if (failureCode && !(error instanceof ApplicationPause)) throw new ApplicationPause(`Application paused: ${failureCode}${failureField ? ` (${failureField})` : ""}. Review the tab before retrying.`);
    throw error;
  } finally {
    runtime.dispose();
    disposeResumeArtifact(sources.resumeIntent.artifact);
    try { learning.finish(); }
    catch { throw new ApplicationPause("C3 could not preserve discovered questions. Your draft is preserved. Check disk space and access, then retry."); }
  }
}

async function enterApplication(page: Page, input: ProductInput, signal: AbortSignal,
  assertTarget: () => void, progress: (stage: string) => void): Promise<void> {
  const account = new PlaywrightAccountPageAdapter();
  const posting = new PlaywrightPostingNavigationAdapter();
  const observer = new PlaywrightWorkdayApplicationPage(page, { timeoutMs: 30_000 });
  const applicationRoots = Object.values(WORKDAY_APPLICATION_PAGE_SELECTORS).flatMap(selector => selector.split(",")).map(selector => `${selector.trim()}:visible`).join(",");
  const deadline = Date.now() + 5 * 60_000;
  const started = Date.now();
  let submitted = false, verified = false, attemptedCreate = false, resetAttempted = false;
  let requestedInitialSignIn = false;
  let lastSubmittedAction: "submit_create_account" | "submit_sign_in" | undefined;
  while (Date.now() < deadline) {
    assertTarget();
    if (await page.getByText("You've already applied for this job.", { exact: true }).isVisible()) {
      throw new ApplicationPause("The employer says this job was already applied to. Choose a different posting.");
    }
    if (await page.locator(WORKDAY_RUNTIME_ERROR_DESTINATION_SELECTORS.map(s => `${s}:visible`).join(",")).count()) {
      throw new ApplicationPause("Workday is showing a site error. The draft is preserved.");
    }
    // Login/posting screens need no full field scan. Still verify the complete
    // application state once an existing supported root becomes visible.
    if (await page.locator(applicationRoots).count() > 0 && (await observer.observe(signal)).ok) return;
    if ((await matchingUnavailable(page)).some(reason => ["not_found", "closed", "removed", "unavailable"].includes(reason))) {
      throw new ApplicationPause("This posting is no longer available. Choose another job at this employer.");
    }
    if (await page.locator('[data-automation-id="captchaChallenge"], [data-automation-id="mfaChallenge"], iframe[title="hCaptcha"]').count()) {
      throw new ApplicationPause("Complete the security check in this tab, then retry.");
    }
    if (await page.locator(['[data-automation-id="emailVerificationPage"]', '[data-automation-id="verifyEmailPage"]', ...WORKDAY_INLINE_VERIFICATION_SELECTORS].map(s => `${s}:visible`).join(",")).count()) {
      if (!input.verifyEmail) throw new ApplicationPause("Connect email verification, or verify the account and retry.");
      if (!verified) {
        const alreadySent = await page.locator(WORKDAY_VERIFICATION_EMAIL_SENT_SELECTORS.map(s => `${s}:visible`).join(",")).count() > 0;
        if (!alreadySent && (await account.inspect(page, "request_verification_email")).actionable) await account.activate(page, "request_verification_email");
        progress("Verifying email"); await input.verifyEmail(page, started, signal); verified = true; submitted = false;
        await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 }); continue;
      }
    }
    const rejectedExistingSignIn = attemptedCreate && submitted && lastSubmittedAction === "submit_sign_in" &&
      await page.locator(`${WORKDAY_SIGN_IN_REJECTION_SELECTORS.credentialsOrLocked}:visible`).count() === 1 &&
      (await account.inspect(page, "show_password_reset")).actionable;
    if (rejectedExistingSignIn ||
        await page.locator(`${WORKDAY_SIGN_IN_REJECTION_SELECTORS.passwordResetRequired}:visible`).count() === 1 ||
        (await account.inspect(page, "submit_password_reset_request")).actionable) {
      if (resetAttempted) throw new ApplicationPause("The employer still requires a password reset after recovery.");
      if (!input.verifyEmail || !input.credentials) throw new ApplicationPause("Connect account credentials and email verification to reset this password.");
      resetAttempted = true;
      progress("Resetting employer password");
      const resetStarted = Date.now();
      if ((await account.inspect(page, "show_password_reset")).actionable) {
        assertTarget(); await account.activate(page, "show_password_reset");
      }
      const ready = async (action: "submit_password_reset_request" | "submit_password_reset") => {
        const end = Date.now() + 30_000;
        while (!(await account.inspect(page, action)).actionable) {
          assertTarget();
          if (Date.now() >= end) throw new ApplicationPause("The password reset form did not become ready.");
          await pause(signal);
        }
      };
      await ready("submit_password_reset_request");
      const email = Buffer.from(input.credentials.email);
      try { assertTarget(); await account.fill(page, "email", email); }
      finally { email.fill(0); }
      assertTarget(); await account.activate(page, "submit_password_reset_request");
      await input.verifyEmail(page, resetStarted, signal);
      assertTarget(); await ready("submit_password_reset");
      for (const field of ["password", "password_confirmation"] as const) {
        const value = Buffer.from(input.credentials.password);
        try {
          assertTarget(); await account.fill(page, field, value);
          if (!await account.matches(page, field, value)) throw new ApplicationPause("Password reset field did not save.");
        } finally { value.fill(0); }
      }
      assertTarget(); await account.activate(page, "submit_password_reset");
      const resetEnd = Date.now() + 30_000;
      while ((await account.inspect(page, "submit_password_reset")).actionable) {
        assertTarget();
        if (await page.locator('[data-automation-id="errorMessage"]:visible').count()) {
          throw new ApplicationPause("The employer rejected the configured replacement password. Update the account password before retrying.");
        }
        if (Date.now() >= resetEnd) throw new ApplicationPause("Password reset confirmation did not arrive.");
        await pause(signal);
      }
      submitted = false; lastSubmittedAction = undefined;
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      continue;
    }
    let advanced = false;
    for (const action of ["apply_manually", "sign_in_with_email", "start_application"] as const) {
      if ((await posting.inspect(page, action, { waitForCandidate: false })).actionable) {
        progress("Opening application");
        assertTarget();
        try { await posting.activate(page, action); }
        catch (error) {
          if (!(error instanceof TypeError) || error.message !== "account or application destination did not settle") throw error;
          // Activation can finish after the adapter's transition deadline.
          // Reconcile the actual destination before repeating any click.
          try { await page.locator(applicationRoots).first().waitFor({ state: "visible", timeout: 10_000 }); }
          catch { throw error; }
          assertTarget();
          if (!(await observer.observe(signal)).ok) throw error;
          progress("Continuing opened application");
        }
        advanced = true; break;
      }
    }
    if (advanced) continue;
    const signIn = await account.inspect(page, "submit_sign_in");
    const create = await account.inspect(page, "submit_create_account");
    // Inline application flows may default to Create Account even for returning
    // applicants. Prefer their ordinary Sign In link once before attempting creation.
    if (!submitted && !attemptedCreate && lastSubmittedAction === undefined && create.actionable && !signIn.actionable &&
        (requestedInitialSignIn || (await account.inspect(page, "show_sign_in")).actionable)) {
      if (!requestedInitialSignIn) {
        assertTarget(); await account.activate(page, "show_sign_in");
        requestedInitialSignIn = true;
        progress("Opening existing account sign-in");
      }
      await pause(signal); continue;
    }
    const rejected = submitted && await page.locator([WORKDAY_ACCOUNT_FACT_SELECTORS.absent, WORKDAY_ACCOUNT_FACT_SELECTORS.exists,
      ...Object.values(WORKDAY_SIGN_IN_REJECTION_SELECTORS), '[data-automation-id="errorMessage"]'].map(s => `${s}:visible`).join(",")).count() > 0;
    // Some employers create the account, then require a separate sign-in without
    // email verification. Only a change of form admits that next credential action.
    if (submitted && lastSubmittedAction === "submit_create_account" && signIn.actionable && !create.actionable && !rejected) {
      submitted = false;
      progress("Signing in after account creation");
    }
    if (!submitted && (signIn.actionable || create.actionable)) {
      progress(create.actionable ? "Creating account" : "Signing in");
      if (!input.credentials?.email || !input.credentials.password) throw new ApplicationPause("Add account credentials, then retry this job.");
      for (const field of ["email", "password", ...(create.actionable ? ["password_confirmation" as const] : [])] as const) {
        if (!(await account.inspect(page, field)).actionable) continue;
        assertTarget();
        const bytes = Buffer.from(field === "email" ? input.credentials.email : input.credentials.password);
        try { await account.fill(page, field, bytes); if (!await account.matches(page, field, bytes)) throw new ApplicationPause("Account field did not save."); }
        finally { bytes.fill(0); }
      }
      if (create.actionable && (await account.inspect(page, "accept_terms")).actionable) await account.activate(page, "accept_terms");
      const action = create.actionable ? "submit_create_account" : "submit_sign_in";
      assertTarget();
      lastSubmittedAction = action;
      attemptedCreate ||= create.actionable;
      submitted = true;
      try { await account.activate(page, action); }
      catch (error) {
        // A repeated rejection can remain visible without a new DOM transition.
        // Reconcile that exact sign-in outcome before entering bounded recovery.
        if (action !== "submit_sign_in" || !(error instanceof Error) ||
            error.message !== "submit effect did not settle" ||
            await page.locator(`${WORKDAY_SIGN_IN_REJECTION_SELECTORS.credentialsOrLocked}:visible`).count() !== 1) throw error;
      }
      progress("Waiting for account page");
    } else if (rejected) {
      if (lastSubmittedAction === "submit_create_account" &&
          await page.locator(`${WORKDAY_ACCOUNT_FACT_SELECTORS.exists}:visible`).count() === 1 &&
          (await account.inspect(page, "show_sign_in")).actionable) {
        assertTarget(); await account.activate(page, "show_sign_in");
        submitted = false;
        continue;
      }
      if (!attemptedCreate && (await account.inspect(page, "show_create_account")).actionable) {
        await account.activate(page, "show_create_account"); attemptedCreate = true; submitted = false; continue;
      }
      throw new ApplicationPause("The site rejected account access. Check account details in the tab before retrying.");
    } else if (!submitted && (await account.inspect(page, "show_create_account")).actionable && !signIn.actionable) {
      await account.activate(page, "show_create_account");
    }
    await pause(signal);
  }
  throw new ApplicationPause("The application page did not become ready. The draft is preserved; retry when the site finishes loading.");
}

/** Explicit Review refresh only: navigate saved pages without answering anything. */
export async function restoreSavedReview(page: Page, reviewedUrl: string): Promise<void> {
  if (applicationTarget(reviewedUrl).ats !== "workday") { if(applicationTarget(page.url()).key !== applicationTarget(reviewedUrl).key) throw new ApplicationPause("The tab moved to a different job."); await hostedReviewDigest(page); return; }
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

export async function reviewDigest(page: Page): Promise<string> {
  if (applicationTarget(page.url()).ats !== "workday") return hostedReviewDigest(page);
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
