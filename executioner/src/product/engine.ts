import { mkdirSync, writeFileSync } from 'node:fs';
import { observeWorkdayPage, workdayObservationMessage } from '../ats/workday/page-observation.ts';
import { fillHostedApplication, hostedReviewDigest, hostedReviewSnapshot } from "./hosted-application.ts";
import { createHash, randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { generatedOperationId, disposeResumeArtifact } from "../contracts/index.ts";
import type { LiveBrowserSessionV1 } from "../contracts/live/index.ts";
import { OwnedWorkdayApplicationRuntime, type ReviewExpectedField } from "../browser/playwright-live/private/workday-application-runtime.ts";
import type { OwnedApplicationOperation } from "../browser/playwright-live/private/application-page-types.ts";
import { PlaywrightWorkdayApplicationPage } from "../ats/workday/application/playwright-page.ts";
import { WORKDAY_APPLICATION_PAGE_SELECTORS, applicationNextPages, type ApplicationPageTruth } from "../ats/workday/application/page-walk-contract.ts";
import { runApplicationPageWalk, type ApplicationWalkDependencies, type ApplicationPortResult } from "../ats/workday/application/page-walk.ts";
import { PlaywrightAccountPageAdapter } from "../browser/playwright-live/private/playwright-account-page.ts";
import { PlaywrightPostingNavigationAdapter } from "../browser/playwright-live/private/playwright-posting-navigation.ts";
import { productSources, productQuestionLearning } from "./sources.ts";
import { join } from "node:path";
import { applicationTarget, productApplicationTarget } from "./target.ts";
import { fillGenericApplication } from "./generic-application.ts";
import { WORKDAY_SIGN_IN_REJECTION_SELECTORS } from "../browser/playwright-live/private/workday-structural-catalog.ts";
import { inspectWorkdayReview, workdayReviewSignatures } from "../interaction/review/index.ts";

import type { AccountEvent } from "./account-journal.ts";

export interface ResumeUploadReceipt { token: string; selectedSha256: string; filename: string; applicationKey: string }
export interface ProductInput {
  url: string;
  profile: unknown;
  resume: Buffer;
  credentials?: { email: string; password: string };
  requireScriptSignIn?: boolean;
  verifyEmail?: (page: Page, since: number, signal: AbortSignal) => Promise<void>;
  /** Internal queue-owned path; never accepted from an HTTP application request. */
  learningRoot?: string;
  /** Queue-owned durable recorder. Absence forbids account mutation. */
  recordAccountAction?: (event: AccountEvent, trace?: string) => void;
  resumeExpected?: boolean;
  onResumeObserved?: () => void;
  resumeUpload?: ResumeUploadReceipt;
  onResumeUpload?: (receipt: ResumeUploadReceipt | undefined) => void;
}
export class ApplicationPause extends Error {}
class AccountAccessPause extends ApplicationPause {}
const id = () => randomBytes(16).toString("hex");
const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
});

export async function fillApplication(page: Page, input: ProductInput, signal: AbortSignal,
  progress: (stage: string) => void): Promise<{ reviewDigest: string; completedPages: number; needsOwnerReview?: boolean; resumeExpected?: boolean }> {
  if ((input.profile as {profilePlan?:{mode?:unknown}} | null)?.profilePlan?.mode === 'synthetic_test_non_submittable') {
    throw new ApplicationPause('This is a synthetic test profile. Choose your saved personal profile before running a real application.');
  }
  const target = productApplicationTarget(input.url);
  if (target.ats === "generic") {
    progress("Filling this unfamiliar application page");
    try {
      const report = await fillGenericApplication(page, input.url, input.profile, input.resume, signal, input.learningRoot);
      const reasons:Record<string,string>={saved_value_conflict:'saved profile differs',value_changed_after_fill:'site changed the filled value',existing_attachment_preserved:'existing attachment needs review',resume_attachment_not_verified:'attachment could not be verified',choice_requires_mapping:'no matching saved option',no_stored_mapping:'no saved answer',value_not_accepted:'site rejected the value',ambiguous_duplicate:'more than one matching field'};
      Object.assign(reasons,{
        uploaded_attachment_requires_review:'check the uploaded attachment on the page',
        resume_upload_already_attempted_review_attachment:'upload already attempted; check the attachment before retrying',
        resume_parsing_pending_profile_not_filled:'waiting for upload or parsing confirmation; profile fields were left unchanged',
        resume_parser_value_conflict:'resume parsing produced a value that differs from your saved profile',
        resume_parser_unmapped_value_requires_review:'review the value entered by resume parsing; no saved answer confirms it',
        resume_control_not_identified:'resume upload control could not be verified',
        application_form_not_identified:'application form could not be identified',
        field_replaced_without_stable_identity:'field changed during filling',
        field_no_longer_editable:'field is not editable',
        different_resume_requires_manual_review:'a different resume is present; review it manually',
        attachment_not_verified_native_file_retained:'file remains selected, but the upload could not be verified',
        phone_country_requires_review:'check the phone country and number',
        phone_country_change_requires_review:'phone country changed; check the number before retrying',
        province_change_requires_review:'province selection changed; check it before retrying',
        province_control_changed:'province control changed before selection',
        province_menu_binding_changed:'province menu no longer matches its control',
        province_menu_open_changed:'province control changed while its menu opened',
        province_option_not_unique:'saved province is not uniquely available in the menu',
        province_selection_not_verified:'province selection or reset could not be confirmed',
        selected_resume_already_present:'selected resume is already present',
      });
      const privateValues = (input.profile as {profile?:{facts?:{value:unknown}[]}})?.profile?.facts?.flatMap(fact=>typeof fact.value==='string' && fact.value.length>3 ? [fact.value] : []) ?? [];
      const label = (value:string) => {
        let text=value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/https?:\/\/\S+|\b[^\s@]+@[^\s@]+\b/g,'[hidden]');
        for(const value of privateValues) text=text.split(value).join('[hidden]');
        return text.trim().slice(0,70) || 'Field';
      };
      const unresolved=report.skipped.filter(item=>!['saved_value_already_present','selected_resume_already_present','optional_field'].includes(item.reason));
      const warnings=unresolved.slice(0,4).map(item=>`${label(item.label)}: ${reasons[item.reason] ?? 'needs review'}`);
      const resumeVerified=report.resume === 'verified';
      throw new ApplicationPause(`Partial page fill: ${report.filled.length} fields filled. ${resumeVerified ? 'Selected resume verified.' : report.resume==='optional' ? 'Optional resume left unchanged.' : 'Selected resume needs review.'} ${warnings.join('; ')}${unresolved.length>4 ? `; ${unresolved.length-4} more fields need review` : ''} Review the draft. C3 has not advanced or submitted.`);
    } catch (error) {
      if (error instanceof ApplicationPause) throw error;
      throw new ApplicationPause("This unfamiliar application needs review. Open its exact application form before retrying; C3 has not advanced or submitted.");
    }
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
      if (accountAttemptStarted && !signal.aborted) throw new AccountAccessPause(error instanceof ApplicationPause
        ? error.message
        : 'The application stopped after sign-in. Inspect the tab before retrying; C3 will not repeat account access automatically.');
      if (error instanceof AccountAccessPause) throw error;
      if (page.isClosed()) throw error;
      assertTarget();
      if (await preserveFailure(error, async () =>
        await page.locator(`${WORKDAY_APPLICATION_PAGE_SELECTORS.assessment}:visible`).count() === 1 &&
        await page.getByText("You must complete the assessment test to continue with your job application.", { exact: true }).isVisible())) {
        throw new ApplicationPause("This employer requires an assessment before Review. Complete Take Assessment in the job tab, then resume C3.");
      }
      const recoveryObservation = await preserveFailure(error, () => observeWorkdayPage(page));
      if (recoveryObservation.kind === 'employer_coded_error') throw new ApplicationPause(workdayObservationMessage(recoveryObservation)!);
      const siteError = recoveryObservation.kind === 'employer_error';
      const busyCatalog = error instanceof ApplicationPause && /\bprofile_answer_missing\b/.test(error.message) &&
        await preserveFailure(error, () => page.locator('[data-automation-id="responsiveMonikerPrompt"][aria-busy="true"]:visible').evaluateAll(prompts => {
          const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
          return prompts.some(prompt => {
            const widget = prompt.getAttribute("data-associated-widget");
            if (!widget) return false;
            const controls = [...document.querySelectorAll('[data-automation-id="applyFlowPage"] input[data-uxi-multiselect-id]')]
              .filter(control => control.getAttribute("data-uxi-multiselect-id") === widget && visible(control));
            return controls.length === 1 && controls[0]!.getAttribute("aria-required") === "true" &&
              ![...prompt.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]')].some(visible);
          });
        }));
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

async function fillApplicationAttempt(page: Page, input: ProductInput, signal: AbortSignal,
  progress: (stage: string) => void, assertTarget: () => void): Promise<{ reviewDigest: string; completedPages: number; needsOwnerReview?: boolean }> {
  const target = applicationTarget(input.url);
  progress("Signing in");
  await enterApplication(page, input, signal, assertTarget, progress);
  assertTarget();
  const laterApplicationPages = Object.entries(WORKDAY_APPLICATION_PAGE_SELECTORS)
    .filter(([name]) => name !== "myInformation")
    .flatMap(([, selector]) => selector.split(",")).map(selector => `${selector.trim()}:visible`).join(",");
  const continuingSavedDraft=await page.locator(`${WORKDAY_APPLICATION_PAGE_SELECTORS.myInformation}:visible`).count() !== 1 &&
    await page.locator(laterApplicationPages).count() > 0;
  if(continuingSavedDraft)progress("Continuing saved application");
  const sources = productSources(input.profile, input.resume);
  const learning = productQuestionLearning(input.learningRoot === undefined ? undefined : join(input.learningRoot, id()), sources, input.url, input.profile);
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
  const observations: object[] = [];
  let lastApplicationTruth: ReturnType<typeof applicationTruthDiagnostic> | undefined;
  let activeOperation: OwnedApplicationOperation['kind'] | undefined;
  let walkFailureRecorded = false;
  const controlDiagnostics: Record<string, string | boolean | number>[] = [];
  const navigationStages = new Set([
    'source_guard_failed','action_unavailable','action_admitted','hit_test_started','admitted_control_activated','activation_failed',
    'destination_readback_started','unchanged_source_retry_started','unchanged_source_retry_activated',
    'unchanged_source_retry_activation_failed','destination_readback_succeeded','destination_readback_failed',
    'validation_downgrade','destination_not_allowed','semantic_guard_failed','navigation_advanced',
    'navigation_exception_after_admission','navigation_exception_before_admission','snapshot_failed',
    'destination_candidate_unstable','destination_wait_exhausted','action_event_evidence','action_event_evidence_unavailable',
  ]);
  const reviewIssues: {code:string;fieldIds:string[]}[]=[];
  const recordDiagnostic=(name:string,value:object)=>{
    if(!input.learningRoot)return;
    mkdirSync(input.learningRoot,{recursive:true});
    writeFileSync(join(input.learningRoot,name),JSON.stringify(value));
  };
  const recordWalkFailure=(failure:object)=>{
    if(walkFailureRecorded)return;
    try {
      recordDiagnostic('application-walk-failure.json',{schemaVersion:1,...failure,
        failureFieldId:failureField??null,activeOperation:activeOperation??null,
        lastObservation:lastApplicationTruth??null,controlDiagnostics});
      walkFailureRecorded=true;
    } catch { /* Optional diagnostics must preserve the original failure. */ }
  };
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: { ownerSources: sources, questionLearning: learning.sink }, acceptances: { record() {} },
    nextOperationId: () => generatedOperationId(`operation_${id()}`), timeoutMs: 45_000,
    initialReviewExpected: [], authorizationExpiresAt: session.leaseExpiresAt,
    now: () => new Date().toISOString(),
    trace: (event, detail) => {
      if(event==='application_navigation_stage' && detail) {
        const data=detail as Record<string,unknown>;
        if(typeof data.code==='string' && navigationStages.has(data.code)) {
          const diagnostic:Record<string,string|boolean|number>={event,code:data.code};
          if(typeof data.errorClass==='string' && ['timeout','detached','closed','other'].includes(data.errorClass))diagnostic.errorClass=data.errorClass;
          for(const key of ['activationTimeout','pointerIntercepted','elementDetached','snapshotAvailable','sourceUnchanged','validationChanged','busySeen','clickObserved','trustedClickObserved','targetClickObserved','clickDefaultPrevented','pointerDownObserved','pointerUpObserved','invalidEventObserved','windowErrorObserved','unhandledRejectionObserved'] as const) {
            if(typeof data[key]==='boolean')diagnostic[key]=data[key];
          }
          for(const key of ['nativeInvalidBeforeCount','nativeInvalidCount','nativeInvalidFileCount','nativeInvalidOptionalCount','nativeCustomInvalidCount'] as const) {
            const value=data[key];
            if(typeof value==='number' && Number.isInteger(value) && value>=0 && value<=512)diagnostic[key]=value;
          }
          controlDiagnostics.push(diagnostic);
          if(controlDiagnostics.length>32)controlDiagnostics.shift();
        }
      }
      if(detail && ['profile_control_observed','profile_driver_failed','profile_inspection_failed','profile_reconciliation_blocked'].includes(event)) {
        const diagnostic:Record<string,string|boolean>={event};
        for(const key of ['code','fieldId','uiBehavior','errorClass','failureStage','profileInspectionClassification','profileInspectionPhase','profileInspectionDeadlineOutcome'] as const) {
          const value=(detail as Record<string,unknown>)[key];
          if(typeof value==='string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value))diagnostic[key]=value;
        }
        for(const key of ['backingValueCommitted','validationCleared'] as const) {
          const value=(detail as Record<string,unknown>)[key];
          if(typeof value==='boolean')diagnostic[key]=value;
        }
        controlDiagnostics.push(diagnostic);
        if(controlDiagnostics.length>32)controlDiagnostics.shift();
      }
      if(['review_summary_field_missing','review_row_attribution_unavailable','review_repeatable_row_mismatch'].includes(event) && detail) {
        const data=detail as {fieldId?:unknown;fieldIds?:unknown};
        const ids=Array.isArray(data.fieldIds)?data.fieldIds:[data.fieldId];
        reviewIssues.push({code:event,fieldIds:ids.filter((id):id is string=>typeof id==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(id))});
      }
      if (event === 'workday_page_observed' && detail && input.learningRoot && JSON.stringify(observations.at(-1)) !== JSON.stringify(detail)) {
        observations.push(detail);
        if (observations.length>128) observations.shift();
        mkdirSync(input.learningRoot,{recursive:true});
        writeFileSync(join(input.learningRoot,'page-observations.json'),JSON.stringify(observations));
      }
      if (event === "profile_reconciliation_blocked" && detail && "code" in detail && typeof detail.code === "string") {
        failureCode = detail.code;
        failureField = "fieldId" in detail && typeof detail.fieldId === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(detail.fieldId) ? detail.fieldId : undefined;
      }
      if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1" && detail &&
          (["profile_control_observed", "profile_driver_failed", "profile_file_upload_reconciled", "profile_row_mutation_failed", "profile_inspection_failed", "profile_option_observation_failed", "profile_option_observation_cleanup_failed", "profile_reconciliation_blocked", "questionnaire_reconciliation_failed",
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
  const operationStages: Partial<Record<OwnedApplicationOperation['kind'], string>> = {
    observe: 'Checking application page',
    next: 'Moving to the next page',
    reconcile_profile: 'Filling profile',
    reconcile_resume: 'Uploading resume',
    reconcile_questionnaire: 'Answering questions',
    review_expectations: 'Checking application review',
    capture_review: 'Checking application review',
  };
  async function operation<T>(op: OwnedApplicationOperation): Promise<T> {
    // A profile failure belongs only to that operation. A recovered profile
    // must not relabel a later upload, navigation, questionnaire or Review error.
    failureCode = undefined;
    failureField = undefined;
    activeOperation=op.kind;
    controlDiagnostics.length=0;
    assertTarget();
    const stage=operationStages[op.kind];
    if(stage)progress(stage);
    const result = await runtime.run(page, { schemaVersion: 1, journeyId: session.journeyId,
      operationId: generatedOperationId(`operation_${id()}`), sessionId: session.sessionId,
      target: session.target, now: new Date().toISOString() }, op, signal);
    if(op.kind==='observe') {
      const observed=result as ApplicationPortResult<ApplicationPageTruth>;
      if(observed.ok)lastApplicationTruth=applicationTruthDiagnostic(observed.value);
    }
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
      profile: { reconcile: input => operation({ kind: "reconcile_profile", input }) },
      resume: { reconcile: input => operation({ kind: "reconcile_resume", input }) },
      questionnaire: { reconcile: input => operation({ kind: "reconcile_questionnaire", input }) },
    },
    progress: { record: async () => ({ ok: true, value: undefined }) },
  };
  try {
    const result = await runApplicationPageWalk(dependencies, { journeyId: session.journeyId, stopAfter: "pre_review" }, signal);
    if(!result.ok)recordWalkFailure(result.error);
    if (!result.ok && (failureCode ?? result.error.failure.code) === 'profile_row_unverified') throw new ApplicationPause('Profile history could not be verified against your saved details. Review the existing entries in the tab; C3 has preserved rows it does not own.');
    if (!result.ok && (failureCode ?? result.error.failure.code)==="protected_answer_denied") throw new ApplicationPause("This application requires your decision. Complete the question on the employer page, then retry.");
    if (!result.ok) {
      const observation=await observeWorkdayPage(page);
      if (!['application','review'].includes(observation.kind)) throw new ApplicationPause(workdayObservationMessage(observation) ?? `The current employer page is ${observation.kind === 'loading' ? 'still loading' : 'unrecognized or ambiguous'}. Inspect the tab before retrying.`);
    }
    if (!result.ok) throw new ApplicationPause(`Application paused: ${failureCode ?? result.error.failure.code}${failureField ? ` (${failureField})` : ""}. Review the tab before retrying.`);
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
    return { reviewDigest: digest, completedPages: result.value.pageChecks.length, needsOwnerReview: !!reviewReason || provisional.length>0 || continuingSavedDraft || learning.needsOwnerReview };
  } catch (error) {
    const typedPause=error instanceof ApplicationPause
      ? /^Application paused: ([a-zA-Z0-9_.:-]{1,120})(?: \(([a-zA-Z0-9_.:-]{1,120})\))?\./.exec(error.message) : null;
    failureField??=typedPause?.[2];
    recordWalkFailure({source:'thrown',failure:{code:failureCode??typedPause?.[1]??'operation_exception'},
      errorClass:error instanceof ApplicationPause?'application_pause':error instanceof TypeError?'type_error':error instanceof Error?'error':'unknown'});
    if (failureCode && !(error instanceof ApplicationPause)) throw new ApplicationPause(`Application paused: ${failureCode}${failureField ? ` (${failureField})` : ""}. Review the tab before retrying.`);
    throw error;
  } finally {
    runtime.dispose();
    disposeResumeArtifact(sources.resumeIntent.artifact);
    try { learning.finish(); }
    catch { throw new ApplicationPause("C3 could not preserve discovered questions. Your draft is preserved. Check disk space and access, then retry."); }
  }
}

function applicationTruthDiagnostic(truth:ApplicationPageTruth) {
  return {page:truth.page,lanes:truth.lanes??[],c3OwnedDuplicateRows:truth.c3OwnedDuplicateRows,submitActivated:truth.submitActivated,
    requiredFields:truth.requiredFields.map(field=>({fieldId:field.fieldId,page:field.page,verification:field.verification,
      ...(field.uiState?{navigationEligible:field.uiState.navigationEligible,blockedBy:field.uiState.blockedBy}:{})}))};
}

async function enterApplication(page: Page, input: ProductInput, signal: AbortSignal,
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
