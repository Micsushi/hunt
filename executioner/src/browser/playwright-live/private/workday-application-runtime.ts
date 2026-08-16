import { createHash, randomBytes } from "node:crypto";

import type { Page } from "playwright";

import type { ApplicationLaneAcceptance } from
  "../../../ats/workday/application/lane-composition.ts";
import { PlaywrightWorkdayApplicationPage } from
  "../../../ats/workday/application/playwright-page.ts";
import {
  completeWorkdayProfilePage,
  PlaywrightWorkdayProfilePage,
  type ProfilePageSnapshot,
  type WorkdayProfilePagePort,
} from "../../../ats/workday/application/profile/index.ts";
import { createQuestionnairePageHandler } from
  "../../../ats/workday/application/questions/index.ts";
import {
  createPlaywrightWorkdayResumePage,
  createWorkdayResumeUploadDriver,
  createWorkdayResumeUploadHandler,
  createWorkdayResumeVerifier,
  workdayResumeUploadFileName,
} from "../../../ats/workday/application/resume/index.ts";
import {
  WORKDAY_APPLICATION_PAGE_SELECTORS,
  type ApplicationPageHandlerPort,
  type ApplicationPortFailure,
} from "../../../ats/workday/application/page-walk.ts";
import type { Stage2ApplicationWalkRuntimeBindingRequest } from
  "../../../composition/s2-application-walk-runner.ts";
import { PlaywrightBrowserSession } from "../../session.ts";
import {
  browserTargetToken,
  boundedText,
  createGeneratedIdAllocator,
  fieldId,
  guardRevision,
  type BrowserPageId,
  type BrowserSessionId,
  type FieldId,
  type FieldDriver,
  type FieldVerifier,
  type OperationId,
} from "../../../contracts/index.ts";
import type {
  BrowserReadback,
  SemanticPageSnapshot,
} from "../../../contracts/index.ts";
import type {
  LiveBrowserSessionV1,
} from "../../../contracts/live/index.ts";
import type { SanitizedStructuralObservationV1 } from
  "../../../contracts/live/index.ts";
import { s2StableErrorPolicy } from "../../../contracts/s2-common-wire.ts";
import { discoverFields } from "../../../form/discovery/discover-fields.ts";
import { createSemanticSnapshot } from "../../../form/semantic-snapshot.ts";
import { createFieldDriver } from "../../../interaction/drivers/registry.ts";
import {
  workdayReviewSignatures,
  type WorkdayReviewStructuralObservationV1,
} from "../../../interaction/review/index.ts";
import { createFieldVerifier } from
  "../../../interaction/verification/field-verifier.ts";
import { createProfileFieldLearningCapture } from
  "../../../live/evidence/profile-field-learning.ts";
import { createSafetyGuard } from "../../../safety/guards.ts";
import type { OwnedApplicationOperation } from "./application-page-types.ts";
import type { OwnedApplicationPageRequest } from "./application-page-types.ts";
import type { ExternalMonitorPage, ExternalMonitorPort } from "./external-monitor-port.ts";
import { valueFreeExternalMonitorPage } from "./value-free-external-monitor-page.ts";
import type { PersistentPage } from "./types.ts";

const runtimeRevision = guardRevision("s2-playwright-runtime-v1");

export function applicationReadyMonitorPage(
  page: PersistentPage,
): ExternalMonitorPage {
  const owned = page as unknown as ExternalMonitorPage & {
    locator(selector: string): {
      count(): Promise<number>;
      nth(index: number): { innerText(): Promise<string> };
    };
  };
  const valueFree = valueFreeExternalMonitorPage(page);
  return Object.freeze({
    screenshot: valueFree.screenshot,
    url: () => owned.url(),
    title: async () => {
      for (const [selector, title] of applicationReadyRoots) {
        if (await owned.locator(selector).count() === 1) return title;
      }
      for (const selector of [
        applicationReadyHeadingSelectors,
        "h1:visible, h2:visible",
        '[data-automation-id="progressBarActiveStep"]:visible',
      ]) {
        const candidates = owned.locator(selector);
        for (let index = 0; index < await candidates.count(); index += 1) {
          const value = (await candidates.nth(index).innerText()).normalize("NFC")
            .replace(/\s+/gu, " ").trim();
          if (applicationReadyTitles.has(value)) return value;
        }
      }
      return owned.title();
    },
  });
}

const applicationReadyRoots = [
  ['[data-automation-id="applyFlowMyInfoPage"]:visible', "My Information"],
  ['[data-automation-id="applyFlowMyExperiencePage"]:visible', "My Experience"],
  ['[data-automation-id="applyFlowMyExpPage"]:visible', "My Experience"],
  ['[data-automation-id="applyFlowApplicationQuestionsPage"]:visible', "Application Questions"],
  ['[data-automation-id="applyFlowVoluntaryDisclosuresPage"]:visible', "Voluntary Disclosures"],
  ['[data-automation-id="applyFlowReviewPage"]:visible', "Review"],
] as const;

const applicationReadyHeadingSelectors = [
  '[data-automation-id="applyFlowMyInfoPage"] h1:visible',
  '[data-automation-id="applyFlowMyInfoPage"] h2:visible',
  '[data-automation-id="applyFlowMyExperiencePage"] h1:visible',
  '[data-automation-id="applyFlowMyExperiencePage"] h2:visible',
  '[data-automation-id="applyFlowMyExpPage"] h1:visible',
  '[data-automation-id="applyFlowMyExpPage"] h2:visible',
  '[data-automation-id="applyFlowApplicationQuestionsPage"] h1:visible',
  '[data-automation-id="applyFlowApplicationQuestionsPage"] h2:visible',
  '[data-automation-id="applyFlowVoluntaryDisclosuresPage"] h1:visible',
  '[data-automation-id="applyFlowVoluntaryDisclosuresPage"] h2:visible',
  '[data-automation-id="applyFlowReviewPage"] h1:visible',
  '[data-automation-id="applyFlowReviewPage"] h2:visible',
].join(", ");

const applicationReadyTitles = new Set<string>(applicationReadyRoots.map(([, title]) => title));

async function waitForApplicationReadyPage(
  page: PersistentPage,
): Promise<ProfilePageSnapshot> {
  const owned = page as unknown as Page;
  const profile = new PlaywrightWorkdayProfilePage(owned, { pageType: "profile" });
  const minimumFieldCount = 1;
  const deadline = Date.now() + 30_000;
  let previousCount = -1;
  let stableSamples = 0;
  let lastDiagnostic: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    try {
      const observed = await profile.inspect(AbortSignal.any([]));
      const fieldCount = observed.controls.length +
        observed.rows.reduce((count, row) => count + row.controls.length, 0);
      const profileRoot = owned.locator('[data-automation-id="applyFlowMyInfoPage"]:visible');
      const profileRootCount = await profileRoot.count();
      const pageHeadingCount = await owned.getByRole("heading", {
        name: /^My Information$/iu,
      }).count();
      const continueCount = await owned.getByRole("button", {
        name: /^Save and Continue$/iu,
      }).count();
      lastDiagnostic = {
        fieldCount,
        minimumFieldCount,
        profileRootCount,
        pageHeadingCount,
        continueCount,
      };
      stableSamples = profileRootCount === 1 && pageHeadingCount === 1 && continueCount === 1 &&
          fieldCount >= minimumFieldCount && fieldCount === previousCount
        ? stableSamples + 1
        : 0;
      previousCount = fieldCount;
      if (stableSamples >= 10) return observed;
    } catch (error) {
      lastDiagnostic = {
        error: error instanceof Error ? error.message : "unknown",
      };
      stableSamples = 0;
      previousCount = -1;
    }
    await owned.waitForTimeout(100);
  }
  if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
    try {
      process.stderr.write(`${JSON.stringify({
        applicationReadySettleDiagnostics: lastDiagnostic,
      })}\n`);
    } catch {}
  }
  throw new TypeError("application-ready page did not settle");
}

export async function applicationReadyMonitorTaxonomy(
  page: PersistentPage,
): Promise<import("./external-monitor-port.ts").ExternalMonitorTaxonomy> {
  const owned = page as unknown as Page;
  const observed = await waitForApplicationReadyPage(page);
  const controls = [
    ...observed.controls,
    ...observed.rows.flatMap(({ controls: rowControls }) => rowControls),
  ];
  const [submitCount, submitActivated] = await Promise.all([
    owned.getByRole("button", { name: /^Submit(?: application)?$/iu }).count(),
    owned.locator("html").getAttribute("data-hunt-submit-activated")
      .then((value) => value === "true"),
  ]);
  if (controls.length < 1 || submitCount !== 0 || submitActivated) {
    throw new TypeError("application-ready monitor taxonomy denied");
  }
  return Object.freeze({
    fieldCount: controls.length,
    requiredFieldCount: controls.filter(({ required }) => required).length,
    controlTypes: Object.freeze(unique(controls.map(({ uiBehavior }) => uiBehavior))),
    questionTypes: Object.freeze(unique(controls.map(({ fieldId }) => monitorQuestionType(fieldId)))),
    answerTypes: Object.freeze(unique(controls.map(({ uiBehavior }) =>
      uiBehavior === "search_select" || uiBehavior === "radio_group" ? "option" :
      uiBehavior === "checkbox" ? "boolean" : uiBehavior
    ))),
    validationState: "clear" as const,
    submitPresent: false,
    submitActivated: false as const,
  });
}

function monitorQuestionType(fieldId: string): string {
  if (fieldId === "source.how_did_you_hear") return "application_source";
  if (fieldId === "employment.previously_worked_for_organization") return "prior_employment";
  if (fieldId.startsWith("skills.")) return "skill";
  const prefix = fieldId.split(".", 1)[0];
  return prefix === undefined || prefix === "unknown" ? "unknown" : prefix;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export interface ReviewExpectedField {
  readonly fieldId: string;
  readonly provenance: string;
  readonly rowIdentity: string;
  readonly valueSha256: string;
}

export interface OwnedWorkdayApplicationRuntimeOptions {
  readonly request: Stage2ApplicationWalkRuntimeBindingRequest;
  readonly acceptances: { record(value: ApplicationLaneAcceptance): void };
  readonly nextOperationId: () => OperationId;
  readonly timeoutMs: number;
  readonly initialReviewExpected: readonly ReviewExpectedField[];
  readonly externalMonitor?: ExternalMonitorPort;
  readonly authorizationExpiresAt: string;
  readonly now: () => string;
  readonly trace?: (event: string, details?: object) => void;
}

/** Fixed browser-owner implementation. Callers supply data, never executable page code. */
export class OwnedWorkdayApplicationRuntime {
  #request: Stage2ApplicationWalkRuntimeBindingRequest | undefined;
  #session: LiveBrowserSessionV1 | undefined;
  readonly #acceptances: OwnedWorkdayApplicationRuntimeOptions["acceptances"];
  readonly #nextOperationId: () => OperationId;
  readonly #timeoutMs: number;
  readonly #externalMonitor: ExternalMonitorPort | undefined;
  readonly #authorizationExpiresAt: string;
  readonly #now: () => string;
  readonly #trace: OwnedWorkdayApplicationRuntimeOptions["trace"];
  readonly #reviewExpected = new Map<string, ReviewExpectedField>();
  readonly #observationMonitorAttempts = new Map<string, number>();
  readonly #navigationMonitorAttempts = new Map<string, number>();
  readonly #mutationMonitorAttempts = new Map<string, number>();

  constructor(options: OwnedWorkdayApplicationRuntimeOptions) {
    this.#request = options.request;
    this.#acceptances = options.acceptances;
    this.#nextOperationId = options.nextOperationId;
    this.#timeoutMs = options.timeoutMs;
    this.#externalMonitor = options.externalMonitor;
    this.#authorizationExpiresAt = options.authorizationExpiresAt;
    this.#now = options.now;
    this.#trace = options.trace;
    for (const value of options.initialReviewExpected) {
      if (!isReviewExpectedField(value) || this.#reviewExpected.has(value.fieldId) ||
          [...this.#reviewExpected.values()].some(({ rowIdentity }) => rowIdentity === value.rowIdentity)) {
        throw new TypeError("review expectation recovery denied");
      }
      this.#reviewExpected.set(value.fieldId, Object.freeze({ ...value }));
    }
  }

  bindSession(session: LiveBrowserSessionV1): void {
    if (this.#session?.sessionId === session.sessionId &&
        this.#session.journeyId === session.journeyId) return;
    if (this.#session !== undefined) throw new TypeError("application runtime already bound");
    this.#session = session;
  }

  dispose(): void {
    this.#request = undefined;
    this.#session = undefined;
    this.#reviewExpected.clear();
  }

  async run(
    ownedPage: PersistentPage,
    ownedRequest: OwnedApplicationPageRequest,
    operation: OwnedApplicationOperation,
    signal: AbortSignal,
  ): Promise<unknown> {
    const page = playwrightPage(ownedPage);
    const request = this.#request;
    const session = this.#session;
    if (request === undefined || session === undefined || signal.aborted) {
      throw new TypeError("application runtime revoked");
    }
    switch (operation.kind) {
      case "observe":
        return new PlaywrightWorkdayApplicationPage(page, { timeoutMs: this.#timeoutMs }).observe(signal);
      case "inspect_recovery": {
        const observed = await new PlaywrightWorkdayApplicationPage(
          page,
          { timeoutMs: this.#timeoutMs },
        ).observe(signal);
        if (observed.ok) await this.#monitor(
          page,
          monitorPage(observed.value.page),
          "recovery_observed",
          ownedRequest.operationId,
          this.#nextObservationMonitorAttempt(
            monitorPage(observed.value.page), "recovery_observed",
          ),
          signal,
        );
        return observed;
      }
      case "next": {
        const input = operation.input as Parameters<PlaywrightWorkdayApplicationPage["next"]>[0];
        const attempt = this.#nextNavigationMonitorAttempt(input.from);
        await this.#monitor(
          page,
          input.from,
          "before_navigation",
          ownedRequest.operationId,
          attempt,
          signal,
        );
        this.#assertAuthorized(signal);
        const advanced = await new PlaywrightWorkdayApplicationPage(page, {
          timeoutMs: this.#timeoutMs,
          navigationSettleTimeoutMs: Math.max(this.#timeoutMs, 90_000),
        }).next(
          input, signal,
        );
        if (advanced.ok) {
          const observed = await new PlaywrightWorkdayApplicationPage(
            page,
            { timeoutMs: this.#timeoutMs },
          ).observe(signal);
          if (!observed.ok || !input.allowed.includes(observed.value.page)) {
            throw new TypeError("application navigation readback denied");
          }
          await this.#monitor(
            page,
            monitorPage(observed.value.page),
            "transition",
            ownedRequest.operationId,
            attempt,
            signal,
          );
        }
        if (advanced.ok) this.#assertAuthorized(signal);
        return advanced;
      }
      case "reconcile_resume": {
        const input = operation.input as Parameters<ApplicationPageHandlerPort<"resume">["reconcile"]>[0];
        const monitorPageName = await this.#monitorPageForLane(page, "resume");
        const monitorAttempt = this.#nextMutationMonitorAttempt(monitorPageName);
        await this.#monitor(
          page, monitorPageName, "before_mutation", ownedRequest.operationId, monitorAttempt, signal,
        );
        this.#assertAuthorized(signal);
        const resumePage = createPlaywrightWorkdayResumePage(page);
        const result = await createWorkdayResumeUploadHandler({
          driver: createWorkdayResumeUploadDriver(resumePage, {
            timeoutMs: this.#timeoutMs,
            trace: this.#trace,
          }),
          verifier: createWorkdayResumeVerifier(resumePage, {
            maxAttempts: 20,
            intervalMs: 50,
            trace: this.#trace,
          }),
          replaceExisting: true,
          emit: (event) => this.#trace?.("resume_upload_event", { kind: event.kind }),
        }).upload(request.ownerSources.resumeIntent, signal);
        if (!result.ok) throw new TypeError("resume reconciliation denied");
        this.#acceptances.record(result.value);
        this.#recordReviewExpectation(
          "s1-field-resume",
          "resume_verified",
          workdayResumeUploadFileName(request.ownerSources.resumeIntent),
        );
        this.#trace?.("resume_upload_after_readback_monitor_started", {
          page: monitorPageName,
        });
        await this.#monitor(
          page, monitorPageName, "after_readback", ownedRequest.operationId, monitorAttempt, signal,
        );
        this.#trace?.("resume_upload_after_readback_monitor_succeeded", {
          page: monitorPageName,
        });
        this.#assertAuthorized(signal);
        return verified("resume", "resume_verified", input.pageId);
      }
      case "reconcile_profile": {
        const input = operation.input as Parameters<ApplicationPageHandlerPort<"profile">["reconcile"]>[0];
        const monitorPageName = await this.#monitorPageForLane(page, "profile");
        await this.#monitor(
          page,
          monitorPageName,
          "state_observed",
          ownedRequest.operationId,
          this.#nextObservationMonitorAttempt(monitorPageName, "state_observed"),
          signal,
        );
        this.#assertAuthorized(signal);
        let mutationAttempted = false;
        const playwrightProfilePage = new PlaywrightWorkdayProfilePage(page, {
          pageType: request.ownerSources.profilePlan.pageType,
          timeoutMs: this.#timeoutMs,
        });
        const profilePage: WorkdayProfilePagePort = {
          inspect: (innerSignal) => playwrightProfilePage.inspect(innerSignal),
          commit: async (commit, innerSignal) => {
            mutationAttempted = true;
            const operationId = this.#nextOperationId();
            const attempt = this.#nextMutationMonitorAttempt(monitorPageName);
            await this.#monitor(
              page, monitorPageName, "before_mutation", operationId, attempt, innerSignal,
            );
            this.#assertAuthorized(innerSignal);
            try {
              return await playwrightProfilePage.commit(commit, innerSignal);
            } finally {
              await this.#monitor(
                page, monitorPageName, "after_readback", operationId, attempt, innerSignal,
              );
              this.#assertAuthorized(innerSignal);
            }
          },
          addOwnedRow: async (section, innerSignal) => {
            mutationAttempted = true;
            const operationId = this.#nextOperationId();
            const attempt = this.#nextMutationMonitorAttempt(monitorPageName);
            await this.#monitor(
              page, monitorPageName, "before_mutation", operationId, attempt, innerSignal,
            );
            this.#assertAuthorized(innerSignal);
            const added = await playwrightProfilePage.addOwnedRow(section, innerSignal);
            await this.#monitor(
              page, monitorPageName, "after_readback", operationId, attempt, innerSignal,
            );
            this.#assertAuthorized(innerSignal);
            return added;
          },
          removeOwnedRow: async (section, rowId, innerSignal) => {
            mutationAttempted = true;
            const operationId = this.#nextOperationId();
            const attempt = this.#nextMutationMonitorAttempt(monitorPageName);
            await this.#monitor(
              page, monitorPageName, "before_mutation", operationId, attempt, innerSignal,
            );
            this.#assertAuthorized(innerSignal);
            const removed = await playwrightProfilePage.removeOwnedRow(section, rowId, innerSignal);
            await this.#monitor(
              page, monitorPageName, "after_readback", operationId, attempt, innerSignal,
            );
            this.#assertAuthorized(innerSignal);
            return removed;
          },
          interaction: (controlId) => playwrightProfilePage.interaction(controlId),
        };
        const learning = createProfileFieldLearningCapture({
          page: profilePage,
          plan: request.ownerSources.profilePlan,
          root: request.owner?.roots?.evidence?.path,
          fileName: monitorPageName === "profile"
            ? "profile-field-learning.json"
            : "profile-field-learning-02.json",
          sensitiveValues: request.ownerSources.sensitiveValues,
        });
        let learningSha256: string | null = null;
        let result;
        try {
          result = await completeWorkdayProfilePage(
            request.ownerSources.profilePlan,
            learning.page,
            signal,
          );
        } finally {
          learningSha256 = learning.write();
        }
        if (result.kind !== "verified" || result.ownedDuplicateRows !== 0) {
          if (result.kind === "blocked") {
            try {
              this.#trace?.("profile_reconciliation_blocked", {
                code: result.code,
                ...(result.fieldId === undefined ? {} : { fieldId: result.fieldId }),
                ...(result.uiBehavior === undefined ? {} : { uiBehavior: result.uiBehavior }),
                ...(result.uiVariant === undefined ? {} : { uiVariant: result.uiVariant }),
                mutationAttempted,
              });
            } catch {
              // Diagnostics never change application behavior.
            }
          }
          if (!mutationAttempted && result.kind === "blocked") {
            return applicationFailure(
              result.code === "operation_cancelled"
                ? "operation_cancelled"
                : "page_incomplete",
              "profile_control",
              result.code === "operation_cancelled"
                ? "none"
                : result.code === "answer_type_unknown" ||
                  result.code === "profile_answer_missing"
                ? "required_field"
                : "ui_behavior",
            );
          }
          throw new TypeError("profile reconciliation denied");
        }
        this.#acceptances.record(Object.freeze({
          schemaVersion: 1,
          checkpoint: "profile_verified",
          pageType: result.pageType,
          verifiedFields: result.verifiedFields,
          ownedDuplicateRows: 0,
          independentlyVerified: true,
          ...(learningSha256 === null
            ? {}
            : { profileFieldLearningSha256: learningSha256 }),
          submitActivated: false,
          privacyScan: "pass",
        }));
        this.#recordProfileReviewExpectations(request, result.verifiedFields);
        if (await this.#monitorPageForLane(page, "profile") !== monitorPageName) {
          throw new TypeError("profile reconciliation page drift denied");
        }
        this.#assertAuthorized(signal);
        return verified("profile", "profile_verified", input.pageId);
      }
      case "reconcile_questionnaire": {
        const input = operation.input as Parameters<ApplicationPageHandlerPort<"questionnaire">["reconcile"]>[0];
        const monitorPageName = await this.#monitorPageForLane(page, "questionnaire");
        await this.#monitor(
          page,
          monitorPageName,
          "state_observed",
          ownedRequest.operationId,
          this.#nextObservationMonitorAttempt(monitorPageName, "state_observed"),
          signal,
        );
        this.#assertAuthorized(signal);
        const result = await this.#reconcileQuestionnaire(
          page,
          input,
          request,
          session,
          monitorPageName,
          signal,
        );
        if (await this.#monitorPageForLane(page, "questionnaire") !== monitorPageName) {
          throw new TypeError("questionnaire reconciliation page drift denied");
        }
        this.#assertAuthorized(signal);
        return result;
      }
      case "reload": {
        const observed = await new PlaywrightWorkdayApplicationPage(
          page,
          { timeoutMs: this.#timeoutMs },
        ).observe(signal);
        if (!observed.ok) throw new TypeError("application reload monitor denied");
        const fromPage = monitorPage(observed.value.page);
        const attempt = this.#nextNavigationMonitorAttempt(fromPage);
        await this.#monitor(
          page,
          fromPage,
          "before_navigation",
          ownedRequest.operationId,
          attempt,
          signal,
        );
        this.#assertAuthorized(signal);
        await page.reload({ waitUntil: "domcontentloaded" });
        const after = await new PlaywrightWorkdayApplicationPage(
          page,
          { timeoutMs: this.#timeoutMs },
        ).observe(signal);
        if (!after.ok) throw new TypeError("application reload readback denied");
        await this.#monitor(
          page,
          monitorPage(after.value.page),
          "transition",
          ownedRequest.operationId,
          attempt,
          signal,
        );
        this.#assertAuthorized(signal);
        return undefined;
      }
      case "review_expectations":
        return Object.freeze([...this.#reviewExpected.values()]);
      case "monitor_auth_state": {
        const observed = await waitForApplicationObservation(
          page,
          Math.max(this.#timeoutMs, 90_000),
          signal,
        );
        if (!observed.ok || observed.value.submitActivated || this.#externalMonitor === undefined) {
          throw new TypeError("account monitor state denied");
        }
        await this.#externalMonitor.auth(
          applicationMonitorPage(page, monitorPage(observed.value.page)),
          "application_ready",
          "state_observed",
          await monitorTaxonomy(page, monitorPage(observed.value.page)),
          { operationId: ownedRequest.operationId, attempt: 1 },
          signal,
        );
        return undefined;
      }
      case "capture_review": {
        this.#assertAuthorized(signal);
        const questionLearningSha256 = request.questionLearning?.write() ?? null;
        this.#trace?.("question_answer_learning_sealed", {
          present: questionLearningSha256 !== null,
        });
        const application = await new PlaywrightWorkdayApplicationPage(
          page,
          { timeoutMs: this.#timeoutMs },
        ).observe(signal);
        if (!application.ok || application.value.page !== "pre_review" ||
            application.value.submitActivated) throw new TypeError("Review page is unavailable");
        const beforeReview = await captureIndependentReviewFields(page, this.#reviewExpected);
        const beforeStructure = await captureReviewStructure(page);
        await this.#monitor(
          page,
          "review",
          "review_readback",
          ownedRequest.operationId,
          this.#nextObservationMonitorAttempt("review", "review_readback"),
          signal,
        );
        this.#assertAuthorized(signal);
        const freshApplication = await new PlaywrightWorkdayApplicationPage(
          page,
          { timeoutMs: this.#timeoutMs },
        ).observe(signal);
        if (!freshApplication.ok || freshApplication.value.page !== "pre_review" ||
            freshApplication.value.submitActivated) throw new TypeError("Review page drift denied");
        const review = await captureIndependentReviewFields(page, this.#reviewExpected);
        const structure = await captureReviewStructure(page);
        if (JSON.stringify(beforeReview) !== JSON.stringify(review) ||
            JSON.stringify(beforeStructure) !== JSON.stringify(structure)) {
          throw new TypeError("Review readback drift denied");
        }
        return Object.freeze({
          application: freshApplication.value,
          structure,
          review,
        });
      }
    }
  }

  async #monitor(
    page: Page,
    pageName: "resume" | "profile" | "questionnaire" | "review",
    moment: string,
    operationId: OperationId,
    attempt: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#externalMonitor === undefined) return;
    await this.#externalMonitor.application(
      applicationMonitorPage(page, pageName),
      pageName,
      moment,
      await monitorTaxonomy(page, pageName),
      { operationId, attempt },
      signal,
    );
  }

  #nextNavigationMonitorAttempt(from: string): number {
    const key = from;
    const attempt = (this.#navigationMonitorAttempts.get(key) ?? 0) + 1;
    this.#navigationMonitorAttempts.set(key, attempt);
    return attempt;
  }

  #nextObservationMonitorAttempt(page: string, moment: string): number {
    const key = `${page}:${moment}`;
    const attempt = (this.#observationMonitorAttempts.get(key) ?? 0) + 1;
    this.#observationMonitorAttempts.set(key, attempt);
    return attempt;
  }

  #nextMutationMonitorAttempt(page: string): number {
    const attempt = (this.#mutationMonitorAttempts.get(page) ?? 0) + 1;
    this.#mutationMonitorAttempts.set(page, attempt);
    return attempt;
  }

  async #monitorPageForLane(
    page: Page,
    lane: "resume" | "profile" | "questionnaire",
  ): Promise<"resume" | "profile" | "questionnaire"> {
    const observed = await new PlaywrightWorkdayApplicationPage(
      page,
      { timeoutMs: this.#timeoutMs },
    ).observe(AbortSignal.any([]));
    if (!observed.ok || observed.value.submitActivated || observed.value.page === "pre_review") {
      throw new TypeError("application mutation page denied");
    }
    const lanes = observed.value.lanes ?? [observed.value.page];
    if (!lanes.includes(lane)) throw new TypeError("application mutation lane denied");
    return observed.value.page;
  }

  #assertAuthorized(signal: AbortSignal): void {
    const now = this.#now();
    if (signal.aborted || !/^\d{4}-\d{2}-\d{2}T/u.test(now) ||
        !Number.isFinite(Date.parse(now)) ||
        Date.parse(now) >= Date.parse(this.#authorizationExpiresAt)) {
      throw new TypeError("application authorization expired");
    }
  }

  async #reconcileQuestionnaire(
    page: Page,
    input: Parameters<ApplicationPageHandlerPort<"questionnaire">["reconcile"]>[0],
    request: Stage2ApplicationWalkRuntimeBindingRequest,
    session: LiveBrowserSessionV1,
    monitorPageName: "resume" | "profile" | "questionnaire",
    signal: AbortSignal,
  ): Promise<unknown> {
    await bindQuestionnaireTargets(page, input.pageId);
    const semanticSessionId = `browser_session_${randomBytes(12).toString("hex")}` as BrowserSessionId;
    const semantic = new PlaywrightBrowserSession({
      attached: { page, sessionId: semanticSessionId, pageId: input.pageId },
      ids: createGeneratedIdAllocator({ next: () => randomBytes(8).toString("hex") }),
      timeoutMs: this.#timeoutMs,
    });
    try {
      const observed = await semantic.observe({ sessionId: semanticSessionId, pageId: input.pageId }, signal);
      if (!observed.ok) return applicationFailure(observed.error.code, "question_control", "ui_behavior");
      const snapshot = createSemanticSnapshot(
        { kind: "workday", page: "questionnaire" }, discoverFields(observed.value.targets),
      );
      const [application, taxonomy] = await Promise.all([
        new PlaywrightWorkdayApplicationPage(page, { timeoutMs: this.#timeoutMs }).observe(signal),
        monitorTaxonomy(page, monitorPageName),
      ]);
      const visibleFields = snapshot.fields.filter(({ state }) => state !== "hidden");
      const requiredFieldCount = visibleFields.filter(({ required }) => required).length;
      if (
        visibleFields.length === 0 ||
        !application.ok || application.value.page !== "questionnaire" ||
        application.value.requiredFields.length !== requiredFieldCount ||
        taxonomy.fieldCount !== visibleFields.length ||
        taxonomy.requiredFieldCount !== requiredFieldCount
      ) throw new TypeError("questionnaire field coverage mismatch");
      const facts = structuralObservations(snapshot.fields);
      const semanticDriver = createFieldDriver(semantic, createSafetyGuard());
      const semanticVerifier = createFieldVerifier(semantic);
      const monitoredAttempts = new Map<string, number>();
      const driver: FieldDriver = Object.freeze({
        drive: async (
          driveRequest: Parameters<FieldDriver["drive"]>[0],
          innerSignal: AbortSignal,
        ) => {
          const attempt = this.#nextMutationMonitorAttempt(monitorPageName);
          monitoredAttempts.set(driveRequest.operationId, attempt);
          await this.#monitor(
            page, monitorPageName, "before_mutation", driveRequest.operationId, attempt, innerSignal,
          );
          this.#assertAuthorized(innerSignal);
          return semanticDriver.drive(driveRequest, innerSignal);
        },
      });
      const verifier: FieldVerifier = Object.freeze({
        verify: async (
          verificationRequest: Parameters<FieldVerifier["verify"]>[0],
          innerSignal: AbortSignal,
        ) => {
          const verified = await semanticVerifier.verify(verificationRequest, innerSignal);
          const operationId = verificationRequest.receipt.operationId;
          const attempt = monitoredAttempts.get(operationId);
          if (attempt === undefined) throw new TypeError("questionnaire monitor binding unavailable");
          await this.#monitor(
            page, monitorPageName, "after_readback", operationId, attempt, innerSignal,
          );
          this.#assertAuthorized(innerSignal);
          monitoredAttempts.delete(operationId);
          return verified;
        },
      });
      const questionLearning = request.questionLearning;
      const questionnaire = createQuestionnairePageHandler({
        profileQuery: request.ownerSources.profileQuery,
        driver,
        verifier,
        narrative: request.ownerSources.narrative,
        nextOperationId: this.#nextOperationId,
        allocateCandidateId: () => `unknown_candidate_${randomBytes(12).toString("hex")}` as never,
        observationFor: (fieldId, layer) => facts.get(`${fieldId}:${layer}`),
        recordAnswer: questionLearning?.record,
      });
      const completed = await questionnaire.complete({
        journeyId: session.journeyId,
        sessionId: semanticSessionId,
        pageId: input.pageId,
        guardRevision: runtimeRevision,
        profileId: request.ownerSources.profileId,
        profileRevision: request.ownerSources.profileRevision,
        resume: {
          resumeId: request.ownerSources.resumeIntent.artifact.resumeId,
          sha256: request.ownerSources.resumeIntent.artifact.sha256,
        },
        resumeArtifact: request.ownerSources.resumeIntent.artifact,
        page: snapshot,
      }, signal);
      if (!completed.ok && new Set([
        "browser_effect_uncertain", "browser_session_invalidated", "browser_target_stale",
      ]).has(completed.error.code)) throw new TypeError("questionnaire browser effect uncertain");
      if (!completed.ok) {
        this.#trace?.("questionnaire_reconciliation_failed", {
          code: completed.error.code,
        });
        return applicationFailure("page_incomplete", "question_control", "question");
      }
      if (completed.value.kind === "blocked") {
        this.#trace?.("questionnaire_reconciliation_blocked", {
          code: completed.value.code,
          candidatePresent: completed.value.candidate !== undefined,
        });
        const placeholderCount = completed.value.protectedPlaceholderCount;
        if (
          completed.value.placeholderProvenance !== undefined &&
          placeholderCount !== 0 && placeholderCount !== 1
        ) return applicationFailure("page_incomplete", "question_control", "question");
        const safePlaceholderCount: 0 | 1 = placeholderCount === 1 ? 1 : 0;
        return applicationFailure(
          completed.value.code,
          "question_control",
          "question",
          completed.value.placeholderProvenance === undefined
            ? undefined
            : {
                protectedPlaceholderCount: safePlaceholderCount,
                placeholderProvenance: completed.value.placeholderProvenance,
              },
        );
      }
      if (completed.value.protectedPlaceholderCount !== 0) {
        return applicationFailure("page_incomplete", "question_control", "question");
      }
      this.#acceptances.record(Object.freeze({
        schemaVersion: 1,
        checkpoint: "questionnaire_verified",
        answers: completed.value.answers,
        protectedPlaceholderCount: 0,
        independentlyVerified: true,
        submitActivated: false,
        privacyScan: "pass",
      }));
      const after = await semantic.observe({ sessionId: semanticSessionId, pageId: input.pageId }, signal);
      if (!after.ok) throw new TypeError("questionnaire review truth unavailable");
      const targets = new Map(after.value.targets.map((target) => [target.token, target]));
      for (const answer of completed.value.answers) {
        const field = snapshot.fields.find(({ fieldId }) => fieldId === answer.fieldId);
        const target = field === undefined ? undefined : targets.get(field.target);
        const value = target === undefined ? undefined : reviewReadbackValue(target.readback);
        if (value === undefined) throw new TypeError("questionnaire review truth unavailable");
        this.#recordReviewExpectation(answer.fieldId, answer.provenance, value);
      }
      return verified("questionnaire", "questionnaire_verified", input.pageId);
    } finally {
      await semantic.close({ sessionId: semanticSessionId }, new AbortController().signal);
    }
  }

  #recordProfileReviewExpectations(
    request: Stage2ApplicationWalkRuntimeBindingRequest,
    verifiedFields: readonly {
      readonly fieldId: string;
      readonly provenance: string;
      readonly rowKey?: string;
    }[],
  ): void {
    const scalarPlans = request.ownerSources.profilePlan.fields;
    const repeatablePlans = request.ownerSources.profilePlan.repeatables.flatMap(({ rows }) =>
      rows.map(({ rowKey, fields }) => ({ rowKey, fields }))
    );
    for (const verifiedField of verifiedFields) {
      const candidates = verifiedField.rowKey === undefined
        ? scalarPlans.filter(({ fieldId }) => fieldId === verifiedField.fieldId)
        : repeatablePlans
          .filter(({ rowKey }) => rowKey === verifiedField.rowKey)
          .flatMap(({ fields }) => fields)
          .filter(({ fieldId }) => fieldId === verifiedField.fieldId);
      if (candidates.length !== 1 || candidates[0]?.answer.kind !== "answered") {
        throw new TypeError("profile review truth unavailable");
      }
      const plan = candidates[0];
      if (plan.answer.kind !== "answered") throw new TypeError("profile review truth unavailable");
      this.#recordReviewExpectation(
        verifiedField.rowKey === undefined
          ? verifiedField.fieldId
          : repeatableReviewFieldId(verifiedField.rowKey, verifiedField.fieldId),
        verifiedField.provenance,
        plan.optionMapping?.visibleOption ?? plan.answer.value,
      );
    }
  }

  #recordReviewExpectation(field: string, provenance: string, value: string): void {
    if (this.#reviewExpected.has(field)) throw new TypeError("review field ambiguous");
    const normalized = normalizeReviewValue(value);
    const rowIdentity = `formField-${field}`;
    if (normalized === "" || !isStableRowIdentity(rowIdentity) ||
        [...this.#reviewExpected.values()].some((item) => item.rowIdentity === rowIdentity)) {
      throw new TypeError("review field value unavailable");
    }
    this.#reviewExpected.set(field, Object.freeze({
      fieldId: field,
      provenance,
      rowIdentity,
      valueSha256: createHash("sha256").update(normalized, "utf8").digest("hex"),
    }));
  }

}

function repeatableReviewFieldId(rowKey: string, fieldIdValue: string): string {
  const digest = createHash("sha256").update(rowKey, "utf8").digest("hex").slice(0, 16);
  const candidate = `repeatable.${digest}.${fieldIdValue}`;
  if (!isAcceptedFieldId(candidate)) throw new TypeError("repeatable review field identity denied");
  return candidate;
}

async function waitForApplicationObservation(
  page: Page,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  const reloadAt = startedAt + Math.min(30_000, Math.floor(timeoutMs / 2));
  let reloaded = false;
  let latest = await new PlaywrightWorkdayApplicationPage(page, { timeoutMs }).observe(signal);
  while (!latest.ok && Date.now() < deadline) {
    if (signal.aborted) return latest;
    if (!reloaded && Date.now() >= reloadAt &&
        await page.locator('[data-automation-id="applyFlowPage"]:visible').count() === 1) {
      reloaded = true;
      if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
        try {
          process.stderr.write(`${JSON.stringify({
            applicationStateRecovery: "owned_shell_reload_started",
          })}\n`);
        } catch {}
      }
      await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
        try {
          process.stderr.write(`${JSON.stringify({
            applicationStateRecovery: "owned_shell_reload_completed",
          })}\n`);
        } catch {}
      }
    }
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
    latest = await new PlaywrightWorkdayApplicationPage(page, { timeoutMs }).observe(signal);
  }
  return latest;
}

function reviewReadbackValue(readback: BrowserReadback): string | undefined {
  if (readback.kind === "text") return readback.value;
  if (readback.kind === "selected") return readback.option ?? undefined;
  if (readback.kind === "checked") return readback.checked ? "true" : "false";
  return undefined;
}

function normalizeReviewValue(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function monitorPage(
  page: "resume" | "profile" | "questionnaire" | "pre_review",
): "resume" | "profile" | "questionnaire" | "review" {
  return page === "pre_review" ? "review" : page;
}

function applicationMonitorPage(
  page: Page,
  pageName: "resume" | "profile" | "questionnaire" | "review",
): ExternalMonitorPage {
  if (pageName === "profile") {
    return applicationReadyMonitorPage(page as unknown as PersistentPage);
  }
  return valueFreeExternalMonitorPage(page as unknown as PersistentPage, async () => {
      const roots = pageName === "resume"
          ? [
              '[data-automation-id="applyFlowMyExperiencePage"]',
              '[data-automation-id="applyFlowMyExpPage"]',
            ]
          : pageName === "review"
            ? ['[data-automation-id="applyFlowReviewPage"]']
            : [
                '[data-automation-id="applyFlowPrimaryQuestionsPage"]',
                '[data-automation-id="applyFlowPrimaryQuestionnairePage"]',
                '[data-automation-id="applyFlowApplicationQuestionsPage"]',
                '[data-automation-id="applyFlowVoluntaryDisclosuresPage"]',
              ];
      for (const selector of [
        roots.flatMap((root) => [`${root} h1:visible`, `${root} h2:visible`]).join(", "),
        "h1:visible, h2:visible",
        '[data-automation-id="progressBarActiveStep"]:visible',
      ]) {
        const candidates = page.locator(selector);
        for (let index = 0; index < await candidates.count(); index += 1) {
          const value = normalizeReviewValue(await candidates.nth(index).innerText());
          if (monitorTitles(pageName).has(value)) return value;
        }
      }
      return page.title();
  });
}

function monitorTitles(
  pageName: "resume" | "profile" | "questionnaire" | "review",
): ReadonlySet<string> {
  if (pageName === "profile") return new Set(["My Information"]);
  if (pageName === "resume") return new Set(["My Experience"]);
  if (pageName === "review") return new Set(["Review"]);
  return new Set(["Application Questions", "Voluntary Disclosures"]);
}

async function monitorQuestionnaireCoverage(page: Page): Promise<{
  readonly fieldCount: number;
  readonly requiredFieldCount: number;
  readonly typeCounts: Readonly<Record<string, number>>;
} | null> {
  return page.evaluate(() => {
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element.hidden ||
          element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" &&
        style.visibility !== "collapse" && element.getClientRects().length > 0;
    };
    const roots = [
      '[data-automation-id="applyFlowPrimaryQuestionsPage"]',
      '[data-automation-id="applyFlowPrimaryQuestionnairePage"]',
      '[data-automation-id="applyFlowApplicationQuestionsPage"]',
      '[data-automation-id="applyFlowVoluntaryDisclosuresPage"]',
    ].flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
      .filter(visible)
      .filter((candidate, _index, all) => all.every((root) =>
        candidate === root || candidate.contains(root)
      ));
    if (roots.length !== 1) return null;
    const controls = [...new Set(roots[0]!.querySelectorAll<HTMLElement>(
      'fieldset, input:not([type="hidden"]), textarea, select, [role="combobox"], ' +
        '[role="listbox"], [role="radio"], [role="checkbox"], ' +
        'button[aria-haspopup="listbox"]',
    ))].filter((control) => {
      if (!visible(control) || control.hasAttribute("disabled") ||
          control.getAttribute("aria-disabled") === "true") return false;
      if (control instanceof HTMLFieldSetElement) {
        return control.querySelector('input[type="radio"], [role="radio"]') !== null;
      }
      if (
        (control instanceof HTMLInputElement && control.type === "radio" ||
          control.getAttribute("role") === "radio") &&
        control.closest("fieldset") !== null
      ) return false;
      return true;
    });
    const typeCounts: Record<string, number> = {};
    const requiredMarker =
      '[data-automation-id="required"], abbr[title="Required"], [aria-label="Required"]';
    const accessibleRequired = (control: HTMLElement): boolean => {
      const labels = control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement
        ? [...control.labels ?? []].map((label) => label.textContent ?? "")
        : [];
      const accessibleName = (control.getAttribute("aria-label") ?? "") + " " + labels.join(" ");
      return /(?:^|\s|\()required\)?(?:\s*\*)?$/iu.test(accessibleName.trim()) &&
        !/(?:^|\s|\()not required\)?(?:\s*\*)?$/iu.test(accessibleName.trim());
    };
    let requiredFieldCount = 0;
    for (const control of controls) {
      let type = "text";
      if (control instanceof HTMLTextAreaElement) type = "textarea";
      else if (control instanceof HTMLSelectElement ||
          control.getAttribute("role") === "combobox" ||
          control.getAttribute("role") === "listbox" ||
          control.getAttribute("aria-haspopup") === "listbox") type = "select";
      else if (control instanceof HTMLFieldSetElement ||
          control instanceof HTMLInputElement && control.type === "radio" ||
          control.getAttribute("role") === "radio") type = "radio";
      else if (control instanceof HTMLInputElement && control.type === "checkbox" ||
          control.getAttribute("role") === "checkbox") type = "checkbox";
      else if (control instanceof HTMLInputElement && control.type === "tel") type = "phone";
      else if (control instanceof HTMLInputElement && control.type === "number") type = "number";
      else if (control instanceof HTMLInputElement && control.type === "date") type = "date";
      else if (control instanceof HTMLInputElement && control.type === "file") type = "file_upload";
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;

      const field = control.closest(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      );
      if (
        control.hasAttribute("required") || control.getAttribute("aria-required") === "true" ||
        accessibleRequired(control) ||
        control instanceof HTMLFieldSetElement &&
          [...control.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
            .some((radio) => radio.required) ||
        field !== null && field.querySelector(requiredMarker) !== null
      ) requiredFieldCount += 1;
    }
    return { fieldCount: controls.length, requiredFieldCount, typeCounts };
  });
}

async function monitorTaxonomy(
  page: Page,
  pageName: "resume" | "profile" | "questionnaire" | "review",
) {
  if (pageName === "profile" &&
      await page.locator("html[data-hunt-page-id]").count() === 0) {
    return applicationReadyMonitorTaxonomy(page as unknown as PersistentPage);
  }
  const selectors = [
    ["text", 'input:not([type]):visible, input[type="text"]:visible, input[type="email"]:visible'],
    ["phone", 'input[type="tel"]:visible'],
    ["number", 'input[type="number"]:visible'],
    ["textarea", "textarea:visible"],
    ["select", 'select:visible, [role=combobox]:visible, [aria-haspopup="listbox"]:visible'],
    ["radio", 'input[type="radio"]:visible, [role=radio]:visible'],
    ["checkbox", 'input[type="checkbox"]:visible, [role=checkbox]:visible'],
    ["date", 'input[type="date"]:visible, [data-automation-id="dateSection"]:visible'],
    ["file_upload", 'input[type="file"]:visible'],
  ] as const;
  const questionnaireCoverage = pageName === "questionnaire"
    ? await monitorQuestionnaireCoverage(page)
    : undefined;
  if (questionnaireCoverage === null) {
    throw new TypeError("application monitor taxonomy denied");
  }
  const counts = questionnaireCoverage === undefined
    ? await Promise.all(selectors.map(async ([type, selector]) =>
        [type, await page.locator(selector).count()] as const
      ))
    : selectors.map(([type]) => [type, questionnaireCoverage.typeCounts[type] ?? 0] as const);
  const experience = pageName === "resume" && await page.locator(
      '[data-automation-id="applyFlowMyExperiencePage"]:visible, ' +
        '[data-automation-id="applyFlowMyExpPage"]:visible',
    ).count() === 1
    ? await monitorExperienceTaxonomy(page)
    : undefined;
  const controlTypes = experience?.controlTypes ??
    counts.filter(([, count]) => count > 0).map(([type]) => type);
  const fieldCount = experience?.fieldCount ??
    questionnaireCoverage?.fieldCount ?? counts.reduce((sum, [, count]) => sum + count, 0);
  const requiredFieldCount = experience?.requiredFieldCount ??
    questionnaireCoverage?.requiredFieldCount ?? await page.locator(
      'input[required]:visible, textarea[required]:visible, select[required]:visible, [aria-required="true"]:visible',
    ).count();
  const answerTypes = experience === undefined
    ? new Set<string>()
    : new Set(experience.answerTypes);
  if (experience === undefined) {
    for (const [type, count] of counts) {
      if (count === 0) continue;
      if (type === "radio" || type === "select") answerTypes.add("single_select");
      else if (type === "checkbox") answerTypes.add("boolean");
      else if (type === "date") answerTypes.add("date");
      else if (type === "file_upload") answerTypes.add("file");
      else if (type === "number") answerTypes.add("number");
      else answerTypes.add("text");
    }
  }
  const [validationErrorCount, submitCount, submitActivated, questionTypes] = await Promise.all([
    page.locator(
      '[aria-invalid="true"]:visible, [data-automation-id*="error" i]:visible, ' +
        '[role="alert"][class*="error" i]:visible',
    ).count(),
    page.getByRole("button", { name: workdayReviewSignatures.finalSubmitName }).count(),
    page.locator("html").getAttribute("data-hunt-submit-activated")
      .then((value) => value === "true"),
    experience === undefined
      ? monitorQuestionTypes(page, pageName)
      : Promise.resolve(experience.questionTypes),
  ]);
  if (
    requiredFieldCount > fieldCount ||
    validationErrorCount !== 0 ||
    submitActivated ||
    (submitCount === 1) !== (pageName === "review") ||
    submitCount > 1
  ) {
    if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
      try {
        const [ariaInvalidCount, automationErrorCount, alertErrorCount] = await Promise.all([
          page.locator('[aria-invalid="true"]:visible').count(),
          page.locator('[data-automation-id*="error" i]:visible').count(),
          page.locator('[role="alert"][class*="error" i]:visible').count(),
        ]);
        process.stderr.write(`${JSON.stringify({
          applicationMonitorTaxonomyDenied: {
            pageName,
            validationErrorCount,
            ariaInvalidCount,
            automationErrorCount,
            alertErrorCount,
            submitCount,
            submitActivated,
          },
        })}\n`);
      } catch {}
    }
    throw new TypeError("application monitor taxonomy denied");
  }
  return Object.freeze({
    fieldCount,
    requiredFieldCount,
    controlTypes: Object.freeze(controlTypes.length === 0 ? ["text"] : controlTypes),
    questionTypes,
    answerTypes: Object.freeze(answerTypes.size === 0 ? ["text"] : [...answerTypes]),
    validationState: "clear" as const,
    submitPresent: submitCount === 1,
    submitActivated: false as const,
  });
}

async function monitorExperienceTaxonomy(page: Page): Promise<{
  readonly fieldCount: number;
  readonly requiredFieldCount: number;
  readonly controlTypes: readonly string[];
  readonly questionTypes: readonly string[];
  readonly answerTypes: readonly string[];
}> {
  const read = async () => await page.evaluate(() => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element.hidden ||
          element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" &&
        style.visibility !== "collapse" && element.getClientRects().length > 0;
    };
    const roots = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-automation-id="applyFlowMyExperiencePage"], ' +
          '[data-automation-id="applyFlowMyExpPage"]',
      ),
    ].filter(visible);
    if (roots.length !== 1) return null;
    const root = roots[0]!;
    const candidates = [...new Set(root.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]), textarea, select, [role="combobox"], ' +
        'button[aria-haspopup="listbox"], button[aria-haspopup="true"], ' +
        'button[data-automation-id="sourcePrompt"]',
    ))].filter((control) => {
      if (control instanceof HTMLInputElement && control.type === "file") {
        return !control.disabled && control.getAttribute("aria-disabled") !== "true";
      }
      return visible(control) && !control.hasAttribute("disabled") &&
        control.getAttribute("aria-disabled") !== "true";
    });
    const labels = (control: HTMLElement): string => {
      const values: string[] = [];
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ||
          control instanceof HTMLSelectElement) {
        for (const label of control.labels ?? []) values.push(normalize(label.textContent));
      }
      const id = control.id;
      if (id !== "") {
        for (const label of document.querySelectorAll<HTMLLabelElement>("label[for]")) {
          if (label.htmlFor === id) values.push(normalize(label.textContent));
        }
      }
      const owner = control.closest<HTMLElement>('[data-automation-id^="formField-"]');
      if (owner !== null) values.push(normalize(owner.textContent));
      values.push(normalize(control.getAttribute("aria-label")));
      return values.filter(Boolean).join(" ");
    };
    const controlTypes = new Set<string>();
    const answerTypes = new Set<string>();
    const diagnostics: {
      readonly automationId: string;
      readonly id: string;
      readonly name: string;
      readonly placeholder: string;
      readonly label: string;
      readonly ownerAutomationIds: readonly string[];
      readonly tag: string;
      readonly inputType: string;
      readonly role: string;
      readonly classifiedType: string;
      readonly required: boolean;
    }[] = [];
    let requiredFieldCount = 0;
    for (const control of candidates) {
      const label = labels(control);
      const automationId = control.getAttribute("data-automation-id") ?? "";
      const placeholder = control.getAttribute("placeholder") ?? "";
      const type = control instanceof HTMLInputElement ? control.type : "";
      const isRequired =
        control.hasAttribute("required") || control.getAttribute("aria-required") === "true" ||
        /\*/u.test(label);
      if (isRequired) requiredFieldCount += 1;
      let classifiedType: string;
      if (type === "file") {
        controlTypes.add("file_upload");
        answerTypes.add("file");
        classifiedType = "file_upload";
      } else if (type === "checkbox" || control.getAttribute("role") === "checkbox") {
        controlTypes.add("checkbox");
        answerTypes.add("boolean");
        classifiedType = "checkbox";
      } else if (control instanceof HTMLTextAreaElement) {
        controlTypes.add("textarea");
        answerTypes.add("text");
        classifiedType = "textarea";
      } else if (automationId === "dateSectionMonth-input") {
        controlTypes.add("month");
        answerTypes.add("month");
        classifiedType = "month";
      } else if (
        control instanceof HTMLInputElement && type === "text" &&
        (/YYYY/iu.test(placeholder) || /(?:^|--|[-_])(?:year|startDate|endDate|firstYear|lastYear)/iu.test(
          automationId,
        ) || /\b(?:Year|Actual or Expected)\b/iu.test(label))
      ) {
        controlTypes.add("year");
        answerTypes.add("year");
        classifiedType = "year";
      } else if (/Overall Result|GPA/iu.test(label) || type === "number") {
        controlTypes.add("number");
        answerTypes.add("number");
        classifiedType = "number";
      } else if (/LinkedIn|Social Network URL|Website/iu.test(label)) {
        controlTypes.add("text");
        answerTypes.add("url");
        classifiedType = "text_url";
      } else if (
        control.getAttribute("role") === "combobox" || automationId === "sourcePrompt" ||
        control.closest(
          '[data-automation-id="multiSelectContainer"], ' +
            '[data-automation-id="multiselectInputContainer"]',
        ) !== null
      ) {
        controlTypes.add("search_select");
        answerTypes.add("multi_select");
        classifiedType = "search_select";
      } else if (
        control instanceof HTMLSelectElement || control.hasAttribute("aria-haspopup")
      ) {
        controlTypes.add("select");
        answerTypes.add("single_select");
        classifiedType = "select";
      } else {
        controlTypes.add("text");
        answerTypes.add("text");
        classifiedType = "text";
      }
      const ownerAutomationIds: string[] = [];
      let owner = control.parentElement;
      while (owner !== null && ownerAutomationIds.length < 6) {
        const ownerAutomationId = owner.getAttribute("data-automation-id");
        if (ownerAutomationId !== null && ownerAutomationId !== "") {
          ownerAutomationIds.push(ownerAutomationId);
        }
        owner = owner.parentElement;
      }
      diagnostics.push({
        automationId,
        id: control.id,
        name: control.getAttribute("name") ?? "",
        placeholder,
        label: label.slice(0, 160),
        ownerAutomationIds,
        tag: control.tagName.toLowerCase(),
        inputType: type,
        role: control.getAttribute("role") ?? "",
        classifiedType,
        required: isRequired,
      });
    }
    const rootText = normalize(root.textContent);
    const questionTypes = [
      [/Work Experience/iu, "employment"],
      [/Education/iu, "education"],
      [/Languages/iu, "language"],
      [/Skills/iu, "skill"],
      [/Resume\s*\/\s*CV/iu, "attachment"],
      [/Websites/iu, "website"],
      [/Social Network URLs/iu, "social_network"],
    ].flatMap(([pattern, category]) =>
      (pattern as RegExp).test(rootText) ? [category as string] : []
    );
    const repeatableActions = [...root.querySelectorAll<HTMLElement>("button")].filter((button) =>
      visible(button) && /^(?:Add Another|Add)$/iu.test(normalize(button.textContent))
    );
    if (repeatableActions.length > 0) controlTypes.add("repeatable");
    return {
      fieldCount: candidates.length,
      requiredFieldCount,
      controlTypes: [...controlTypes],
      questionTypes,
      answerTypes: [...answerTypes],
      diagnostics,
    };
  });
  let result = await read();
  // Workday can finish painting the full Experience page one render pass
  // before every below-the-fold Education control is discoverable. Sample a
  // short bounded window and retain one whole, maximal structural snapshot;
  // never merge counts or types from different DOM states.
  for (let sample = 1; sample < 4; sample += 1) {
    await page.waitForTimeout(250);
    const candidate = await read();
    if (
      candidate !== null &&
      (result === null || candidate.fieldCount > result.fieldCount ||
        (candidate.fieldCount === result.fieldCount &&
          candidate.requiredFieldCount > result.requiredFieldCount))
    ) result = candidate;
  }
  if (
    result === null || result.fieldCount < 1 || result.requiredFieldCount < 1 ||
    result.requiredFieldCount > result.fieldCount || result.controlTypes.length < 1 ||
    result.questionTypes.length < 1 || result.answerTypes.length < 1
  ) throw new TypeError("application monitor taxonomy denied");
  if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
    try {
      process.stderr.write(`${JSON.stringify({
        applicationExperienceTaxonomyDiagnostics: result.diagnostics,
      })}\n`);
    } catch {}
  }
  return Object.freeze({
    fieldCount: result.fieldCount,
    requiredFieldCount: result.requiredFieldCount,
    controlTypes: Object.freeze(result.controlTypes),
    questionTypes: Object.freeze(result.questionTypes),
    answerTypes: Object.freeze(result.answerTypes),
  });
}

async function monitorQuestionTypes(
  page: Page,
  pageName: "resume" | "profile" | "questionnaire" | "review",
): Promise<readonly string[]> {
  if (pageName === "resume") return Object.freeze(["attachment"]);
  const observed = await page.evaluate(() => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
    const categories = new Set<string>();
    const controls = [...document.querySelectorAll<HTMLElement>(
      'fieldset, input:not([type="hidden"]), textarea, select, [role="combobox"], ' +
        'button[aria-haspopup="listbox"]',
    )];
    for (const control of controls) {
      if (control.getClientRects().length === 0) continue;
      const field = control.closest(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      );
      const nativeLabel = control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement
        ? control.labels?.[0]?.textContent
        : undefined;
      const ownerLabel = field?.querySelector("label, legend")?.textContent;
      const ownerQuestion = control instanceof HTMLInputElement && control.type === "checkbox"
        ? field?.textContent
        : undefined;
      const label = normalize(
        ownerQuestion !== undefined
          ? ownerQuestion
          : control.getAttribute("aria-haspopup") === "listbox"
          ? ownerLabel ?? control.getAttribute("aria-label")
          : control.getAttribute("aria-label") ?? ownerLabel ?? nativeLabel ??
            control.getAttribute("placeholder"),
      );
      if (/\b(?:race|ethnicity|gender|veteran|disability|demographic)\b/u.test(label)) categories.add("demographic");
      else if (/\b(?:authorized|authorization|sponsor|sponsorship|work permit)\b/u.test(label)) categories.add("authorization");
      else if (/\b(?:agree|consent|certify|terms|conditions|agreement|privacy)\b/u.test(label)) categories.add("legal");
      else if (/\b(?:salary|compensation|pay|rate)\b/u.test(label)) categories.add("compensation");
      else if (/\b(?:available|availability|start date|relocate|travel)\b/u.test(label)) categories.add("availability");
      else if (/\b(?:school|degree|education|university|college)\b/u.test(label)) categories.add("education");
      else if (/\b(?:employer|employment|employee|employed|worked|experience|job title|skill)\b/u.test(label)) categories.add("employment");
      else if (/\b(?:phone|email|address|city|state|province|country|postal|zip)\b/u.test(label)) categories.add("contact");
      else if (/\b(?:first name|last name|given name|family name|preferred name)\b/u.test(label)) categories.add("identity");
      else if (/\b(?:resume|cv|attachment|upload)\b/u.test(label)) categories.add("attachment");
      else if (/\b(?:describe|interest|cover letter|additional information)\b/u.test(label)) categories.add("narrative");
      else categories.add("unknown");
    }
    return [...categories].sort();
  });
  return Object.freeze(observed.length === 0 ? ["unknown"] : observed);
}

async function captureIndependentReviewFields(
  page: Page,
  expected: ReadonlyMap<string, ReviewExpectedField>,
): Promise<{
  readonly page: SemanticPageSnapshot;
  readonly verification: readonly { readonly kind: "verified"; readonly fieldId: FieldId }[];
}> {
  if (expected.size === 0 || expected.size > 128) throw new TypeError("Review fields unavailable");
  const rows = page.locator('[data-automation-id="applyFlowReviewPage"] [data-hunt-review-field-id]');
  const count = await rows.count();
  const seen = new Set<string>();
  if (count > 0) {
    if (count !== expected.size) throw new TypeError("Review fields incomplete or ambiguous");
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (!await row.isVisible()) throw new TypeError("Review field hidden");
      const id = await row.getAttribute("data-hunt-review-field-id");
      if (id === null) throw new TypeError("Review field identity unavailable");
      const value = normalizeReviewValue(await row.textContent() ?? "");
      verifyReviewBinding(expected.get(id), id, value, seen);
    }
  } else {
    const realRows = page.locator(
      '[data-automation-id="applyFlowReviewPage"] [data-automation-id^="formField-"]',
    );
    const realCount = await realRows.count();
    if (realCount !== expected.size) throw new TypeError("Review rows incomplete or ambiguous");
    const byIdentity = new Map([...expected.values()].map((fact) => [fact.rowIdentity, fact]));
    if (byIdentity.size !== expected.size) throw new TypeError("Review identities ambiguous");
    for (let index = 0; index < realCount; index += 1) {
      const row = realRows.nth(index);
      if (!await row.isVisible()) throw new TypeError("Review field hidden");
      const identity = await row.getAttribute("data-automation-id");
      if (identity === null || !isStableRowIdentity(identity)) {
        throw new TypeError("Review field identity unavailable");
      }
      const fact = byIdentity.get(identity);
      if (fact === undefined) throw new TypeError("Unknown Review row identity");
      const values = await row.evaluate((root) => {
        const leaves = [...root.querySelectorAll<HTMLElement>("*")]
          .filter((element) => element.children.length === 0)
          .map((element) => element.textContent ?? "");
        return leaves.length === 0 ? [root.textContent ?? ""] : leaves;
      });
      const matches = values.map(normalizeReviewValue).filter((value) =>
        value !== "" && createHash("sha256").update(value, "utf8").digest("hex") === fact.valueSha256
      );
      if (matches.length !== 1) throw new TypeError("Review field mismatch");
      verifyReviewBinding(fact, fact.fieldId, matches[0]!, seen);
    }
  }
  if (seen.size !== expected.size) throw new TypeError("Review fields incomplete");
  const ids = [...expected.keys()].sort();
  const fields = ids.map((id, index) => Object.freeze({
    fieldId: fieldId(id),
    target: browserTargetToken(`review-verified-${index}`),
    label: boundedText(`Verified Review field ${index + 1}`),
    required: true,
    behavior: "text" as const,
    options: Object.freeze([]),
    state: "populated" as const,
  }));
  return Object.freeze({
    page: Object.freeze({
      pageIdentity: Object.freeze({ kind: "workday" as const, page: "review" as const }),
      fields: Object.freeze(fields),
    }),
    verification: Object.freeze(fields.map(({ fieldId: verifiedFieldId }) => Object.freeze({
      kind: "verified" as const,
      fieldId: verifiedFieldId,
    }))),
  });
}

function verifyReviewBinding(
  fact: ReviewExpectedField | undefined,
  id: string,
  value: string,
  seen: Set<string>,
): void {
  if (fact === undefined || fact.fieldId !== id || seen.has(id) || value === "" ||
      fact.provenance.length === 0 || !isStableRowIdentity(fact.rowIdentity) ||
      createHash("sha256").update(value, "utf8").digest("hex") !== fact.valueSha256) {
    throw new TypeError("Review field mismatch");
  }
  seen.add(id);
}

export function isReviewExpectedField(value: unknown): value is ReviewExpectedField {
  if (typeof value !== "object" || value === null) return false;
  const field = value as Partial<ReviewExpectedField>;
  return Object.keys(value).sort().join("|") ===
      ["fieldId", "provenance", "rowIdentity", "valueSha256"].sort().join("|") &&
    typeof field.fieldId === "string" && isAcceptedFieldId(field.fieldId) &&
    typeof field.provenance === "string" && new Set([
      "owner_provided", "resume_verified", "configured_template", "generated_default",
      "journey_derived", "reviewed_catalog", "visible_option",
    ]).has(field.provenance) &&
    field.rowIdentity === `formField-${field.fieldId}` && isStableRowIdentity(field.rowIdentity) &&
    typeof field.valueSha256 === "string" && /^[0-9a-f]{64}$/u.test(field.valueSha256);
}

function isStableRowIdentity(value: string): boolean {
  const prefix = "formField-";
  return value.startsWith(prefix) && isAcceptedFieldId(value.slice(prefix.length));
}

function isAcceptedFieldId(value: string): boolean {
  return /^[a-z][a-z0-9._-]{0,127}$/u.test(value);
}

async function captureReviewStructure(page: Page): Promise<WorkdayReviewStructuralObservationV1> {
  const root = page.locator(workdayReviewSignatures.reviewRoot);
  const active = page.locator(workdayReviewSignatures.activeStep);
  const errors = page.locator(workdayReviewSignatures.validationError);
  const submit = root.getByRole("button", { name: workdayReviewSignatures.finalSubmitName });
  const [rootCount, activeCount, errorCount, submitCount] = await Promise.all([
    root.count(), active.count(), errors.count(), submit.count(),
  ]);
  if ([rootCount, activeCount, errorCount, submitCount].some((value) =>
    !Number.isInteger(value) || value < 0 || value > 64
  )) throw new TypeError("Review structure denied");
  return Object.freeze({
    schemaVersion: 1,
    reviewRoot: Object.freeze({ count: rootCount, visible: rootCount === 1 && await root.isVisible() }),
    activeStep: Object.freeze({ count: activeCount, visible: activeCount === 1 && await active.isVisible() }),
    validationErrorCount: errorCount,
    finalSubmit: Object.freeze({
      count: submitCount,
      visible: submitCount === 1 && await submit.isVisible(),
      enabled: submitCount === 1 && await submit.isEnabled(),
    }),
  });
}

function verified<
  PageKind extends "resume" | "profile" | "questionnaire",
  Checkpoint extends PageKind extends "resume"
    ? "resume_verified"
    : PageKind extends "profile"
      ? "profile_verified"
      : "questionnaire_verified",
>(page: PageKind, checkpoint: Checkpoint, pageId: BrowserPageId) {
  return { ok: true as const, value: { page, checkpoint, pageId, independentlyVerified: true as const } };
}

function applicationFailure(
  code: string,
  primitive: ApplicationPortFailure["primitive"],
  unknownLayer: ApplicationPortFailure["unknownLayer"],
  placeholder?: Readonly<{
    protectedPlaceholderCount: 0 | 1;
    placeholderProvenance: "synthetic_ui_learning";
  }>,
) {
  const stable = Object.hasOwn(s2StableErrorPolicy, code) ? code : "page_incomplete";
  return {
    ok: false as const,
    error: {
      code: stable as ApplicationPortFailure["code"],
      classifier: primitive === "next" ? "page_navigation" as const :
        primitive === "profile_control" ? "profile_page" as const :
          primitive === "question_control" ? "questionnaire_page" as const :
            primitive === "file_upload" ? "resume_page" as const : "workday_page" as const,
      primitive,
      unknownLayer,
      ...(placeholder ?? {}),
    },
  };
}

function playwrightPage(page: PersistentPage): Page {
  if (!("locator" in page) || !("evaluate" in page) || !("reload" in page)) {
    throw new TypeError("Playwright page capability unavailable");
  }
  return page as Page;
}

export async function bindQuestionnaireTargets(
  page: Page,
  pageId: BrowserPageId,
): Promise<void> {
  const result = await page.evaluate(({ declaredPageId, selectors }) => {
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element.hidden ||
          element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" &&
        style.visibility !== "collapse" && element.getClientRects().length > 0;
    };
    const roots = [
      selectors.primaryQuestions,
      selectors.primaryQuestionnaire,
      selectors.applicationQuestions,
      selectors.voluntaryDisclosuresAndSelfIdentify,
    ].flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
      .filter(visible);
    if (roots.length !== 1) return false;
    document.documentElement.setAttribute("data-hunt-page-id", declaredPageId);
    const controls = roots[0]!.querySelectorAll<HTMLElement>(
      'fieldset, input:not([type="hidden"]), textarea, select, [role="listbox"], button',
    );
    const identities = new Map<string, number>();
    const hash = (value: string) => {
      let state = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        state ^= value.charCodeAt(index);
        state = Math.imul(state, 16777619);
      }
      return (state >>> 0).toString(16).padStart(8, "0");
    };
    let index = 0;
    for (const control of controls) {
      if (control instanceof HTMLInputElement && control.type === "radio" &&
          control.closest("fieldset") !== null) continue;
      const normalize = (value: string | null | undefined) =>
        (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
      const field = control.closest(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      );
      let label = control instanceof HTMLInputElement && control.type === "checkbox"
        ? normalize(field?.textContent)
        : control.getAttribute("aria-haspopup") === "listbox"
        ? normalize(field?.querySelector("label, legend")?.textContent)
        : "";
      if (label === "") label = normalize(control.getAttribute("aria-label"));
      if (label === "" && control instanceof HTMLFieldSetElement) {
        label = normalize(control.querySelector(":scope > legend")?.textContent);
      }
      if (label === "" && (control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) {
        label = normalize(control.labels?.[0]?.textContent);
      }
      if (label === "") label = normalize(control.getAttribute("placeholder"));
      const reviewed: Record<string, string> = {
        "Given name": "target-s1-field-given-name",
        "Family name": "target-s1-field-family-name",
        "Phone number": "target-s1-field-phone-number",
        "Brief interest statement": "target-s1-field-interest",
        "Are you authorized to work in this location?": "target-s1-field-work-authorization",
        "I am at least 18 years of age.": "target-s1-field-age-requirement",
        "Will you require sponsorship?": "target-s1-field-sponsorship",
        "Country": "target-s1-field-country",
        "Available start date": "target-s1-field-start-date",
      };
      const identity = [
        label,
        control.tagName,
        control.getAttribute("type") ?? "",
        control.getAttribute("role") ?? "",
        control.getAttribute("data-automation-id") ?? "",
        control.id,
        control.getAttribute("name") ?? "",
      ].join("\u0000");
      const identityHash = hash(identity);
      const occurrence = (identities.get(identityHash) ?? 0) + 1;
      identities.set(identityHash, occurrence);
      control.setAttribute(
        "data-hunt-target-token",
        reviewed[label] ?? `target-workday-${identityHash}-${occurrence}`,
      );
      index += 1;
    }
    return index <= 128;
  }, { declaredPageId: pageId, selectors: WORKDAY_APPLICATION_PAGE_SELECTORS });
  if (!result) throw new TypeError("questionnaire control binding denied");
}

function structuralObservations(
  fields: readonly { readonly fieldId: FieldId; readonly required: boolean; readonly options: readonly unknown[] }[],
): ReadonlyMap<string, SanitizedStructuralObservationV1> {
  const values = new Map<string, SanitizedStructuralObservationV1>();
  for (const [index, field] of fields.entries()) {
    const ordinal = index.toString().padStart(8, "0");
    const lineage = Object.freeze([
      Object.freeze({
        layer: "ats_family" as const,
        classificationId: "classification_live_workday_ats_v1" as never,
      }),
      Object.freeze({
        layer: "workday_page_type" as const,
        classificationId: "classification_live_questionnaire_v1" as never,
      }),
      Object.freeze({
        layer: "ui_behavior" as const,
        classificationId: `classification_runtime_ui_${ordinal}` as never,
      }),
      Object.freeze({
        layer: "question" as const,
        classificationId: `classification_runtime_question_${ordinal}` as never,
      }),
      Object.freeze({
        layer: "answer_type" as const,
        classificationId: `classification_runtime_answer_${ordinal}` as never,
      }),
    ]);
    for (const layer of ["question", "visible_option"] as const) {
      values.set(`${field.fieldId}:${layer}`, Object.freeze({
        schemaVersion: 1,
        observationId: `structural_observation_${ordinal}_${layer}` as never,
        layer,
        sourceRevisionId: "classification_revision_workday_entry_v1" as never,
        parentLineage: layer === "question"
          ? Object.freeze(lineage.slice(0, 3))
          : lineage,
        traitIds: Object.freeze([
          "structural_trait_page_questionnaire_v1" as never,
          `structural_trait_field_required_${field.required ? "yes" : "no"}_v1` as never,
        ]),
        observedVariantId: null,
        controlCount: 1,
        requiredControlCount: field.required ? 1 : 0,
        optionCount: field.options.length,
      }));
    }
  }
  return values;
}
