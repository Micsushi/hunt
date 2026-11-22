import { WorkdayWalkDiagnostics } from './workday-walk-diagnostics.ts';
import { observeWorkdayPage, workdayObservationMessage } from '../ats/workday/page-observation.ts';
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { generatedOperationId, disposeResumeArtifact } from "../contracts/index.ts";
import type { LiveBrowserSessionV1 } from "../contracts/live/index.ts";
import { OwnedWorkdayApplicationRuntime } from "../browser/playwright-live/private/workday-application-runtime.ts";
import type { OwnedApplicationOperation } from "../browser/playwright-live/private/application-page-types.ts";
import { WORKDAY_APPLICATION_PAGE_SELECTORS, type ApplicationPageTruth } from "../ats/workday/application/page-walk-contract.ts";
import { runApplicationPageWalk, type ApplicationWalkDependencies, type ApplicationPortResult } from "../ats/workday/application/page-walk.ts";
import { productSources, productQuestionLearning } from "./sources.ts";
import { join } from "node:path";
import { applicationTarget } from "./target.ts";
import { ApplicationPause, salaryUnitsNotice, type ProductInput } from './application-contract.ts';
import { enterApplication } from './application-authentication.ts';
import { verifyPreparedReview } from './application-review.ts';
import { componentFailure, recordComponentFailure } from './component-diagnostics.ts';
import { walkFailureComponent, operationComponent } from './walk-failure-component.ts';

const id = () => randomBytes(16).toString("hex");

export async function fillApplicationAttempt(page: Page, input: ProductInput, signal: AbortSignal,
  progress: (stage: string) => void, assertTarget: () => void): Promise<{ reviewDigest: string; completedPages: number; needsOwnerReview?: boolean; salaryUnitsNeedReview?: boolean }> {
  const target = applicationTarget(input.url);
  progress("Signing in");
  try {
    await enterApplication(page, input, signal, assertTarget, progress);
  } catch (error) {
    recordComponentFailure(error, 'authentication', 'enter_application');
    throw error;
  }
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
  const diagnostics = new WorkdayWalkDiagnostics(input.learningRoot);
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: { ownerSources: sources, questionLearning: learning.sink }, acceptances: { record() {} },
    nextOperationId: () => generatedOperationId(`operation_${id()}`), timeoutMs: 45_000,
    initialReviewExpected: [], authorizationExpiresAt: session.leaseExpiresAt,
    now: () => new Date().toISOString(),
    trace: diagnostics.trace,
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
    diagnostics.failureCode = undefined;
    diagnostics.failureField = undefined;
    diagnostics.activeOperation=op.kind;
    diagnostics.controlDiagnostics.length=0;
    assertTarget();
    const stage=operationStages[op.kind];
    if(stage)progress(stage);
    const result = await runtime.run(page, { schemaVersion: 1, journeyId: session.journeyId,
      operationId: generatedOperationId(`operation_${id()}`), sessionId: session.sessionId,
      target: session.target, now: new Date().toISOString() }, op, signal).catch(error => {
        recordComponentFailure(error, operationComponent[op.kind], op.kind);
        throw error;
      });
    if(op.kind==='observe') {
      const observed=result as ApplicationPortResult<ApplicationPageTruth>;
      if(observed.ok)diagnostics.observe(observed.value);
    }
    if (result !== null && typeof result === "object" && "ok" in result && result.ok === true) {
      diagnostics.failureCode = undefined;
      diagnostics.failureField = undefined;
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
    if (!result.ok) {
      diagnostics.failureBoundary = walkFailureComponent(result.error.failure);
      diagnostics.recordWalkFailure(result.error);
      const observation=await observeWorkdayPage(page);
      if (!['application','review'].includes(observation.kind)) {
        const pause = new ApplicationPause(workdayObservationMessage(observation) ?? `The current employer page is ${observation.kind === 'loading' ? 'still loading' : 'unrecognized or ambiguous'}. Inspect the tab before retrying.`);
        recordComponentFailure(pause, 'page_state', 'observe_after_walk');
        throw pause;
      }

      if (diagnostics.failureCode === 'employee_relationship_needs_review') throw new ApplicationPause("Complete the question about your relationship to an employee on the employer page, then retry.");
      if (diagnostics.failureCode === 'salary_readback_needs_review') throw new ApplicationPause("Check the salary on the employer page. C3 could not confirm that the retained value matches your saved compensation.");
      if (diagnostics.failureCode === 'questionnaire_attachment_needs_review') throw new ApplicationPause('A required attachment needs your review. Check the requested document and the attached file on the employer page before continuing.');
      if ((diagnostics.failureCode ?? result.error.failure.code) === 'profile_row_unverified') throw new ApplicationPause('Profile history could not be verified against your saved details. Review the existing entries in the tab; C3 has preserved rows it does not own.');
      if ((diagnostics.failureCode ?? result.error.failure.code)==="protected_answer_denied") throw new ApplicationPause("This application requires your decision. Complete the question on the employer page, then retry.");
      throw new ApplicationPause(`Application paused: ${diagnostics.failureCode ?? result.error.failure.code}${diagnostics.failureField ? ` (${diagnostics.failureField})` : ""}. Review the tab before retrying.`);
    }
    diagnostics.failureBoundary = { component: 'review', operation: 'verify_prepared_review' };
    const review = await verifyPreparedReview(page, signal, assertTarget, operation, continuingSavedDraft, diagnostics.reviewIssues, diagnostics.recordDiagnostic);
    return { ...review, salaryUnitsNeedReview: learning.salaryUnitsNeedReview, completedPages: result.value.pageChecks.length, needsOwnerReview: review.needsOwnerReview || learning.needsOwnerReview };
  } catch (error) {
    diagnostics.failureBoundary = componentFailure(error) ?? diagnostics.failureBoundary ?? { component: 'workflow', operation: diagnostics.activeOperation ?? 'walk' };
    recordComponentFailure(error, diagnostics.failureBoundary.component, diagnostics.failureBoundary.operation);
    const typedPause=error instanceof ApplicationPause
      ? /^Application paused: ([a-zA-Z0-9_.:-]{1,120})(?: \(([a-zA-Z0-9_.:-]{1,120})\))?\./.exec(error.message) : null;
    diagnostics.failureField??=typedPause?.[2];
    diagnostics.recordWalkFailure({source:'thrown',failure:{code:diagnostics.failureCode??typedPause?.[1]??'operation_exception'},
      errorClass:error instanceof ApplicationPause?'application_pause':error instanceof TypeError?'type_error':error instanceof Error?'error':'unknown'});
    if (diagnostics.failureCode && !(error instanceof ApplicationPause)) {
      const wrapped = new ApplicationPause(`Application paused: ${diagnostics.failureCode}${diagnostics.failureField ? ` (${diagnostics.failureField})` : ""}. Review the tab before retrying.`);
      recordComponentFailure(wrapped, diagnostics.failureBoundary.component, diagnostics.failureBoundary.operation);
      throw wrapped;
    }
    if (learning.salaryUnitsNeedReview) {
      const paused = new ApplicationPause(`${error instanceof ApplicationPause ? error.message : "Inspect the current employer page before retrying."} ${salaryUnitsNotice}`);
      recordComponentFailure(paused, diagnostics.failureBoundary.component, diagnostics.failureBoundary.operation);
      throw paused;
    }
    throw error;
  } finally {
    runtime.dispose();
    disposeResumeArtifact(sources.resumeIntent.artifact);
    try { learning.finish(); }
    catch { throw new ApplicationPause("C3 could not preserve discovered questions. Your draft is preserved. Check disk space and access, then retry."); }
  }
}
