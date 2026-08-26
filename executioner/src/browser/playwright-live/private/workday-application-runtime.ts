import { createHash, randomBytes } from "node:crypto";

import type { Page } from "playwright";

import type { ApplicationLaneAcceptance } from
  "../../../ats/workday/application/lane-composition.ts";
import { PlaywrightWorkdayApplicationPage } from
  "../../../ats/workday/application/playwright-page.ts";
import {
  completeWorkdayProfilePage,
  PlaywrightWorkdayProfilePage,
  profileInspectionTraceDetails,
  type ProfileCleanupState,
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
  type ApplicationPageTruth,
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
  type FieldIntent,
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
import { answerLaneAdmitted } from "../../../form/answers/application-types.ts";
import { discoverFields } from "../../../form/discovery/discover-fields.ts";
import { createSemanticSnapshot } from "../../../form/semantic-snapshot.ts";
import { createFieldDriver } from "../../../interaction/drivers/registry.ts";
import {
  workdayReviewSignatures,
  type WorkdayReviewStructuralObservationV1,
} from "../../../interaction/review/index.ts";
import { createFieldVerifier, fieldIntentMatchesReadback } from
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
  ['[data-automation-id="applyFlowSelfIdentifyPage"]:visible', "Self Identify"],
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
  '[data-automation-id="applyFlowSelfIdentifyPage"] h1:visible',
  '[data-automation-id="applyFlowSelfIdentifyPage"] h2:visible',
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
        name: /^(?:Save and Continue|Next)$/iu,
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
  const observed = await waitForApplicationReadyPage(page);
  return profileMonitorTaxonomyFromSnapshot(page as unknown as Page, observed);
}

async function settledProfileMonitorTaxonomy(
  page: Page,
): Promise<import("./external-monitor-port.ts").ExternalMonitorTaxonomy> {
  const observed = await new PlaywrightWorkdayProfilePage(page, {
    pageType: "profile",
  }).inspect(AbortSignal.any([]));
  return profileMonitorTaxonomyFromSnapshot(page, observed);
}

async function profileMonitorTaxonomyFromSnapshot(
  owned: Page,
  observed: ProfilePageSnapshot,
): Promise<import("./external-monitor-port.ts").ExternalMonitorTaxonomy> {
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
  readonly #verifiedQuestionnaireIntents = new Map<string, string>();
  #profileMutationAttempted = false;
  #profileCleanupState: ProfileCleanupState = "not_started";
  #profilePreservationCandidate = false;

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
    this.#profileCleanupState = "started";
    this.#profilePreservationCandidate = false;
    this.#request = undefined;
    this.#session = undefined;
    this.#reviewExpected.clear();
    this.#verifiedQuestionnaireIntents.clear();
  }

  profilePreservationSnapshot(): {
    readonly mutationAttempted: boolean;
    readonly cleanupState: ProfileCleanupState;
    readonly candidate: boolean;
  } {
    return Object.freeze({
      mutationAttempted: this.#profileMutationAttempted,
      cleanupState: this.#profileCleanupState,
      candidate: this.#profilePreservationCandidate,
    });
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
        const navigationSource = await new PlaywrightWorkdayApplicationPage(
          page,
          { timeoutMs: this.#timeoutMs },
        ).observe(signal);
        if (
          !navigationSource.ok || navigationSource.value.page !== input.from ||
          navigationSource.value.pageId !== input.fromPageId ||
          navigationSource.value.submitActivated ||
          navigationSource.value.requiredFields.some(({ verification }) =>
            verification !== "verified"
          )
        ) throw new TypeError("application navigation source denied");
        const advanced = await new PlaywrightWorkdayApplicationPage(page, {
          timeoutMs: this.#timeoutMs,
          navigationSettleTimeoutMs: Math.max(this.#timeoutMs, 90_000),
        }).next(
          input, signal,
        );
        if (advanced.ok) {
          // Workday can expose the persisted destination and then remount its
          // owned loading shell. Stabilize that known state before publishing
          // transition evidence; this recovery performs at most one reload.
          let observed = await waitForApplicationObservation(
            page,
            Math.max(this.#timeoutMs, 30_000),
            signal,
            0,
          );
          const stabilizeEmptyDestination = async (): Promise<void> => {
            if (
              !observed.ok || observed.value.page === "pre_review" ||
              observed.value.requiredFields.length !== 0
            ) return;
            this.#assertAuthorized(signal);
            if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
              process.stderr.write(
                '{"applicationStateRecovery":"empty_destination_settle_started"}\n',
              );
            }
            // The empty destination is a client-side preview while Workday's
            // save request is still in flight. Continuously watch through the
            // delayed loading remount, then give that request its full bounded
            // window before the observer's single owned-shell reload.
            observed = await waitThroughApplicationDestinationSettle(
              page,
              Math.max(this.#timeoutMs, 90_000),
              signal,
            );
            if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
              process.stderr.write(
                '{"applicationStateRecovery":"empty_destination_settle_completed"}\n',
              );
            }
          };
          await stabilizeEmptyDestination();
          if (
            observed.ok &&
            isReturnedNavigationSource(observed.value, navigationSource.value)
          ) {
            observed = await waitForExactApplicationSource(
              page,
              navigationSource.value,
              Math.max(this.#timeoutMs, 30_000),
              signal,
            );
            if (
              !observed.ok ||
              !isExactVerifiedApplicationSource(observed.value, navigationSource.value)
            ) throw new TypeError("application navigation source recovery denied");
            if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
              process.stderr.write(
                '{"applicationStateRecovery":"returned_source_retry_started"}\n',
              );
            }
            const retried = await new PlaywrightWorkdayApplicationPage(page, {
              timeoutMs: this.#timeoutMs,
              navigationSettleTimeoutMs: Math.max(this.#timeoutMs, 90_000),
            }).next(input, signal);
            if (!retried.ok) return retried;
            observed = await waitForApplicationObservation(
              page,
              Math.max(this.#timeoutMs, 30_000),
              signal,
              0,
            );
            await stabilizeEmptyDestination();
          }
          if (
            !observed.ok || !input.allowed.includes(observed.value.page) ||
            isReturnedNavigationSource(observed.value, navigationSource.value)
          ) {
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
          // The independent transition observation can overlap Workday's
          // delayed client-side remount. Carry a settled, authorized
          // destination back to the page walk so it does not immediately
          // re-observe that temporary loading shell and discard a proven
          // navigation.
          observed = await waitForApplicationObservation(
            page,
            Math.max(this.#timeoutMs, 30_000),
            signal,
            0,
          );
          if (
            !observed.ok || !input.allowed.includes(observed.value.page) ||
            isReturnedNavigationSource(observed.value, navigationSource.value)
          ) {
            throw new TypeError("application post-monitor destination denied");
          }
          this.#assertAuthorized(signal);
          return {
            ok: true,
            value: { advanced: true, destination: observed.value },
          };
        }
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
        this.#assertAuthorized(signal);
        let mutationAttempted = false;
        this.#profileMutationAttempted = false;
        this.#profileCleanupState = "not_started";
        this.#profilePreservationCandidate = false;
        let learning: ReturnType<typeof createProfileFieldLearningCapture> | undefined;
        const observationOperationId = this.#nextOperationId();
        const observationAttempt = this.#nextObservationMonitorAttempt(
          monitorPageName,
          "state_observed",
        );
        await this.#monitor(
          page, monitorPageName, "state_observed",
          observationOperationId, observationAttempt, signal,
        );
        this.#assertAuthorizationTime();
        const mutationOperationId = this.#nextOperationId();
        const mutationAttempt = this.#nextMutationMonitorAttempt(monitorPageName);
        let mutationMonitorStarted = false;
        const startMutationMonitor = async (innerSignal: AbortSignal) => {
          if (mutationMonitorStarted) return;
          await this.#monitor(
            page, monitorPageName, "before_mutation",
            mutationOperationId, mutationAttempt, innerSignal,
          );
          mutationMonitorStarted = true;
          this.#assertAuthorized(innerSignal);
        };
        const playwrightProfilePage = new PlaywrightWorkdayProfilePage(page, {
          pageType: request.ownerSources.profilePlan.pageType,
          timeoutMs: this.#timeoutMs,
        });
        const profilePage: WorkdayProfilePagePort = {
          inspect: (innerSignal) => playwrightProfilePage.inspect(innerSignal),
          inspectionFailure: () => playwrightProfilePage.inspectionFailure(),
          inspectionFacts: () => playwrightProfilePage.inspectionFacts(),
          commit: async (commit, innerSignal) => {
            await startMutationMonitor(innerSignal);
            mutationAttempted = true;
            this.#profileMutationAttempted = true;
            this.#assertAuthorized(innerSignal);
            return playwrightProfilePage.commit(commit, innerSignal);
          },
          addOwnedRow: async (section, innerSignal) => {
            await startMutationMonitor(innerSignal);
            mutationAttempted = true;
            this.#profileMutationAttempted = true;
            this.#assertAuthorized(innerSignal);
            return playwrightProfilePage.addOwnedRow(section, innerSignal);
          },
          removeOwnedRow: async (section, rowId, innerSignal) => {
            await startMutationMonitor(innerSignal);
            mutationAttempted = true;
            this.#profileMutationAttempted = true;
            this.#assertAuthorized(innerSignal);
            return playwrightProfilePage.removeOwnedRow(section, rowId, innerSignal);
          },
          interaction: (controlId) => playwrightProfilePage.interaction(controlId),
        };
        const interactivelyInspectableFields = new Set([
          ...request.ownerSources.profilePlan.fields,
          ...request.ownerSources.profilePlan.repeatables.flatMap(({ rows }) =>
            rows.flatMap(({ fields }) => fields)
          ),
        ]
          .filter(({ answer }) => answer.kind === "answered" && answerLaneAdmitted(
            request.ownerSources.profilePlan.mode,
            answer.lane,
          ))
          .map(({ fieldId }) => fieldId));
        learning = createProfileFieldLearningCapture({
          page: profilePage,
          plan: request.ownerSources.profilePlan,
          root: request.owner?.roots?.evidence?.path,
          fileName: monitorPageName === "profile"
            ? "profile-field-learning.json"
            : "profile-field-learning-02.json",
          sensitiveValues: request.ownerSources.sensitiveValues,
          ...(this.#externalMonitor === undefined ? {} : {
            observeControl: async (control, innerSignal) => {
              const observation = await playwrightProfilePage.observeControl(
                control.controlId,
                innerSignal,
                !control.required || interactivelyInspectableFields.has(control.fieldId),
              );
              return Object.freeze({
                observation,
                binding: Object.freeze({
                  operationId: observationOperationId,
                  attempt: observationAttempt,
                  stateObservedAck: true as const,
                }),
              });
            },
          }),
        });
        let learningSha256: string | null = null;
        let result;
        let reconciliationError: unknown;
        try {
          result = await completeWorkdayProfilePage(
            request.ownerSources.profilePlan,
            learning.page,
            signal,
          );
        } catch (error) {
          reconciliationError = error;
          throw error;
        } finally {
          try {
            if (mutationMonitorStarted) {
              await this.#monitor(
                page, monitorPageName, "after_readback",
                mutationOperationId, mutationAttempt, signal,
              );
              if (this.#externalMonitor !== undefined) {
                learning.bindMutationBatch({
                  operationId: mutationOperationId,
                  attempt: mutationAttempt,
                });
              }
            }
          } catch (error) {
            if (reconciliationError === undefined) throw error;
          }
          learningSha256 = learning.write();
        }
        if (result.kind !== "verified" || result.ownedDuplicateRows !== 0) {
          this.#profilePreservationCandidate = result.kind === "blocked" &&
            (result.code === "profile_port_unavailable" ||
              result.code === "profile_metadata_reconciliation_failed") && !mutationAttempted;
          if (result.kind === "blocked") {
            try {
              const metadata = result.metadataReconciliationFailure;
              this.#trace?.("profile_reconciliation_blocked", {
                pageId: input.pageId,
                code: result.code,
                ...(result.learningConversion === undefined ? {} : {
                  learningConversion: result.learningConversion.kind,
                  executionMode: result.learningConversion.executionMode,
                  testOnly: result.learningConversion.testOnly,
                  mutationAllowed: result.learningConversion.mutationAllowed,
                  defaultsGenerated: result.learningConversion.defaultsGenerated,
                  learningFieldIds: result.learningConversion.fieldIds,
                  learningFieldReasons: result.learningConversion.affected.flatMap(({ fieldId, reasons }) =>
                    reasons.map((reason) => `${fieldId}.${reason}`)
                  ),
                }),
                ...(metadata === undefined ? {} : {
                  profileMetadataMismatchCount: metadata.mismatches.length,
                  profileMetadataMismatchFields: metadata.mismatches.map(({ fieldId }) => fieldId),
                  profileMetadataMismatchReasons: metadata.mismatches.flatMap(({ fieldId, reasons }) =>
                    reasons.map((reason) => `${fieldId}.${reason}`)
                  ),
                }),
                ...(result.fieldId === undefined ? {} : { fieldId: result.fieldId }),
                ...(result.uiBehavior === undefined ? {} : { uiBehavior: result.uiBehavior }),
                ...(result.uiVariant === undefined ? {} : { uiVariant: result.uiVariant }),
                ...(result.profileInspectionDiagnostic === undefined
                  ? {}
                  : profileInspectionTraceDetails(result.profileInspectionDiagnostic, {
                    sessionState: this.#session === undefined ? "unknown" : "bound",
                    cleanupState: this.#profileCleanupState,
                    preservationEligible: false,
                    preservationReason: mutationAttempted
                      ? "mutation_attempted"
                      : "session_validation_required",
                    continueAllowed: false,
                  })),
                mutationAttempted,
                retryable: false,
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
                  result.code === "profile_answer_missing" ||
                  result.code === "profile_answer_provenance_denied"
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
    if (moment === "transition") {
      const observed = await waitForApplicationObservation(
        page,
        Math.max(this.#timeoutMs, 30_000),
        signal,
        0,
      );
      if (
        !observed.ok || observed.value.submitActivated ||
        monitorPage(observed.value.page) !== pageName
      ) throw new TypeError("application transition monitor state denied");
      applicationMonitorDiagnostic("transition_guard_succeeded");
    }
    applicationMonitorDiagnostic("taxonomy_started", moment);
    const taxonomy = await monitorTaxonomy(page, pageName);
    applicationMonitorDiagnostic("taxonomy_succeeded", moment);
    await this.#externalMonitor.application(
      applicationMonitorPage(page, pageName),
      pageName,
      moment,
      taxonomy,
      { operationId, attempt },
      signal,
    );
    applicationMonitorDiagnostic("external_monitor_succeeded", moment);
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

  #assertAuthorizationTime(): void {
    const now = this.#now();
    if (!/^\d{4}-\d{2}-\d{2}T/u.test(now) || !Number.isFinite(Date.parse(now)) ||
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
    const batchOperationId = this.#nextOperationId();
    const batchAttempt = this.#nextMutationMonitorAttempt(monitorPageName);
    await this.#monitor(
      page, monitorPageName, "before_mutation", batchOperationId, batchAttempt, signal,
    );
    if (this.#externalMonitor !== undefined) {
      request.questionLearning?.monitorBatchAck({
        operationId: batchOperationId,
        attempt: batchAttempt,
        moment: "before_mutation",
      });
    }
    let batchClosed = false;
    const closeBatch = async () => {
      if (batchClosed) return;
      await this.#monitor(
        page, monitorPageName, "after_readback", batchOperationId, batchAttempt, signal,
      );
      if (this.#externalMonitor !== undefined) {
        request.questionLearning?.monitorBatchAck({
          operationId: batchOperationId,
          attempt: batchAttempt,
          moment: "after_readback",
        });
      }
      batchClosed = true;
      this.#assertAuthorized(signal);
    };
    await bindQuestionnaireTargets(page, input.pageId);
    for (const targetToken of await questionnairePopupHydrationTargets(page)) {
      this.#assertAuthorized(signal);
      await hydrateQuestionnairePopupOptions(page, input.pageId, targetToken, this.#timeoutMs);
    }
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
      this.#trace?.("questionnaire_coverage_observed", {
        semanticFields: visibleFields.length,
        semanticRequired: requiredFieldCount,
        applicationFields: application.ok ? application.value.requiredFields.length : -1,
        taxonomyFields: taxonomy.fieldCount,
        taxonomyRequired: taxonomy.requiredFieldCount,
      });
      if (
        visibleFields.length === 0 ||
        !application.ok || application.value.page !== "questionnaire" ||
        application.value.requiredFields.length !== requiredFieldCount ||
        taxonomy.fieldCount !== visibleFields.length ||
        taxonomy.requiredFieldCount !== requiredFieldCount
      ) throw new TypeError(`questionnaire field coverage mismatch:${JSON.stringify({
        semanticFields: visibleFields.length,
        semanticRequired: requiredFieldCount,
        applicationFields: application.ok ? application.value.requiredFields.length : -1,
        taxonomyFields: taxonomy.fieldCount,
        taxonomyRequired: taxonomy.requiredFieldCount,
      })}`);
      const facts = structuralObservations(snapshot.fields);
      const currentReadbacks = new Map(
        observed.value.targets.map(({ token, readback }) => [token, readback]),
      );
      const semanticDriver = createFieldDriver(semantic, createSafetyGuard());
      const semanticVerifier = createFieldVerifier(semantic);
      const driver: FieldDriver = Object.freeze({
        drive: async (
          driveRequest: Parameters<FieldDriver["drive"]>[0],
          innerSignal: AbortSignal,
        ) => {
          this.#trace?.("questionnaire_field_drive_started", {
            fieldId: driveRequest.intent.fieldId,
            kind: driveRequest.intent.kind,
            uiBehavior: driveRequest.intent.behavior,
          });
          this.#assertAuthorized(innerSignal);
          const driven = await semanticDriver.drive(driveRequest, innerSignal);
          this.#trace?.("questionnaire_field_drive_completed", {
            fieldId: driveRequest.intent.fieldId,
            kind: driveRequest.intent.kind,
            uiBehavior: driveRequest.intent.behavior,
            status: driven.ok ? "succeeded" : "failed",
            ...(!driven.ok ? { code: driven.error.code } : {}),
          });
          return driven;
        },
      });
      const verifier: FieldVerifier = Object.freeze({
        verify: async (
          verificationRequest: Parameters<FieldVerifier["verify"]>[0],
          innerSignal: AbortSignal,
        ) => {
          // Workday may replace a control (or the entire questionnaire root)
          // after blur/selection. Restore the deterministic semantic bindings
          // before the independent readback so the original intent can still
          // be verified against the newly rendered control.
          await bindQuestionnaireTargets(page, input.pageId);
          const verified = await semanticVerifier.verify(verificationRequest, innerSignal);
          this.#trace?.("questionnaire_field_verification_completed", {
            fieldId: verificationRequest.intent.fieldId,
            kind: verified.ok ? verified.value.kind : "failed",
            uiBehavior: verificationRequest.intent.behavior,
            status: verified.ok && verified.value.kind === "verified" ? "succeeded" : "failed",
            ...(!verified.ok ? { code: verified.error.code } : {}),
          });
          this.#assertAuthorized(innerSignal);
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
        previouslyVerified: ({ pageId, field, intent }) => {
          const reusable = this.#verifiedQuestionnaireIntents.get(
            questionnaireIntentKey(pageId, field.fieldId),
          ) === questionnaireIntentFingerprint(intent) &&
            fieldIntentMatchesReadback(
              intent,
              currentReadbacks.get(field.target) ?? { kind: "unavailable" },
            );
          if (reusable) this.#trace?.("questionnaire_field_verified_reused", {
            fieldId: field.fieldId,
          });
          return reusable;
        },
        recordVerified: ({ pageId, field, intent }) => {
          this.#verifiedQuestionnaireIntents.set(
            questionnaireIntentKey(pageId, field.fieldId),
            questionnaireIntentFingerprint(intent),
          );
        },
        recordAttempt: questionLearning?.recordAttempt,
        recordAnswer: questionLearning?.record,
        recordUnset: questionLearning?.recordUnset,
        recordFailure: questionLearning?.recordFailure,
      });
      let completed: Awaited<ReturnType<typeof questionnaire.complete>>;
      try {
        completed = await questionnaire.complete({
          mode: request.ownerSources.profilePlan?.mode ?? "live",
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
        await closeBatch();
      } catch (error) {
        await closeBatch();
        const learningSha256 = questionLearning?.write() ?? null;
        this.#trace?.("questionnaire_reconciliation_exception", {
          learningPresent: learningSha256 !== null,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        throw error;
      }
      if (!completed.ok && new Set([
        "browser_effect_uncertain", "browser_session_invalidated", "browser_target_stale",
      ]).has(completed.error.code)) {
        const learningSha256 = questionLearning?.write() ?? null;
        this.#trace?.("questionnaire_reconciliation_uncertain", {
          code: completed.error.code,
          learningPresent: learningSha256 !== null,
        });
        throw new TypeError("questionnaire browser effect uncertain");
      }
      if (!completed.ok) {
        questionLearning?.write();
        this.#trace?.("questionnaire_date_diagnostics", await dateFailureDiagnostics(page));
        this.#trace?.("questionnaire_checkbox_diagnostics", await checkboxFailureDiagnostics(page));
        this.#trace?.("questionnaire_reconciliation_failed", {
          code: completed.error.code,
        });
        return applicationFailure("page_incomplete", "question_control", "question");
      }
      if (completed.value.kind === "blocked") {
        questionLearning?.write();
        this.#trace?.("questionnaire_date_diagnostics", await dateFailureDiagnostics(page));
        this.#trace?.("questionnaire_checkbox_diagnostics", await checkboxFailureDiagnostics(page));
        this.#trace?.("questionnaire_reconciliation_blocked", {
          pageId: input.pageId,
          fieldId: completed.value.fieldId,
          code: completed.value.code,
          protectedCategory: completed.value.protectedCategory,
          candidatePresent: completed.value.candidate !== undefined,
          retryable: false,
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
      // The independent monitor can blur the last control and Workday can then
      // remount the questionnaire root. Rebind the stable, value-free target
      // identities before the final review-expectation readback just as the
      // per-field verifier does above.
      await bindQuestionnaireTargets(page, input.pageId);
      const after = await semantic.observe({ sessionId: semanticSessionId, pageId: input.pageId }, signal);
      if (!after.ok) throw new TypeError("questionnaire review truth unavailable");
      const targets = new Map(after.value.targets.map((target) => [target.token, target]));
      for (const answer of completed.value.answers) {
        const field = snapshot.fields.find(({ fieldId }) => fieldId === answer.fieldId);
        if (field !== undefined && /^Language(?:\s*\*)?$/u.test(
          normalizeReviewValue(field.label),
        )) continue;
        const target = field === undefined ? undefined : targets.get(field.target);
        const value = target === undefined ? undefined : reviewReadbackValue(target.readback);
        if (value === undefined) throw new TypeError("questionnaire review truth unavailable");
        this.#recordReviewExpectation(answer.fieldId, answer.provenance, value);
      }
      return verified("questionnaire", "questionnaire_verified", input.pageId);
    } finally {
      await closeBatch();
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
      if (isWorkdayReviewOmittedProfileField(verifiedField.fieldId)) continue;
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
    const normalized = normalizeReviewExpectedValue(field, value);
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
  reloadDelayMs?: number,
) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  const reloadAt = startedAt + (reloadDelayMs ?? Math.min(30_000, Math.floor(timeoutMs / 2)));
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

async function waitForExactApplicationSource(
  page: Page,
  source: ApplicationPageTruth,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = await new PlaywrightWorkdayApplicationPage(page, { timeoutMs }).observe(signal);
  while (
    !signal.aborted && Date.now() < deadline &&
    (!latest.ok || !isExactVerifiedApplicationSource(latest.value, source))
  ) {
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
    latest = await new PlaywrightWorkdayApplicationPage(page, { timeoutMs }).observe(signal);
  }
  return latest;
}

export async function waitThroughApplicationDestinationSettle(
  page: Page,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const settleDeadline = Date.now() + Math.min(60_000, timeoutMs);
  let latest = await new PlaywrightWorkdayApplicationPage(page, { timeoutMs }).observe(signal);
  let stableSignature: string | undefined;
  let stableSince: number | undefined;
  while (!signal.aborted && Date.now() < settleDeadline) {
    if (!latest.ok) {
      return waitForApplicationObservation(page, timeoutMs, signal);
    }
    if (latest.value.page === "pre_review" || latest.value.requiredFields.length > 0) {
      return latest;
    }
    const signature = JSON.stringify({
      page: latest.value.page,
      pageId: latest.value.pageId,
      lanes: latest.value.lanes ?? [latest.value.page],
      duplicateRows: latest.value.c3OwnedDuplicateRows,
      submitActivated: latest.value.submitActivated,
    });
    if (signature !== stableSignature) {
      stableSignature = signature;
      stableSince = Date.now();
    } else if (stableSince !== undefined && Date.now() - stableSince >= 750) {
      return latest;
    }
    await page.waitForTimeout(Math.min(100, Math.max(1, settleDeadline - Date.now())));
    latest = await new PlaywrightWorkdayApplicationPage(page, { timeoutMs }).observe(signal);
  }
  return latest;
}

function isExactVerifiedApplicationSource(
  observed: ApplicationPageTruth,
  source: ApplicationPageTruth,
): boolean {
  if (
    observed.page !== source.page || observed.pageId !== source.pageId ||
    observed.submitActivated || observed.c3OwnedDuplicateRows !== 0 ||
    JSON.stringify(observed.lanes ?? [observed.page]) !==
      JSON.stringify(source.lanes ?? [source.page]) ||
    observed.requiredFields.some(({ verification }) => verification !== "verified")
  ) return false;
  const fieldKeys = (truth: ApplicationPageTruth) => truth.requiredFields
    .map(({ fieldId: id, page: lane }) => `${lane ?? ""}:${id}`)
    .sort();
  return JSON.stringify(fieldKeys(observed)) === JSON.stringify(fieldKeys(source));
}

function reviewReadbackValue(readback: BrowserReadback): string | undefined {
  if (readback.kind === "text") return readback.value;
  if (readback.kind === "selected") return readback.option ?? undefined;
  if (readback.kind === "checked") return readback.checked ? "Yes" : "No";
  return undefined;
}

function questionnaireIntentKey(pageId: BrowserPageId, questionFieldId: FieldId): string {
  return `${pageId}\0${questionFieldId}`;
}

function questionnaireIntentFingerprint(intent: FieldIntent): string {
  const desired = intent.kind === "text"
    ? intent.value
    : intent.kind === "choice"
      ? intent.expectedOption
      : intent.kind === "toggle"
        ? String(intent.checked)
        : intent.kind === "date"
          ? intent.isoDate
          : `${intent.artifact.resumeId}\0${intent.artifact.sha256}`;
  return createHash("sha256").update(
    `${intent.kind}\0${intent.behavior}\0${intent.provenance}\0${desired}`,
    "utf8",
  ).digest("hex");
}

function normalizeReviewValue(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function normalizeReviewExpectedValue(field: string, value: string): string {
  const normalized = normalizeReviewValue(value);
  if (field === "phone.number" || field === "phone.extension") {
    return normalized.replace(/\D/gu, "");
  }
  if (field === "social.linkedin") return canonicalReviewUrl(normalized);
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized);
  return isoDate === null ? normalized : `${isoDate[2]}/${isoDate[3]}/${isoDate[1]}`;
}

export function isWorkdayReviewOmittedProfileField(field: string): boolean {
  return new Set([
    "identity.middle_name",
    "address.line2",
    "address.postal_code",
    "address.region",
    "phone.device_type",
    "phone.country_code",
  ]).has(field);
}

function monitorPage(
  page: "resume" | "profile" | "questionnaire" | "pre_review",
): "resume" | "profile" | "questionnaire" | "review" {
  return page === "pre_review" ? "review" : page;
}

function applicationMonitorDiagnostic(stage: string, moment?: string): void {
  if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE !== "1") return;
  try {
    process.stderr.write(`${JSON.stringify({
      applicationMonitorStage: stage,
      ...(moment === undefined ? {} : { moment }),
    })}\n`);
  } catch {}
}

function isReturnedNavigationSource(
  observed: ApplicationPageTruth,
  source: ApplicationPageTruth,
): boolean {
  return isExactVerifiedApplicationSource(observed, source);
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
                '[data-automation-id="applyFlowSelfIdentifyPage"]',
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
  return new Set(["Application Questions", "Voluntary Disclosures", "Self Identify"]);
}

export async function monitorQuestionnaireCoverage(page: Page): Promise<{
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
      '[data-automation-id="applyFlowSelfIdentifyPage"]',
    ].flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
      .filter(visible)
      .filter((candidate, _index, all) => all.every((root) =>
        candidate === root || candidate.contains(root)
      ));
    if (roots.length !== 1) return null;
    const controls = [...new Set(roots[0]!.querySelectorAll<HTMLElement>(
      '[data-automation-id="dateSection"], [data-automation-id="dateInputWrapper"], ' +
        '[data-automation-id$="-CheckboxGroup"], ' +
        '[data-automation-id="formField"], [data-automation-id^="formField-"], ' +
        'fieldset, input:not([type="hidden"]), textarea, select, [role="combobox"], ' +
        '[role="listbox"], [role="radio"], [role="checkbox"], ' +
        'button[aria-haspopup="listbox"]',
    ))].filter((control) => {
      if (!visible(control) || control.hasAttribute("disabled") ||
          control.getAttribute("aria-disabled") === "true") return false;
      const genericCheckboxOwner = control.closest<HTMLElement>(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      );
      const genericCheckboxes = genericCheckboxOwner === null ? [] :
        [...genericCheckboxOwner.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
          .filter(visible);
      const isGenericCheckboxGroup = genericCheckboxOwner !== null &&
        genericCheckboxOwner.querySelector('[data-automation-id$="-CheckboxGroup"]') === null &&
        genericCheckboxes.length >= 2;
      if (isGenericCheckboxGroup) return genericCheckboxOwner === control;
      if (control.matches(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      )) return false;
      if (
        control instanceof HTMLFieldSetElement &&
        !control.matches('[data-automation-id$="-CheckboxGroup"]')
      ) {
        return control.querySelector('input[type="radio"], [role="radio"]') !== null;
      }
      const dateOwner = control.closest(
        '[data-automation-id="dateSection"], [data-automation-id="dateInputWrapper"]',
      );
      if (dateOwner !== null && dateOwner !== control) return false;
      const checkboxGroupOwner = control.closest(
        '[data-automation-id$="-CheckboxGroup"]',
      );
      if (checkboxGroupOwner !== null && checkboxGroupOwner !== control) return false;
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
      else if (control.matches(
        '[data-automation-id="dateSection"], [data-automation-id="dateInputWrapper"]',
      )) type = "date";
      else if (control instanceof HTMLInputElement &&
          (control.type === "text" || control.type === "tel") &&
          (
            /^M{1,2}[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*\/[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*D{1,2}[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*\/[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*Y{2,4}$/iu.test(
              control.placeholder.trim(),
            ) || /^date(?:\s*\*)?$/iu.test((control.closest(
              '[data-automation-id="formField"], [data-automation-id^="formField-"]',
            )?.querySelector("label, legend")?.textContent ?? "").replace(/\s+/gu, " ").trim()) || [...(control.closest(
              '[data-automation-id="formField"], [data-automation-id^="formField-"]',
            )?.querySelectorAll('button[aria-label]') ?? [])].filter((button) =>
              /^(?:open )?(?:calendar|date picker)$/iu.test(
                (button.getAttribute("aria-label") ?? "").trim(),
              )
            ).length === 1
          )) type = "date";
      else if (
        control.matches('[data-automation-id$="-CheckboxGroup"]') ||
        control.matches('[data-automation-id="formField"], [data-automation-id^="formField-"]') &&
          control.querySelector('[data-automation-id$="-CheckboxGroup"]') === null &&
          control.querySelectorAll('input[type="checkbox"]').length >= 2
      ) type = "radio";
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
      const fieldLabel = (field?.querySelector("label, legend")?.textContent ?? "")
        .normalize("NFC").replace(/\s+/gu, " ").trim();
      const requiredWorkdayDate = control.matches(
        '[data-automation-id="dateSection"], [data-automation-id="dateInputWrapper"]',
      ) && fieldLabel.endsWith("*") &&
        !/(?:^|\s|\()not required\)?(?:\s*\*)?$/iu.test(fieldLabel);
      if (
        control.hasAttribute("required") || control.getAttribute("aria-required") === "true" ||
        accessibleRequired(control) ||
        control instanceof HTMLFieldSetElement &&
          [...control.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
            .some((radio) => radio.required) ||
        field !== null && field.querySelector(requiredMarker) !== null ||
        requiredWorkdayDate
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
    return settledProfileMonitorTaxonomy(page);
  }
  const selectors = [
    ["text", 'input:not([type]):visible, input[type="text"]:visible, input[type="email"]:visible'],
    ["phone", 'input[type="tel"]:visible'],
    ["number", 'input[type="number"]:visible'],
    ["textarea", "textarea:visible"],
    ["select", 'select:visible, [role=combobox]:visible, [aria-haspopup="listbox"]:visible'],
    ["radio", 'input[type="radio"]:visible, [role=radio]:visible'],
    ["checkbox", 'input[type="checkbox"]:visible, [role=checkbox]:visible'],
    ["date", 'input[type="date"]:visible, [data-automation-id="dateSection"]:visible, ' +
      '[data-automation-id="dateInputWrapper"]:visible'],
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
    result === null || result.fieldCount < 1 ||
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
      if (/\b(?:race|ethnicity|gender|hispanic|latino|veteran|military|armed forces|disability|demographic)\b/u.test(label)) categories.add("demographic");
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
    const byIdentity = new Map([...expected.values()].map((fact) => [fact.rowIdentity, fact]));
    if (byIdentity.size !== expected.size) throw new TypeError("Review identities ambiguous");
    const identities = await realRows.evaluateAll((rows) => rows.map((row) =>
      row.getAttribute("data-automation-id") ?? ""
    ));
    if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
      process.stderr.write(`${JSON.stringify({
        applicationReviewRowDiagnostics: {
          expectedCount: expected.size,
          observedCount: realCount,
          expectedIdentityCount: identities.filter((identity) => byIdentity.has(identity)).length,
          observedIdentities: identities,
        },
      })}\n`);
    }
    const exactIdentityShape = realCount === expected.size &&
      identities.every((identity) => byIdentity.has(identity));
    if (exactIdentityShape) {
      for (let index = 0; index < realCount; index += 1) {
        const row = realRows.nth(index);
        if (!await row.isVisible()) throw new TypeError("Review field hidden");
        const identity = identities[index];
        if (identity === undefined || !isStableRowIdentity(identity)) {
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
    } else if (realCount === 1 && identities[0] === "formField-") {
      await verifyWorkdayReviewSummary(page, expected);
      expected.forEach((_fact, id) => seen.add(id));
    } else {
      throw new TypeError("Review rows incomplete or ambiguous");
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

async function verifyWorkdayReviewSummary(
  page: Page,
  expected: ReadonlyMap<string, ReviewExpectedField>,
): Promise<void> {
  const answers = await page.locator(workdayReviewSignatures.reviewRoot).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        if (element.children.length !== 0 || element.getClientRects().length === 0 ||
            element.closest('button, [role="button"]') !== null) return false;
        const weight = getComputedStyle(element).fontWeight;
        return weight === "normal" || Number.parseInt(weight, 10) < 600;
      })
      .map((element) => (element.textContent ?? "").normalize("NFC").replace(/\s+/gu, " ").trim())
      .filter(Boolean)
  );
  const observed = new Map<string, number>();
  for (const answer of answers) {
    for (const candidate of reviewAnswerCandidates(answer)) {
      const digest = createHash("sha256").update(candidate, "utf8").digest("hex");
      observed.set(digest, (observed.get(digest) ?? 0) + 1);
    }
  }
  const required = new Map<string, number>();
  expected.forEach(({ valueSha256 }) =>
    required.set(valueSha256, (required.get(valueSha256) ?? 0) + 1)
  );
  const missing = [...required].filter(([digest, count]) => (observed.get(digest) ?? 0) < count);
  if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
    const missingDigests = new Set(missing.map(([digest]) => digest));
    process.stderr.write(`${JSON.stringify({
      applicationReviewSummaryDiagnostics: {
        expectedFieldCount: expected.size,
        visibleAnswerLeafCount: answers.length,
        requiredDigestCount: required.size,
        missingDigestCount: missing.length,
        missingFieldIds: [...expected]
          .filter(([, { valueSha256 }]) => missingDigests.has(valueSha256))
          .map(([fieldId]) => fieldId),
      },
    })}\n`);
  }
  if (missing.length !== 0) throw new TypeError("Review field mismatch");
}

export function reviewAnswerCandidates(value: string): ReadonlySet<string> {
  const normalized = normalizeReviewValue(value);
  const candidates = new Set<string>([normalized]);
  candidates.add(canonicalReviewUrl(normalized));
  const words = normalized.split(" ").filter(Boolean);
  if (words.length <= 12 && !/^No Response$/iu.test(normalized)) {
    for (let start = 0; start < words.length; start += 1) {
      for (let length = 1; length <= 8 && start + length <= words.length; length += 1) {
        const span = words.slice(start, start + length).join(" ")
          .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
        if (span !== "") candidates.add(span);
      }
    }
  }
  const digitGroups = normalized.match(/\d+/gu) ?? [];
  for (let start = 0; start < digitGroups.length; start += 1) {
    let digits = "";
    for (let end = start; end < digitGroups.length; end += 1) {
      digits += digitGroups[end];
      candidates.add(digits);
    }
  }
  if (/\bCELL\b/u.test(normalized)) candidates.add("Mobile");
  if (/^Direct Sourcing$/iu.test(normalized)) candidates.add("Recruiter");
  return candidates;
}

function canonicalReviewUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hostname = url.hostname.replace(/^www\./iu, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    return value;
  }
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
  const submit = page.locator(workdayReviewSignatures.finalSubmitScope).getByRole("button", {
    name: workdayReviewSignatures.finalSubmitName,
  });
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
    const candidateRoots = [
      selectors.primaryQuestions,
      selectors.primaryQuestionnaire,
      selectors.applicationQuestions,
      selectors.voluntaryDisclosuresAndSelfIdentify,
    ].flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)]);
    const roots = candidateRoots.filter(visible);
    if (roots.length !== 1) return false;
    candidateRoots.forEach((root) =>
      root.querySelectorAll("[data-hunt-target-token]").forEach((control) =>
        control.removeAttribute("data-hunt-target-token")
      )
    );
    document.documentElement.setAttribute("data-hunt-page-id", declaredPageId);
    const questionnaireRoot = roots[0]!;
    const controls = questionnaireRoot.querySelectorAll<HTMLElement>(
      '[data-automation-id="dateSection"], [data-automation-id="dateInputWrapper"], ' +
        '[data-automation-id$="-CheckboxGroup"], ' +
        '[data-automation-id="formField"], [data-automation-id^="formField-"], ' +
        'fieldset, input:not([type="hidden"]), textarea, select, [role="listbox"], ' +
        'button[aria-haspopup="listbox"]',
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
      if (!visible(control)) continue;
      const genericCheckboxOwner = control.closest<HTMLElement>(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      );
      const genericCheckboxes = genericCheckboxOwner === null ? [] :
        [...genericCheckboxOwner.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
          .filter(visible);
      const isGenericCheckboxGroup = genericCheckboxOwner !== null &&
        genericCheckboxOwner.querySelector('[data-automation-id$="-CheckboxGroup"]') === null &&
        genericCheckboxes.length >= 2;
      if (isGenericCheckboxGroup) {
        if (genericCheckboxOwner !== control) continue;
        control.setAttribute("data-hunt-exclusive-checkbox-group", "true");
      } else if (control.matches(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      )) continue;
      const dateOwner = control.closest(
        '[data-automation-id="dateSection"], [data-automation-id="dateInputWrapper"]',
      );
      if (dateOwner !== null && dateOwner !== control) continue;
      const checkboxGroupOwner = control.closest('[data-automation-id$="-CheckboxGroup"]');
      if (checkboxGroupOwner !== null && checkboxGroupOwner !== control) continue;
      if (control instanceof HTMLInputElement && control.type === "radio" &&
          control.closest("fieldset") !== null) continue;
      const normalize = (value: string | null | undefined) =>
        (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
      const field = control.closest(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      );
      const isConditionalApplicationDate = dateOwner === control && questionnaireRoot.matches([
        selectors.primaryQuestions,
        selectors.primaryQuestionnaire,
        selectors.applicationQuestions,
      ].join(", "));
      let label = control instanceof HTMLInputElement && control.type === "checkbox"
        ? normalize(field?.textContent)
        : isConditionalApplicationDate
        ? normalize(field?.querySelector("label, legend")?.textContent)
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
      const fieldIdentity = field?.getAttribute("data-automation-id") ?? "";
      // Workday regenerates ids such as mcvf1 whenever React remounts a field.
      // A target remains the same question across that remount, so bind it to
      // the stable form-field owner and label instead of the ephemeral id.
      const stableControlId = /^mcvf\d+$/iu.test(control.id)
        ? fieldIdentity
        : control.id;
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
        stableControlId,
        control.getAttribute("name") ?? "",
        ...(isConditionalApplicationDate
          ? [field?.getAttribute("data-automation-id") ?? field?.id ?? ""]
          : []),
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

export async function questionnairePopupHydrationTargets(
  page: Page,
): Promise<readonly string[]> {
  return Object.freeze(await page.evaluate(({ selectors }) => {
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
    if (roots.length !== 1) return [];
    return [...roots[0]!.querySelectorAll<HTMLElement>(
      'button[aria-haspopup="listbox"][data-hunt-target-token]',
    )].filter((control) => {
      if (!visible(control) || control.hasAttribute("disabled") ||
          control.getAttribute("aria-disabled") === "true" ||
          control.hasAttribute("data-hunt-popup-options")) return false;
      const field = control.closest(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      );
      const ownedIds = [control.getAttribute("aria-controls"), control.getAttribute("aria-owns")]
        .flatMap((value) => value?.split(/\s+/u) ?? []);
      const ownedOptions = ownedIds.flatMap((id) =>
        [...(document.getElementById(id)?.querySelectorAll(
          '[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]',
        ) ?? [])]
      );
      const fieldOptions = field === null ? [] : [...field.querySelectorAll(
        '[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"]',
      )];
      return ownedOptions.length === 0 && fieldOptions.length === 0;
    }).map((control) => control.getAttribute("data-hunt-target-token") ?? "")
      .filter(Boolean);
  }, { selectors: WORKDAY_APPLICATION_PAGE_SELECTORS }));
}

export async function hydrateQuestionnairePopupOptions(
  page: Page,
  pageId: BrowserPageId,
  targetToken: string,
  timeoutMs: number,
): Promise<void> {
  if (!/^target-[a-z0-9-]{1,120}$/u.test(targetToken)) {
    throw new TypeError("questionnaire popup target denied");
  }
  const target = page.locator(`[data-hunt-target-token="${targetToken}"]`);
  if (await target.count() !== 1 || !await target.isVisible()) {
    throw new TypeError("questionnaire popup target unavailable");
  }
  const selectedBefore = await popupSelectedValue(target);
  await target.evaluate((_control, declaredToken) => {
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element.hidden ||
          element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" &&
        style.visibility !== "collapse" && element.getClientRects().length > 0;
    };
    document.querySelectorAll(`[data-hunt-popup-hydration-preexisting="${declaredToken}"]`)
      .forEach((element) => element.removeAttribute("data-hunt-popup-hydration-preexisting"));
    const optionSelector =
      '[role="option"], [data-automation-id="promptOption"], ' +
      '[data-automation-id="promptLeafNode"]';
    const popupSelector =
      '[role="listbox"], [role="dialog"], [data-automation-id="promptMenu"], ' +
      '[data-automation-id="promptPopup"]';
    [...document.querySelectorAll<HTMLElement>(optionSelector)].filter(visible)
      .map((option) => option.closest<HTMLElement>(popupSelector))
      .filter((owner): owner is HTMLElement => owner !== null)
      .forEach((owner) =>
        owner.setAttribute("data-hunt-popup-hydration-preexisting", declaredToken)
      );
  }, targetToken);
  await target.click({ timeout: timeoutMs });
  await bindQuestionnaireTargets(page, pageId);
  const reboundOpenTarget = page.locator(`[data-hunt-target-token="${targetToken}"]`);
  if (await reboundOpenTarget.count() !== 1 || !await reboundOpenTarget.isVisible()) {
    throw new TypeError("questionnaire popup target unavailable after open");
  }
  const popupOwnerBound = await reboundOpenTarget.evaluate((control, declaredToken) => {
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element.hidden ||
          element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" &&
        style.visibility !== "collapse" && element.getClientRects().length > 0;
    };
    document.querySelectorAll(`[data-hunt-popup-hydration-owner="${declaredToken}"]`)
      .forEach((element) => element.removeAttribute("data-hunt-popup-hydration-owner"));
    const optionSelector =
      '[role="option"], [data-automation-id="promptOption"], ' +
      '[data-automation-id="promptLeafNode"]';
    const ownsVisibleOptions = (element: Element) =>
      [...element.querySelectorAll(optionSelector)].some(visible);
    const ownedIds = [control.getAttribute("aria-controls"), control.getAttribute("aria-owns")]
      .flatMap((value) => value?.split(/\s+/u) ?? [])
      .filter((id) => /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(id));
    const directOwners = [...new Set(ownedIds)]
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement =>
        element !== null && visible(element) && ownsVisibleOptions(element)
      );
    const field = control.closest(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    );
    const fieldOwners = field !== null && ownsVisibleOptions(field) ? [field] : [];
    const popupSelector =
      '[role="listbox"], [role="dialog"], [data-automation-id="promptMenu"], ' +
      '[data-automation-id="promptPopup"]';
    const newlyVisibleOwners = [...new Set(
      [...document.querySelectorAll<HTMLElement>(optionSelector)].filter(visible)
        .map((option) => option.closest<HTMLElement>(popupSelector))
        .filter((owner): owner is HTMLElement => owner !== null)
        .filter((owner) =>
          owner.getAttribute("data-hunt-popup-hydration-preexisting") !== declaredToken
        ),
    )];
    const owners = directOwners.length > 0
      ? directOwners
      : fieldOwners.length > 0 ? fieldOwners : newlyVisibleOwners;
    if (owners.length !== 1) return false;
    owners[0]!.setAttribute("data-hunt-popup-hydration-owner", declaredToken);
    return true;
  }, targetToken);
  if (!popupOwnerBound) throw new TypeError("questionnaire popup owner unavailable");
  const options = page.locator(
    `[data-hunt-popup-hydration-owner="${targetToken}"] ` +
      '[data-automation-id="promptOption"]:visible, ' +
      `[data-hunt-popup-hydration-owner="${targetToken}"] [role="option"]:visible, ` +
      `[data-hunt-popup-hydration-owner="${targetToken}"] ` +
      '[data-automation-id="promptLeafNode"]:visible',
  );
  await options.first().waitFor({ state: "visible", timeout: Math.min(timeoutMs, 5_000) });
  const labels = [...new Set((await options.allInnerTexts())
    .map((value) => value.normalize("NFC").replace(/\s+/gu, " ").trim())
    .filter(Boolean))];
  await page.keyboard.press("Escape");
  await bindQuestionnaireTargets(page, pageId);
  if (!await waitForOwnedHydrationPopupClose(page, targetToken, Math.min(timeoutMs, 500))) {
    const reboundToggle = page.locator(`[data-hunt-target-token="${targetToken}"]`);
    if (await reboundToggle.count() !== 1 || !await reboundToggle.isVisible()) {
      throw new TypeError("questionnaire popup target unavailable during close");
    }
    await reboundToggle.click({ timeout: timeoutMs });
    await bindQuestionnaireTargets(page, pageId);
  }
  if (!await waitForOwnedHydrationPopupClose(page, targetToken, Math.min(timeoutMs, 5_000))) {
    throw new TypeError("questionnaire popup remained open after exact-owner close");
  }
  if (labels.length === 0 || labels.length > 128 || labels.some((label) => label.length > 512)) {
    throw new TypeError("questionnaire popup options denied");
  }
  const rebound = page.locator(`[data-hunt-target-token="${targetToken}"]`);
  if (await rebound.count() !== 1 || !await rebound.isVisible()) {
    throw new TypeError("questionnaire popup target unavailable after close");
  }
  const selectedAfter = await popupSelectedValue(rebound);
  if (selectedAfter !== selectedBefore) {
    throw new TypeError("questionnaire popup hydration changed selection");
  }
  await rebound.evaluate((element, observed) => {
    element.setAttribute("data-hunt-popup-options", JSON.stringify(observed));
  }, labels);
  await page.locator(`[data-hunt-popup-hydration-preexisting="${targetToken}"]`)
    .evaluateAll((elements) => elements.forEach((element) =>
      element.removeAttribute("data-hunt-popup-hydration-preexisting")
    ));
  await page.locator(`[data-hunt-popup-hydration-owner="${targetToken}"]`)
    .evaluateAll((elements) => elements.forEach((element) =>
      element.removeAttribute("data-hunt-popup-hydration-owner")
    ));
}

async function ownedHydrationPopupOpen(page: Page, targetToken: string): Promise<boolean> {
  return await page.locator(`[data-hunt-popup-hydration-owner="${targetToken}"]`)
    .evaluateAll((owners) => owners.some((owner) => {
      if (!(owner instanceof HTMLElement) || owner.hidden ||
          owner.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(owner);
      if (style.display === "none" || style.visibility === "hidden" ||
          style.visibility === "collapse" || owner.getClientRects().length === 0) return false;
      return [...owner.querySelectorAll(
        '[role="option"], [data-automation-id="promptOption"], ' +
          '[data-automation-id="promptLeafNode"]',
      )].some((option) => {
        if (!(option instanceof HTMLElement) || option.hidden ||
            option.getAttribute("aria-hidden") === "true") return false;
        const optionStyle = getComputedStyle(option);
        return optionStyle.display !== "none" && optionStyle.visibility !== "hidden" &&
          optionStyle.visibility !== "collapse" && option.getClientRects().length > 0;
      });
    }));
}

async function waitForOwnedHydrationPopupClose(
  page: Page,
  targetToken: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await ownedHydrationPopupOpen(page, targetToken)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await page.waitForTimeout(Math.min(50, remaining));
  }
  return true;
}

async function popupSelectedValue(target: import("playwright").Locator): Promise<string> {
  return await target.evaluate((element) => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
    const declared = normalize(element.getAttribute("aria-valuetext"));
    if (declared !== "") return declared;
    const field = element.closest(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    );
    const selected = [...(field?.querySelectorAll('[data-automation-id="selectedItem"]') ?? [])]
      .map((item) => normalize(item.textContent)).filter(Boolean);
    if (selected.length === 1) return selected[0]!;
    const text = normalize(element.textContent);
    return /^(?:select|select one|choose|choose one)$/iu.test(text) ? "" : text;
  });
}

async function checkboxFailureDiagnostics(page: Page): Promise<object> {
  return await page.locator(
    '[data-automation-id$="-CheckboxGroup"], [data-hunt-exclusive-checkbox-group="true"]',
  ).evaluateAll((groups) => {
    const probeRecord = document.documentElement as unknown as Record<string, unknown>;
    const probe = typeof probeRecord.__huntCheckboxProbe === "object" &&
        probeRecord.__huntCheckboxProbe !== null
      ? probeRecord.__huntCheckboxProbe as Record<string, number>
      : {};
    return {
      groupCount: groups.length,
      checkboxCount: groups.reduce(
        (count, group) => count + group.querySelectorAll('input[type="checkbox"]').length,
        0,
      ),
      checkedCount: groups.reduce(
        (count, group) => count + group.querySelectorAll('input[type="checkbox"]:checked').length,
        0,
      ),
      optionRowCount: groups.reduce(
        (count, group) => count + group.querySelectorAll(
          '[data-hunt-checkbox-surface="option-row"]',
        ).length,
        0,
      ),
      ownerSurfaceCount: groups.reduce(
        (count, group) => count + group.querySelectorAll(
          '[data-hunt-checkbox-surface="owner"]',
        ).length,
        0,
      ),
      visualSurfaceCount: groups.reduce(
        (count, group) => count + group.querySelectorAll(
          '[data-hunt-checkbox-surface="visual"]',
        ).length,
        0,
      ),
      admissionCheckboxIndex: probe.admissionCheckboxIndex ?? 0,
      admissionGroupCheckboxCount: probe.admissionGroupCheckboxCount ?? 0,
      admissionOwnerIdCount: probe.admissionOwnerIdCount ?? 0,
      originalOptionCount: probe.originalOptionCount ?? 0,
      stableGroupCount: probe.stableGroupCount ?? 0,
      stableCheckboxCount: probe.stableCheckboxCount ?? 0,
      stableExactLabelCount: probe.stableExactLabelCount ?? 0,
      adapterSelectCount: probe.adapterSelectCount ?? 0,
      adapterExclusiveSelectCount: probe.adapterExclusiveSelectCount ?? 0,
      candidateCount: probe.candidateCount ?? 0,
      sharedSelectCount: probe.sharedSelectCount ?? 0,
      sharedOptionSelectCount: probe.sharedOptionSelectCount ?? 0,
      exactObjectCallCount: probe.exactObjectCallCount ?? 0,
      exactIdCallCount: probe.exactIdCallCount ?? 0,
      exactCommitCount: probe.exactCommitCount ?? 0,
      exactRejectedCount: probe.exactRejectedCount ?? 0,
      exactThrowCount: probe.exactThrowCount ?? 0,
    };
  });
}

async function dateFailureDiagnostics(page: Page): Promise<object> {
  return await page.evaluate(() => {
    const root = document.documentElement as unknown as Record<string, unknown>;
    const probe = typeof root.__huntDateProbe === "object" && root.__huntDateProbe !== null
      ? root.__huntDateProbe as Record<string, boolean | number>
      : {};
    const visible = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" &&
        element.getClientRects().length > 0;
    };
    const visibleElement = (element: Element): boolean => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" &&
        element.getClientRects().length > 0;
    };
    const dateInputs = [...document.querySelectorAll<HTMLInputElement>(
      'input[type="text"], input[type="tel"]',
    )].filter((input) => {
      const fieldOwner = input.closest<HTMLElement>(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      );
      const label = (fieldOwner?.querySelector("label, legend")?.textContent ?? "")
        .replace(/\s+/gu, " ").trim();
      return visible(input) && (
        /^M{1,2}[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*\/[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*D{1,2}[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*\/[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*Y{2,4}$/iu.test(
          input.placeholder.trim(),
        ) || /^date(?:\s*\*)?$/iu.test(label) || /^\d{1,2}\/\d{1,2}\/\d{4}$/u.test(
          input.value.replace(/[\s\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu, ""),
        )
      );
    });
    const allTextTelInputs = [...document.querySelectorAll<HTMLInputElement>(
      'input[type="text"], input[type="tel"]',
    )];
    const maskedInputs = allTextTelInputs.filter((input) =>
      /^M{1,2}[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*\/[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*D{1,2}[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*\/[\s\u200E\u200F\u202A-\u202E\u2066-\u2069]*Y{2,4}$/iu.test(
        input.placeholder.trim(),
      )
    );
    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/gu, " ").replace(/\s*\*\s*$/u, "").trim();
    const exactDateLabels = [...document.querySelectorAll<HTMLElement>("label, legend")]
      .filter(visible)
      .filter((element) => normalize(element.textContent) === "Date");
    const exactMaskTexts = [...document.querySelectorAll<HTMLElement>(
      'span, div, p, [role="textbox"], [contenteditable="true"]',
    )].filter(visible).filter((element) =>
      /^M{1,2}\s*\/\s*D{1,2}\s*\/\s*Y{2,4}$/iu.test(normalize(element.textContent))
    );
    const boundDateInputs = allTextTelInputs.filter((input) =>
      input.hasAttribute("data-hunt-target-token") && (
        normalize(input.getAttribute("aria-label")) === "Date" ||
        [...(input.labels ?? [])].some((label) => normalize(label.textContent) === "Date")
      )
    );
    const boundDateInput = boundDateInputs.length === 1 ? boundDateInputs[0] : undefined;
    const boundDatePropRecords = boundDateInput === undefined
      ? []
      : Object.keys(boundDateInput).filter((key) => key.startsWith("__reactProps$"))
        .map((key) => (boundDateInput as unknown as Record<string, unknown>)[key])
        .filter((value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null
        );
    let dateSvgOwner: HTMLElement | undefined;
    let dateSvgOwnerDepth = 0;
    if (boundDateInput !== undefined) {
      let owner = boundDateInput.parentElement;
      let depth = 1;
      while (owner !== null && owner !== document.body && depth <= 16) {
        const exactLabels = [...owner.querySelectorAll<HTMLElement>("label, legend")]
          .filter(visible).filter((label) => normalize(label.textContent) === "Date");
        const svgs = [...owner.querySelectorAll<SVGElement>("svg")].filter(visibleElement);
        if (exactLabels.length > 0 && svgs.length > 0) {
          dateSvgOwner = owner;
          dateSvgOwnerDepth = depth;
          break;
        }
        owner = owner.parentElement;
        depth += 1;
      }
    }
    const dateSvgOwnerLabels = dateSvgOwner === undefined
      ? []
      : [...dateSvgOwner.querySelectorAll<HTMLElement>("label, legend")].filter(visible);
    const dateSvgOwnerSvgs = dateSvgOwner === undefined
      ? []
      : [...dateSvgOwner.querySelectorAll<SVGElement>("svg")].filter(visibleElement);
    const dateSvgOwnerElements = dateSvgOwner === undefined
      ? []
      : [dateSvgOwner, ...dateSvgOwner.querySelectorAll<HTMLElement>("*")];
    const dateSvgOwnerReactClickCount = dateSvgOwnerElements.filter((element) => {
      const record = element as unknown as Record<string, unknown>;
      return Object.keys(element).some((key) => {
        if (!key.startsWith("__reactProps$")) return false;
        const props = record[key];
        return typeof props === "object" && props !== null &&
          typeof (props as Record<string, unknown>).onClick === "function";
      });
    }).length;
    const boundRightAncestry: Element[] = [];
    if (boundDateInput !== undefined) {
      const box = boundDateInput.getBoundingClientRect();
      let hit: Element | null = document.elementFromPoint(box.right - 12, box.top + box.height / 2);
      while (hit !== null && boundRightAncestry.length < 16) {
        boundRightAncestry.push(hit);
        if (hit === dateSvgOwner) break;
        hit = hit.parentElement;
      }
    }
    const boundRightReactClickAncestorCount = boundRightAncestry.filter((element) => {
      const record = element as unknown as Record<string, unknown>;
      return Object.keys(element).some((key) => {
        if (!key.startsWith("__reactProps$")) return false;
        const props = record[key];
        return typeof props === "object" && props !== null &&
          typeof (props as Record<string, unknown>).onClick === "function";
      });
    }).length;
    const ownerCandidates: HTMLElement[] = [];
    for (const label of exactDateLabels) {
      let owner = label.parentElement;
      while (owner !== null && owner !== document.body) {
        const ownerMaskedInputs = [...owner.querySelectorAll<HTMLInputElement>(
          'input[type="text"], input[type="tel"]',
        )].filter((input) => maskedInputs.includes(input));
        const ownerMaskTexts = exactMaskTexts.filter((element) => owner!.contains(element));
        const ownerSvgs = [...owner.querySelectorAll<SVGElement>("svg")].filter((element) => {
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" &&
            element.getClientRects().length > 0;
        });
        if (ownerMaskedInputs.length + ownerMaskTexts.length > 0 && ownerSvgs.length > 0) {
          ownerCandidates.push(owner);
          break;
        }
        owner = owner.parentElement;
      }
    }
    const exactOwner = ownerCandidates.length === 1 ? ownerCandidates[0] : undefined;
    const ownerTextTelInputs = exactOwner === undefined
      ? []
      : [...exactOwner.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="tel"]')];
    const dateInput = dateInputs.length === 1 ? dateInputs[0] : undefined;
    const fieldOwner = dateInput?.closest<HTMLElement>(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    );
    const ancestry: HTMLElement[] = [];
    if (dateInput !== undefined && fieldOwner !== null && fieldOwner !== undefined) {
      const box = dateInput.getBoundingClientRect();
      let hit = document.elementFromPoint(box.right - 16, box.top + box.height / 2);
      while (hit instanceof HTMLElement && ancestry.length < 16) {
        ancestry.push(hit);
        if (hit === fieldOwner) break;
        hit = hit.parentElement;
      }
    }
    const clickHandlerCount = ancestry.filter((element) => {
      const record = element as unknown as Record<string, unknown>;
      return Object.keys(element).some((key) => {
        if (!key.startsWith("__reactProps$")) return false;
        const props = record[key];
        return typeof props === "object" && props !== null &&
          typeof (props as Record<string, unknown>).onClick === "function";
      });
    }).length;
    return {
      digitAccepted: probe.digitAccepted ?? false,
      fillAccepted: probe.fillAccepted ?? false,
      sequentialAccepted: probe.sequentialAccepted ?? false,
      ownerCallSucceeded: probe.ownerCallSucceeded ?? false,
      ownerAccepted: probe.ownerAccepted ?? false,
      directPropCount: probe.directPropCount ?? 0,
      directOnChangeCount: probe.directOnChangeCount ?? 0,
      directOnChangeArity: probe.directOnChangeArity ?? 0,
      directOnBlurCount: probe.directOnBlurCount ?? 0,
      directOnInputCount: probe.directOnInputCount ?? 0,
      calendarOpened: probe.calendarOpened ?? false,
      calendarCandidateCount: probe.calendarCandidateCount ?? 0,
      calendarAccepted: probe.calendarAccepted ?? false,
      nativeDateInputCount: probe.nativeDateInputCount ?? 0,
      nativeDateAccepted: probe.nativeDateAccepted ?? false,
      formattedDateReboundCount: probe.formattedDateReboundCount ?? 0,
      dateInputCount: dateInputs.length,
      allTextTelInputCount: allTextTelInputs.length,
      maskedInputCount: maskedInputs.length,
      visibleMaskedInputCount: maskedInputs.filter(visible).length,
      exactDateLabelCount: exactDateLabels.length,
      exactMaskTextCount: exactMaskTexts.length,
      exactMaskTextSpanCount: exactMaskTexts.filter((element) => element.tagName === "SPAN").length,
      exactMaskTextDivCount: exactMaskTexts.filter((element) => element.tagName === "DIV").length,
      exactMaskTextRoleTextboxCount: exactMaskTexts.filter((element) =>
        element.getAttribute("role") === "textbox"
      ).length,
      exactMaskTextContentEditableCount: exactMaskTexts.filter((element) => element.isContentEditable).length,
      boundDateInputCount: boundDateInputs.length,
      boundDateExactLabelCount: boundDateInput === undefined ? 0 :
        [...(boundDateInput.labels ?? [])].filter((label) => normalize(label.textContent) === "Date").length,
      boundDateAssociatedLabelCount: boundDateInput === undefined ? 0 :
        exactDateLabels.filter((label) =>
          label instanceof HTMLLabelElement && label.control === boundDateInput
        ).length,
      boundDateClosestFormFieldCount: boundDateInput?.closest(
        '[data-automation-id="formField"], [data-automation-id^="formField-"]',
      ) === null || boundDateInput === undefined ? 0 : 1,
      boundDateClosestDateSectionCount: boundDateInput?.closest(
        '[data-automation-id="dateSection"]',
      ) === null || boundDateInput === undefined ? 0 : 1,
      boundDatePlaceholderMaskCount: boundDateInput !== undefined &&
          /^M{1,2}\s*\/\s*D{1,2}\s*\/\s*Y{2,4}$/iu.test(boundDateInput.placeholder.trim()) ? 1 : 0,
      boundDateValueMaskCount: boundDateInput !== undefined &&
          /^M{1,2}\s*\/\s*D{1,2}\s*\/\s*Y{2,4}$/iu.test(boundDateInput.value.trim()) ? 1 : 0,
      boundDateReactOnChangeCount: boundDatePropRecords.filter(({ onChange }) =>
        typeof onChange === "function"
      ).length,
      dateSvgOwnerCandidateCount: dateSvgOwner === undefined ? 0 : 1,
      dateSvgOwnerDepth,
      dateSvgOwnerExactLabelCount: dateSvgOwnerLabels.filter((label) =>
        normalize(label.textContent) === "Date"
      ).length,
      dateSvgOwnerLabelCount: dateSvgOwnerLabels.length,
      dateSvgOwnerSvgCount: dateSvgOwnerSvgs.length,
      dateSvgOwnerInputCount: dateSvgOwner?.querySelectorAll("input").length ?? 0,
      dateSvgOwnerButtonCount: dateSvgOwner?.querySelectorAll("button").length ?? 0,
      dateSvgOwnerRoleButtonCount: dateSvgOwner?.querySelectorAll('[role="button"]').length ?? 0,
      dateSvgOwnerAutomationCount: dateSvgOwner?.querySelectorAll("[data-automation-id]").length ?? 0,
      dateSvgOwnerReactClickCount,
      boundRightHitInput: boundDateInput !== undefined && boundRightAncestry[0] === boundDateInput,
      boundRightHitWithinSvgOwner: dateSvgOwner !== undefined && boundRightAncestry.includes(dateSvgOwner),
      boundRightHitSvgAncestor: boundRightAncestry.some((element) => element.tagName === "svg"),
      boundRightReactClickAncestorCount,
      dateOwnerCandidateCount: ownerCandidates.length,
      dateOwnerInputCount: exactOwner?.querySelectorAll("input").length ?? 0,
      dateOwnerTextTelInputCount: ownerTextTelInputs.length,
      dateOwnerVisibleTextTelInputCount: ownerTextTelInputs.filter(visible).length,
      dateOwnerButtonCount: exactOwner?.querySelectorAll("button").length ?? 0,
      dateOwnerRoleButtonCount: exactOwner?.querySelectorAll('[role="button"]').length ?? 0,
      dateOwnerSvgCount: exactOwner?.querySelectorAll("svg").length ?? 0,
      dateOwnerAutomationCount: exactOwner?.querySelectorAll("[data-automation-id]").length ?? 0,
      fieldButtonCount: fieldOwner?.querySelectorAll("button").length ?? 0,
      fieldRoleButtonCount: fieldOwner?.querySelectorAll('[role="button"]').length ?? 0,
      fieldSvgCount: fieldOwner?.querySelectorAll("svg").length ?? 0,
      fieldAutomationCount: fieldOwner?.querySelectorAll("[data-automation-id]").length ?? 0,
      rightHitInput: dateInput !== undefined && ancestry[0] === dateInput,
      rightHitWithinField: fieldOwner !== null && fieldOwner !== undefined &&
        ancestry.includes(fieldOwner),
      rightHitButtonAncestor: ancestry.some((element) => element.tagName === "BUTTON"),
      rightHitRoleButtonAncestor: ancestry.some((element) => element.getAttribute("role") === "button"),
      rightHitSvgAncestor: ancestry.some((element) => element.tagName === "svg"),
      rightHitAutomationAncestor: ancestry.some((element) => element.hasAttribute("data-automation-id")),
      rightHitReactClickAncestorCount: clickHandlerCount,
    };
  });
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
