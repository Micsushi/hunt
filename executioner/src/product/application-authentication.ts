import { observeWorkdayPage, workdayObservationMessage } from '../ats/workday/page-observation.ts';
import type { Page } from "playwright";
import { PlaywrightWorkdayApplicationPage } from "../ats/workday/application/playwright-page.ts";
import { WORKDAY_APPLICATION_PAGE_SELECTORS } from "../ats/workday/application/page-walk-contract.ts";
import { PlaywrightAccountPageAdapter } from "../browser/playwright-live/private/playwright-account-page.ts";
import { PlaywrightPostingNavigationAdapter } from "../browser/playwright-live/private/playwright-posting-navigation.ts";
import { WORKDAY_SIGN_IN_REJECTION_SELECTORS } from "../browser/playwright-live/private/workday-structural-catalog.ts";
import type { AccountEvent } from "./account-journal.ts";
import { ApplicationPause, type ProductInput } from './application-contract.ts';
import { pause } from './application-wait.ts';

export class AccountAccessPause extends ApplicationPause {}

export async function enterApplication(page: Page, input: ProductInput, signal: AbortSignal,
  assertTarget: () => void, progress: (stage: string) => void): Promise<void> {
  let journalFailure = false;
  const record = (event: AccountEvent, trace?: string) => {
    try {
      if (!input.recordAccountAction) throw new Error();
      input.recordAccountAction(event, trace);
    } catch {
      journalFailure = true;
      throw new AccountAccessPause("Account history could not be saved. No further account actions will run; check storage before retrying.");
    }
  };
  const accountTrace: string[] = [];
  const account = new PlaywrightAccountPageAdapter({trace: event => { accountTrace.push(event); }});
  const flushTrace = () => {
    for (const event of accountTrace.splice(0)) record('sign_in_diagnostic', event);
  };
  const posting = new PlaywrightPostingNavigationAdapter();
  const observer = new PlaywrightWorkdayApplicationPage(page, { timeoutMs: 30_000 });
  const applicationRoots = Object.values(WORKDAY_APPLICATION_PAGE_SELECTORS).flatMap(selector => selector.split(",")).map(selector => `${selector.trim()}:visible`).join(",");
  const deadline = Date.now() + 5 * 60_000;
  let submitted = false;
  let requestedInitialSignIn = false;
  while (Date.now() < deadline) {
    assertTarget();
    if (journalFailure) throw new AccountAccessPause("Account history could not be saved. Inspect the employer tab before retrying.");
    const observation = await observeWorkdayPage(page);
    const message = workdayObservationMessage(observation);
    if (message) {
      if (observation.kind === 'email_verification') record('verification_blocked');
      if (observation.kind === 'password_reset') record('reset_blocked');
      if (observation.kind === 'credential_rejected') record('sign_in_rejected');
      throw new ApplicationPause(message);
    }
    if (observation.kind === 'loading' || observation.kind === 'unknown') { await pause(signal); continue; }
    if (['application','review'].includes(observation.kind) && (await observer.observe(signal)).ok) {
      if (submitted) record('application_opened');
      return;
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
    // Creating an account is never a fallback for a rejected sign-in.
    if (!submitted && create.actionable && !signIn.actionable) {
      if (!requestedInitialSignIn && (await account.inspect(page, "show_sign_in")).actionable) {
        assertTarget(); await account.activate(page, "show_sign_in");
        requestedInitialSignIn = true;
        progress("Opening existing account sign-in");
        await pause(signal); continue;
      }
      record("creation_blocked");
      throw new AccountAccessPause("This employer is showing account creation. Sign in with an existing account yourself, then retry. C3 has not created an account or accepted terms.");
    }
    if (!submitted && signIn.actionable) {
      if (input.requireScriptSignIn) throw new AccountAccessPause('The employer returned to sign-in. Retry to use the extension sign-in connection; C3 has not entered credentials through the debugger.');
      if (!input.credentials?.email || !input.credentials.password) throw new ApplicationPause("Add account credentials, then retry this job.");
      record("sign_in_fields_started"); // Storage must work before filling credentials.
      progress("Signing in");
      try {
        for (const field of ["email", "password"] as const) {
          const fieldDeadline = Date.now() + 5_000;
          const notReady = () => new AccountAccessPause(`The ${field} field did not become ready. Inspect this tab before retrying.`);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              (async () => {
                while (Date.now() < fieldDeadline) {
                  assertTarget(); signal.throwIfAborted();
                  const fact = await account.inspect(page, field);
                  if (!(await account.inspect(page, "submit_sign_in")).actionable ||
                      (await account.inspect(page, "submit_create_account")).actionable) {
                    throw new AccountAccessPause("The sign-in form changed. Inspect this tab before retrying.");
                  }
                  if (Date.now() >= fieldDeadline) throw notReady();
                  if (fact.actionable) return;
                  await pause(signal);
                }
                throw notReady();
              })(),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(notReady()), 5_000); }),
            ]);
          } finally { clearTimeout(timer); }
          if (Date.now() >= fieldDeadline) throw notReady();
          flushTrace();
          assertTarget();
          const bytes = Buffer.from(input.credentials[field]);
          try { await account.fill(page, field, bytes, { signInOnly: true }); if (!await account.matches(page, field, bytes)) throw new AccountAccessPause("Account field did not save."); }
          finally { bytes.fill(0); }
        }
      } catch (error) {
        flushTrace();
        record("sign_in_fields_failed");
        if (error instanceof Error && error.message === "The credential field could not be filled. Check sign-in in the application tab.") {
          throw new AccountAccessPause("Sign-in was interrupted. Sign in on the employer page, then retry. C3 has not submitted the application.");
        }
        throw error;
      }
      assertTarget();
      if (!(await account.inspect(page, "submit_sign_in")).actionable ||
          (await account.inspect(page, "submit_create_account")).actionable) {
        throw new AccountAccessPause("The sign-in form changed. Inspect this tab before retrying.");
      }
      record("sign_in_attempted"); // Durable immediately before the external effect.
      assertTarget(); signal.throwIfAborted();
      submitted = true;
      try {
        try { await account.activate(page, "submit_sign_in"); }
        finally { flushTrace(); }
      }
      catch {
        assertTarget();
        if (journalFailure) throw new AccountAccessPause("Account history could not be saved. Inspect the employer tab before retrying.");
        // A late transition or a persistent exact rejection may outlive the adapter wait.
        if (await page.locator(applicationRoots).count() > 0 && (await observer.observe(signal)).ok) {
          record("application_opened"); return;
        }
        const destination=await observeWorkdayPage(page);
        const message=workdayObservationMessage(destination);
        if (message) {
          record(destination.kind === 'credential_rejected' ? 'sign_in_rejected' : 'sign_in_uncertain');
          throw new AccountAccessPause(message);
        }
        if (await page.locator(Object.values(WORKDAY_SIGN_IN_REJECTION_SELECTORS).map(s => `${s}:visible`).join(",")).count() > 0) {
          record('sign_in_rejected');
          throw new AccountAccessPause('The employer rejected sign-in. Check the account details before retrying.');
        }
        record("sign_in_uncertain");
        throw new AccountAccessPause("Sign-in did not settle. Inspect the tab before retrying; C3 has preserved account diagnostics and will not repeat the click automatically.");
      }
      if (journalFailure) throw new AccountAccessPause("Account history could not be saved. Inspect the employer tab before retrying.");
      record("sign_in_transition_observed");
      progress("Waiting for account page");
    } else if (!submitted && (await account.inspect(page, "show_sign_in")).actionable && !requestedInitialSignIn) {
      assertTarget(); await account.activate(page, "show_sign_in"); requestedInitialSignIn = true;
    } else if (!submitted && (await account.inspect(page, "show_create_account")).actionable) {
      record("creation_blocked");
      throw new AccountAccessPause("An existing employer account is required. C3 will not create an account.");
    }
    await pause(signal);
  }
  if (submitted) record("sign_in_uncertain");
  throw new ApplicationPause("The application page did not become ready. The draft is preserved; retry when the site finishes loading.");
}
