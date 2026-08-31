import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import {
  isAllowedApplicationTransition,
  maximumApplicationPageVisits,
  type ApplicationHandlerPage,
} from "../../ats/workday/application/page-walk-contract.ts";
import {
  applicationMonitorPages,
  validateStage2MonitorPng,
} from "./review-monitor-chain.ts";
import { isReviewedMonitorStructuralIds } from "./monitor-structures.ts";
import {
  readStage2ExternalMonitorObserverBinding,
  signStage2ExternalMonitorAcknowledgement,
  type Stage2ExternalMonitorObserverBinding,
  type Stage2ExternalMonitorObserverSigner,
  verifyStage2ExternalMonitorAcknowledgement,
} from "./external-monitor-authority.ts";
export {
  readStage2AuthMonitorChain,
  readStage2ReviewMonitorChain,
} from "./review-monitor-chain.ts";

const AUTH_PAGES = new Set([
  "job_posting", "apply_choice", "email_sign_in_choice", "account_entry",
  "verification_required", "verification_navigation", "sign_in", "application_ready",
  "password_reset_request", "password_reset_email_sent", "password_reset_set",
  "captcha", "mfa", "access_control", "unknown",
]);
const AUTH_MOMENTS = new Set([
  "state_observed", "before_mutation", "after_readback", "before_navigation", "transition",
]);
const APPLICATION_PAGES = new Set([...applicationMonitorPages, "review"]);
const APPLICATION_MOMENTS = new Set([
  "before_mutation", "after_readback", "before_navigation", "transition",
  "state_observed", "recovery_observed", "review_readback",
]);
const POSTING_FREE_MONITOR_PAGES = new Set([
  "apply_choice", "email_sign_in_choice", "account_entry", "verification_required",
  "verification_navigation", "sign_in", "application_ready", "captcha", "mfa",
  "password_reset_request", "password_reset_email_sent", "password_reset_set",
  "access_control", "resume", "profile", "questionnaire", "review",
]);
const LIVE_FILE = "external-monitor-live.json";

type AuthPage = string;
type AuthMoment = string;
type ApplicationPage = "resume" | "profile" | "questionnaire" | "review";
type ApplicationMoment = string;
type MonitorClassification = "safe_to_continue" | "account_verified" | "review_verified";

export interface Stage2MonitorIdentityDigests {
  readonly hostSha256: string;
  readonly tenantSha256: string;
  readonly postingSha256: string;
  readonly titleSha256: string;
}

export interface Stage2MonitorObservedIdentity {
  readonly host: string;
  readonly tenant: string;
  readonly posting: string;
  readonly title: string;
}

export interface Stage2MonitorTaxonomy {
  readonly fieldCount: number;
  readonly requiredFieldCount: number;
  readonly controlTypes: readonly string[];
  readonly questionTypes: readonly string[];
  readonly answerTypes: readonly string[];
  readonly validationState: "clear";
  readonly submitPresent: boolean;
  readonly submitActivated: false;
}

export interface Stage2MonitorPage {
  screenshot(options?: { readonly type?: "png"; readonly fullPage?: boolean }): Promise<Buffer>;
  title(): Promise<string>;
  url(): string | Promise<string>;
}

export interface Stage2MonitorLifecycleEvent {
  readonly operationId: string;
  readonly attempt: number;
}

export interface Stage2ExternalMonitorRequestBinding {
  readonly path: string;
  readonly ordinal: number;
  readonly page: string;
  readonly moment: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly sha256: string;
}

export interface Stage2ExternalMonitorRuntimeOptions {
  readonly runtimeRoot: string;
  readonly evidenceRoot: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly sourceRevision: string;
  readonly configSha256: string;
  readonly host: string;
  readonly tenant: string;
  readonly posting: string;
  readonly processLiveNonceSha256: string;
  readonly processIssuedAt: string;
  readonly processOwnerPid: number;
  readonly processOwnerStartedAt: string;
  readonly processLiveness?: (pid: number, startedAt: string) => boolean;
  readonly observer?: Stage2ExternalMonitorObserverBinding;
  readonly now?: () => string;
  readonly acknowledgementTimeoutMs?: number;
  readonly acknowledgementPollMs?: number;
  readonly trace?: (event: string, details?: Stage2ExternalMonitorTraceDetails) => void;
  readonly waitForAcknowledgement?: (
    request: Stage2ExternalMonitorRequestBinding,
  ) => Promise<void>;
}

export interface Stage2ExternalMonitorTraceDetails {
  readonly chain: "auth" | "application";
  readonly page: string;
  readonly moment: string;
  readonly ordinal: number;
  readonly operationId: string;
  readonly attempt: number;
  readonly failureStage?: string;
  readonly durationMs?: number;
  readonly phasePassed?: boolean;
  readonly fieldCount?: number;
  readonly requiredFieldCount?: number;
  readonly controlTypes?: readonly string[];
  readonly questionTypes?: readonly string[];
  readonly answerTypes?: readonly string[];
  readonly validationState?: "clear";
  readonly submitPresent?: boolean;
  readonly submitActivated: false;
}

export class Stage2ExternalMonitorRuntime {
  readonly #options: Stage2ExternalMonitorRuntimeOptions;
  readonly #runtimeRoot: string;
  readonly #evidenceRoot: string;
  readonly #livePath: string;
  readonly #monitorLiveTokenSha256: string;
  #authOrdinal = 0;
  #applicationOrdinal = 0;
  #previousAuthAck: string | null = null;
  #previousApplicationAck: string | null = null;
  #pendingAuth: Stage2MonitorLifecycleEvent & { readonly page: string; readonly kind: "mutation" | "navigation" } | undefined;
  #pendingApplication: Stage2MonitorLifecycleEvent & { readonly page: string; readonly kind: "mutation" | "navigation" } | undefined;
  readonly #usedAuthOperations = new Set<string>();
  readonly #usedApplicationOperations = new Set<string>();
  readonly #attempts = new Map<string, number>();
  #currentAuthPage: string | undefined;
  #currentApplicationPage: string | undefined;
  readonly #applicationVisited: ApplicationHandlerPage[] = [];
  #closed = false;
  #active = false;

  constructor(options: Stage2ExternalMonitorRuntimeOptions) {
    this.#options = validateOptions(options);
    this.#runtimeRoot = directory(options.runtimeRoot, "external monitor runtime denied");
    this.#evidenceRoot = directory(options.evidenceRoot, "external monitor runtime denied");
    this.#livePath = join(this.#runtimeRoot, LIVE_FILE);
    this.#monitorLiveTokenSha256 = digest(Buffer.from(
      `s2-monitor-live-v1\0${options.processLiveNonceSha256}\0${options.journeyId}\0${options.targetHandleId}`,
      "utf8",
    ));
    const live = {
      schemaVersion: 1,
      liveRevision: "s2-external-monitor-live-v1",
      journeyId: options.journeyId,
      targetHandleId: options.targetHandleId,
      processLiveNonceSha256: options.processLiveNonceSha256,
      monitorLiveTokenSha256: this.#monitorLiveTokenSha256,
      processIssuedAt: options.processIssuedAt,
      processOwnerPid: options.processOwnerPid,
      processOwnerStartedAt: options.processOwnerStartedAt,
      processInstanceSha256: processInstanceDigest(
        options.processOwnerPid,
        options.processOwnerStartedAt,
      ),
      ...(options.observer === undefined ? {} : observerFields(options.observer)),
    };
    writeJson(this.#livePath, live);
  }

  auth(
    page: Stage2MonitorPage,
    pageName: AuthPage,
    moment: AuthMoment,
    taxonomy: Stage2MonitorTaxonomy,
    event: Stage2MonitorLifecycleEvent,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#capture("auth", page, pageName, moment, taxonomy, event, signal);
  }

  application(
    page: Stage2MonitorPage,
    pageName: ApplicationPage,
    moment: ApplicationMoment,
    taxonomy: Stage2MonitorTaxonomy,
    event: Stage2MonitorLifecycleEvent,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#capture("application", page, pageName, moment, taxonomy, event, signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    rmSync(this.#livePath, { force: true });
  }

  async #capture(
    chain: "auth" | "application",
    page: Stage2MonitorPage,
    pageName: string,
    moment: string,
    taxonomyInput: Stage2MonitorTaxonomy,
    event: Stage2MonitorLifecycleEvent,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#closed || this.#active || signal.aborted || !existsSync(this.#livePath) ||
        !(this.#options.processLiveness ?? processInstanceAlive)(
          this.#options.processOwnerPid,
          this.#options.processOwnerStartedAt,
        )) denied();
    const ordinal = (chain === "auth" ? this.#authOrdinal : this.#applicationOrdinal) + 1;
    if (ordinal > 512 || !validEvent(event) ||
        !this.#legalMoment(chain, pageName, moment, event)) denied();
    const traceContext = Object.freeze({
      chain,
      page: pageName,
      moment,
      ordinal,
      operationId: event.operationId,
      attempt: event.attempt,
      submitActivated: false as const,
    });
    let failureStage = "capture_started";
    let taxonomyTrace: Stage2ExternalMonitorTraceDetails = traceContext;
    const captureStarted = performance.now();
    this.#active = true;
    try {
      emitMonitorTrace(this.#options.trace, "external_monitor_capture_started", traceContext);
      const root = this.#chainRoot(chain);
      const prefix = `${String(ordinal).padStart(4, "0")}-${pageName}-${moment}`;
      const screenshotFile = `${prefix}.png`;
      const taxonomyFile = `${prefix}.taxonomy.json`;
      const requestFile = `${prefix}.request.json`;
      const ackFile = `${prefix}.ack.json`;
      failureStage = "url_before_read";
      const urlBefore = await page.url();
      emitMonitorTrace(this.#options.trace, "external_monitor_url_before_read", traceContext);
      failureStage = "screenshot_capture";
      const screenshot = await page.screenshot({
        type: "png",
        ...(chain === "application" && pageName === "review" && moment === "review_readback"
          ? { fullPage: true }
          : {}),
      });
      emitMonitorTrace(this.#options.trace, "external_monitor_screenshot_received", traceContext);
      failureStage = "screenshot_validation";
      validateStage2MonitorPng(screenshot);
      emitMonitorTrace(this.#options.trace, "external_monitor_screenshot_captured", traceContext);
      failureStage = "title_capture";
      const title = boundedTitle(await page.title());
      emitMonitorTrace(this.#options.trace, "external_monitor_title_captured", traceContext);
      failureStage = "url_after_read";
      const urlAfter = await page.url();
      emitMonitorTrace(this.#options.trace, "external_monitor_url_after_read", traceContext);
      failureStage = "identity_verification";
      const capturedIdentityDigests = identityDigests(
        observedIdentity(urlBefore, urlAfter, this.#options, pageName),
        title,
      );
      emitMonitorTrace(this.#options.trace, "external_monitor_identity_verified", traceContext);
      failureStage = "taxonomy_admission";
      const taxonomy = exactTaxonomy({
        schemaVersion: 1,
        evidenceRevision: "s2-monitor-taxonomy-v1",
        journeyId: this.#options.journeyId,
        targetHandleId: this.#options.targetHandleId,
        ordinal,
        page: pageName,
        moment,
        ...taxonomyInput,
        privacyScan: "pass",
      });
      taxonomyTrace = Object.freeze({
        ...traceContext,
        fieldCount: taxonomy.fieldCount as number,
        requiredFieldCount: taxonomy.requiredFieldCount as number,
        controlTypes: Object.freeze([...(taxonomy.controlTypes as string[])]),
        questionTypes: Object.freeze([...(taxonomy.questionTypes as string[])]),
        answerTypes: Object.freeze([...(taxonomy.answerTypes as string[])]),
        validationState: "clear" as const,
        submitPresent: taxonomy.submitPresent as boolean,
      });
      emitMonitorTrace(this.#options.trace, "external_monitor_taxonomy_admitted", taxonomyTrace);
      failureStage = "screenshot_persistence";
      writeBytes(join(root, screenshotFile), screenshot);
      emitMonitorTrace(this.#options.trace, "external_monitor_screenshot_written", taxonomyTrace);
      failureStage = "taxonomy_persistence";
      const taxonomyBytes = jsonBytes(taxonomy);
      writeBytes(join(root, taxonomyFile), taxonomyBytes);
      emitMonitorTrace(this.#options.trace, "external_monitor_taxonomy_written", taxonomyTrace);
      const previousAckSha256 = chain === "auth"
        ? this.#previousAuthAck
        : this.#previousApplicationAck;
      const request = {
        schemaVersion: 1,
        requestRevision: this.#options.observer === undefined
          ? "s2-external-monitor-request-v3"
          : "s2-external-monitor-request-v4",
        journeyId: this.#options.journeyId,
        targetHandleId: this.#options.targetHandleId,
        operationId: event.operationId,
        attempt: event.attempt,
        ordinal,
        page: pageName,
        moment,
        screenshotFile,
        screenshotSha256: digest(screenshot),
        taxonomyFile,
        taxonomySha256: digest(taxonomyBytes),
        expectedSubmitPresent: taxonomy.submitPresent,
        previousAckSha256,
        processLiveNonceSha256: this.#options.processLiveNonceSha256,
        processIssuedAt: this.#options.processIssuedAt,
        processInstanceSha256: processInstanceDigest(
          this.#options.processOwnerPid,
          this.#options.processOwnerStartedAt,
        ),
        monitorLiveTokenSha256: this.#monitorLiveTokenSha256,
        issuedAt: canonicalTimestamp(this.#options.now?.() ?? new Date().toISOString()),
        sourceRevision: this.#options.sourceRevision,
        configSha256: this.#options.configSha256,
        capturedIdentityDigests,
        ...(this.#options.observer === undefined ? {} : observerFields(this.#options.observer)),
      } as const;
      const requestBytes = jsonBytes(request);
      const requestPath = join(root, requestFile);
      failureStage = "request_persistence";
      writeBytes(requestPath, requestBytes);
      emitMonitorTrace(this.#options.trace, "external_monitor_request_written", taxonomyTrace);
      const binding = Object.freeze({
        path: requestPath,
        ordinal,
        page: pageName,
        moment,
        operationId: event.operationId,
        attempt: event.attempt,
        sha256: digest(requestBytes),
      });
      emitMonitorTrace(this.#options.trace, "external_monitor_evidence_published", taxonomyTrace);
      failureStage = "acknowledgement_wait";
      if (this.#options.waitForAcknowledgement !== undefined) {
        await this.#options.waitForAcknowledgement(binding);
      } else {
        await waitForAck(
          this.#runtimeRoot,
          root,
          ackFile,
          request,
          binding.sha256,
          this.#options.acknowledgementTimeoutMs ?? 600_000,
          this.#options.acknowledgementPollMs ?? 250,
        );
      }
      if (this.#closed) denied();
      validateLiveFile(this.#livePath, request);
      if (!(this.#options.processLiveness ?? processInstanceAlive)(
        this.#options.processOwnerPid,
        this.#options.processOwnerStartedAt,
      )) denied();
      failureStage = "acknowledgement_validation";
      const ackSha256 = validateAck(root, ackFile, request, binding.sha256);
      emitMonitorTrace(this.#options.trace, "external_monitor_acknowledged", taxonomyTrace);
      if (chain === "auth") {
        this.#authOrdinal = ordinal;
        this.#previousAuthAck = ackSha256;
      } else {
        this.#applicationOrdinal = ordinal;
        this.#previousApplicationAck = ackSha256;
      }
      this.#commitMoment(chain, pageName, moment, event);
      emitMonitorTrace(this.#options.trace, "external_monitor_capture_completed", Object.freeze({
        ...taxonomyTrace,
        durationMs: monotonicDuration(captureStarted),
        phasePassed: true,
      }));
    } catch (error) {
      emitMonitorTrace(this.#options.trace, "external_monitor_capture_failed", Object.freeze({
        ...taxonomyTrace,
        failureStage,
        durationMs: monotonicDuration(captureStarted),
        phasePassed: false,
      }));
      this.close();
      throw error;
    } finally {
      this.#active = false;
    }
  }

  #legalMoment(
    chain: "auth" | "application",
    page: string,
    moment: string,
    event: Stage2MonitorLifecycleEvent,
  ): boolean {
    const pages = chain === "auth" ? AUTH_PAGES : APPLICATION_PAGES;
    const moments = chain === "auth" ? AUTH_MOMENTS : APPLICATION_MOMENTS;
    if (!pages.has(page) || !moments.has(moment)) return false;
    const pending = chain === "auth" ? this.#pendingAuth : this.#pendingApplication;
    const starts = moment === "before_mutation" || moment === "before_navigation";
    const finishes = moment === "after_readback" || moment === "transition";
    if (starts) {
      const used = chain === "auth" ? this.#usedAuthOperations : this.#usedApplicationOperations;
      const kind = moment === "before_mutation" ? "mutation" : "navigation";
      const attemptKey = `${chain}:${page}:${kind}`;
      const current = chain === "auth" ? this.#currentAuthPage : this.#currentApplicationPage;
      return pending === undefined && page !== "review" &&
        (chain !== "auth" || safeAuthEffectPage(page)) &&
        (current === undefined ? chain === "auth" || applicationMonitorPages.includes(
          page as ApplicationHandlerPage,
        ) : current === page) &&
        !used.has(event.operationId) &&
        (kind === "navigation" ||
          event.attempt === (this.#attempts.get(attemptKey) ?? 0) + 1);
    }
    if (finishes) {
      const kind = moment === "after_readback" ? "mutation" : "navigation";
      const routeAttemptKey = pending === undefined
        ? ""
        : `${chain}:${pending.page}:navigation`;
      return pending !== undefined && pending.kind === kind &&
        legalPair(chain, kind, pending.page, page, this.#applicationVisited) &&
        pending.operationId === event.operationId && pending.attempt === event.attempt &&
        (kind === "mutation" ||
          event.attempt === (this.#attempts.get(routeAttemptKey) ?? 0) + 1);
    }
    const used = chain === "auth" ? this.#usedAuthOperations : this.#usedApplicationOperations;
    const attemptKey = `${chain}:${page}:${moment}`;
    const current = chain === "auth" ? this.#currentAuthPage : this.#currentApplicationPage;
    return pending === undefined && (current === undefined
      ? chain === "auth" ||
        page === "review" && moment === "review_readback" ||
        moment === "state_observed" && applicationMonitorPages.includes(
          page as ApplicationHandlerPage,
        )
      : current === page) &&
      !used.has(event.operationId) &&
      event.attempt === (this.#attempts.get(attemptKey) ?? 0) + 1 &&
      (moment !== "review_readback" || page === "review");
  }

  #commitMoment(
    chain: "auth" | "application",
    page: string,
    moment: string,
    event: Stage2MonitorLifecycleEvent,
  ): void {
    const kind = moment === "before_mutation" || moment === "after_readback"
      ? "mutation" as const
      : "navigation" as const;
    const value = Object.freeze({ ...event, page, kind });
    const starts = moment === "before_mutation" || moment === "before_navigation";
    const finishes = moment === "after_readback" || moment === "transition";
    const used = chain === "auth" ? this.#usedAuthOperations : this.#usedApplicationOperations;
    if (starts || !finishes) {
      used.add(event.operationId);
      if (!starts || kind === "mutation") {
        const attemptKey = `${chain}:${page}:${starts ? kind : moment}`;
        this.#attempts.set(attemptKey, event.attempt);
      }
    }
    if (finishes && kind === "navigation") {
      const pendingPage = chain === "auth" ? this.#pendingAuth?.page : this.#pendingApplication?.page;
      if (pendingPage === undefined) denied();
      this.#attempts.set(`${chain}:${pendingPage}:navigation`, event.attempt);
      if (
        chain === "application" && page !== pendingPage && page !== "review"
      ) this.#applicationVisited.push(page as ApplicationHandlerPage);
    }
    if (chain === "auth") {
      this.#pendingAuth = starts ? value : finishes ? undefined : this.#pendingAuth;
      if (starts && this.#currentAuthPage === undefined) this.#currentAuthPage = page;
      if (finishes || !starts) this.#currentAuthPage = page;
    } else {
      this.#pendingApplication = starts ? value : finishes ? undefined : this.#pendingApplication;
      if (starts && this.#currentApplicationPage === undefined) {
        this.#currentApplicationPage = page;
        this.#applicationVisited.push(page as ApplicationHandlerPage);
      }
      if (finishes || !starts) this.#currentApplicationPage = page;
    }
  }

  #chainRoot(chain: "auth" | "application"): string {
    const path = join(this.#evidenceRoot, chain === "auth" ? "auth-monitor" : "monitor");
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    return directory(path, "external monitor runtime denied");
  }
}

export function createStage2ExternalMonitorRuntime(
  options: Stage2ExternalMonitorRuntimeOptions,
): Stage2ExternalMonitorRuntime {
  return new Stage2ExternalMonitorRuntime(options);
}

export function writeStage2ExternalMonitorAcknowledgement(request: {
  readonly runtimeRoot: string;
  readonly evidenceRoot: string;
  readonly requestPath: string;
  readonly classification: MonitorClassification;
  readonly observedScreenshotSha256: string;
  readonly observedIdentity: Stage2MonitorObservedIdentity;
  readonly structuralDescriptionIds: readonly string[];
  readonly observedAt?: string;
  readonly journeyId?: string;
  readonly observer?: Stage2ExternalMonitorObserverSigner;
  readonly observedStructurePage?: string;
  readonly observedSubmitPresent?: boolean;
  readonly privacyScan?: "separate_evidence_required";
}): void {
  try {
    const evidenceRoot = directory(request.evidenceRoot, "external monitor acknowledgement denied");
    const runtimeRoot = directory(request.runtimeRoot, "external monitor acknowledgement denied");
    const requestPath = stablePath(request.requestPath, 16 * 1024, 2);
    const parent = dirname(requestPath);
    if (
      parent !== join(evidenceRoot, "monitor") &&
      parent !== join(evidenceRoot, "auth-monitor")
    ) ackDenied();
    const requestBytes = readStable(requestPath, 16 * 1024, 2);
    const monitorRequest = JSON.parse(requestBytes.toString("utf8")) as Record<string, unknown>;
    validateLiveFile(join(runtimeRoot, LIVE_FILE), monitorRequest);
    const live = JSON.parse(readStable(join(runtimeRoot, LIVE_FILE), 16 * 1024, 2).toString("utf8")) as Record<string, unknown>;
    if (!processInstanceAlive(live.processOwnerPid as number, live.processOwnerStartedAt as string)) {
      ackDenied();
    }
    const classification = request.classification;
    const expectedClassification = monitorRequest.page === "review" &&
        monitorRequest.moment === "review_readback" ? "review_verified"
      : monitorRequest.page === "application_ready" && monitorRequest.moment === "state_observed"
        ? "account_verified"
      : "safe_to_continue";
    const observedIdentityDigests = identityDigestsFromObservation(request.observedIdentity);
    if (
      classification !== expectedClassification ||
      request.journeyId !== undefined && request.journeyId !== monitorRequest.journeyId ||
      JSON.stringify(observedIdentityDigests) !== JSON.stringify(monitorRequest.capturedIdentityDigests)
    ) ackDenied();
    const ordinal = monitorRequest.ordinal as number;
    const page = monitorRequest.page as string;
    const moment = monitorRequest.moment as string;
    const prefix = `${String(ordinal).padStart(4, "0")}-${page}-${moment}`;
    const screenshotBytes = readStable(join(parent, `${prefix}.png`), 12 * 1024 * 1024, 8);
    validateStage2MonitorPng(screenshotBytes);
    const observedScreenshotSha256 = exactSha256(request.observedScreenshotSha256);
    if (
      monitorRequest.screenshotFile !== `${prefix}.png` ||
      monitorRequest.screenshotSha256 !== digest(screenshotBytes) ||
      observedScreenshotSha256 !== monitorRequest.screenshotSha256
    ) ackDenied();
    const unsignedAck = {
      schemaVersion: 4,
      evidenceRevision: "s2-external-monitor-ack-v4",
      status: "acknowledged",
      observer: "independent_visual_monitor",
      journeyId: monitorRequest.journeyId,
      targetHandleId: monitorRequest.targetHandleId,
      operationId: monitorRequest.operationId,
      attempt: monitorRequest.attempt,
      ordinal,
      page,
      moment,
      requestFile: `${prefix}.request.json`,
      requestSha256: digest(requestBytes),
      classification,
      observedScreenshotSha256,
      identityReconciliation: "matched",
      identityDimensions: ["host", "posting", "title"],
      observedIdentityDigests,
      structuralDescriptionIds: exactStructuralIds(
        request.structuralDescriptionIds,
        page,
      ),
      privacyScan: "pass" as "pass" | "separate_evidence_required",
      submitPresent: exactExpectedSubmitPresent(monitorRequest),
      submitActivated: false,
      observedAt: canonicalTimestamp(request.observedAt ?? new Date().toISOString()),
    } as const;
    if (Date.parse(unsignedAck.observedAt) < Date.parse(monitorRequest.issuedAt as string)) ackDenied();
    const observerBound = observerBoundRequest(monitorRequest);
    const observedStructurePage = request.observedStructurePage;
    if (observerBound && (
      typeof observedStructurePage !== "string" ||
      request.observedSubmitPresent !== exactExpectedSubmitPresent(monitorRequest) ||
      request.privacyScan !== "separate_evidence_required"
    )) ackDenied();
    const boundUnsignedAck = observerBound
      ? Object.freeze({
          ...unsignedAck,
          privacyScan: request.privacyScan,
          submitPresent: request.observedSubmitPresent,
          observedStructurePage,
        })
      : unsignedAck;
    const ack = observerBound
      ? signedAcknowledgement(boundUnsignedAck, monitorRequest, request.observer)
      : unsignedAck;
    writeJson(join(parent, `${prefix}.ack.json`), ack);
  } catch {
    ackDenied();
  }
}

export function readStage2ExternalMonitorObservation(
  runtimeRootValue: string,
  observationPathValue: string,
): {
  readonly observedScreenshotSha256: string;
  readonly observedIdentity: Stage2MonitorObservedIdentity;
  readonly structuralDescriptionIds: readonly string[];
  readonly observedAt: string;
} {
  try {
    const runtimeRoot = directory(runtimeRootValue, "external monitor observation denied");
    const path = stablePath(observationPathValue, 16 * 1024, 2);
    const filename = path.slice(runtimeRoot.length + 1);
    const filenameMatch = /^[0-9]{4}-([a-z_]+)-[a-z_]+\.observation\.json$/u.exec(filename);
    if (dirname(path) !== runtimeRoot || filenameMatch === null) throw new Error();
    const value = JSON.parse(readStable(path, 16 * 1024, 2).toString("utf8")) as Record<string, unknown>;
    const keys = [
      "schemaVersion", "evidenceRevision", "observer", "observedScreenshotSha256",
      "observedIdentity",
      "structuralDescriptionIds", "observedAt",
    ];
    if (Object.keys(value).length !== keys.length ||
        keys.some((key, index) => Object.keys(value)[index] !== key) ||
        value.schemaVersion !== 2 ||
        value.evidenceRevision !== "s2-external-monitor-observation-v2" ||
        value.observer !== "independent_visual_monitor") throw new Error();
    return Object.freeze({
      observedScreenshotSha256: exactSha256(value.observedScreenshotSha256 as string),
      observedIdentity: exactObservedIdentity(
        value.observedIdentity as Stage2MonitorObservedIdentity,
      ),
      structuralDescriptionIds: exactStructuralIds(
        value.structuralDescriptionIds as readonly string[],
        filenameMatch[1],
      ),
      observedAt: canonicalTimestamp(value.observedAt as string),
    });
  } catch {
    throw new Error("external monitor observation denied");
  }
}

async function waitForAck(
  runtimeRoot: string,
  root: string,
  ackFile: string,
  request: Record<string, unknown>,
  requestSha256: string,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000 ||
      !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 5_000) denied();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      validateAck(root, ackFile, request, requestSha256);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("external monitor acknowledgement unavailable");
      if (observerBoundRequest(request)) {
        try {
          readStage2ExternalMonitorObserverBinding(runtimeRoot, {
            journeyId: request.journeyId as string,
            targetHandleId: request.targetHandleId as string,
          });
        } catch {
          throw new Error("external monitor observer unavailable");
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
    }
  }
}

function validateAck(
  root: string,
  ackFile: string,
  request: Record<string, unknown>,
  requestSha256: string,
): string {
  const bytes = readStable(join(root, ackFile), 16 * 1024, 2);
  const ack = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const observerBound = observerBoundRequest(request);
  const expectedClassification = request.page === "review" && request.moment === "review_readback"
    ? "review_verified"
    : request.page === "application_ready" && request.moment === "state_observed"
      ? "account_verified"
    : "safe_to_continue";
  if (
    ack.schemaVersion !== (observerBound ? 5 : 4) ||
    ack.evidenceRevision !== (observerBound
      ? "s2-external-monitor-ack-v5"
      : "s2-external-monitor-ack-v4") ||
    ack.status !== "acknowledged" || ack.observer !== "independent_visual_monitor" ||
    ack.journeyId !== request.journeyId || ack.targetHandleId !== request.targetHandleId ||
    ack.operationId !== request.operationId || ack.attempt !== request.attempt ||
    ack.ordinal !== request.ordinal || ack.page !== request.page || ack.moment !== request.moment ||
    ack.requestSha256 !== requestSha256 || ack.classification !== expectedClassification ||
    ack.observedScreenshotSha256 !== request.screenshotSha256 ||
    ack.identityReconciliation !== "matched" ||
    ack.privacyScan !== (observerBound ? "separate_evidence_required" : "pass") ||
    ack.submitPresent !== exactExpectedSubmitPresent(request) || ack.submitActivated !== false ||
    JSON.stringify(ack.observedIdentityDigests) !== JSON.stringify(request.capturedIdentityDigests) ||
    !isReviewedMonitorStructuralIds(ack.structuralDescriptionIds, request.page as string) ||
    !Array.isArray(ack.identityDimensions) ||
    ack.identityDimensions.join("\0") !== ["host", "posting", "title"].join("\0") ||
    !canonicalTimestamp(ack.observedAt as string) ||
    Date.parse(ack.observedAt as string) < Date.parse(request.issuedAt as string) ||
    observerBound && (
      typeof ack.observedStructurePage !== "string" ||
      !compatibleObservedStructure(request.page as string, ack.observedStructurePage) ||
      !validSignedAcknowledgement(ack, request)
    )
  ) throw new Error("external monitor acknowledgement unavailable");
  return digest(bytes);
}

function observerFields(binding: Stage2ExternalMonitorObserverBinding) {
  return Object.freeze({
    observerPid: binding.observerPid,
    observerStartedAt: binding.observerStartedAt,
    observerInstanceSha256: binding.observerInstanceSha256,
    observerPublicKeySpki: binding.publicKeySpki,
    observerPublicKeySha256: binding.publicKeySha256,
  });
}

function compatibleObservedStructure(requestPage: string, observedPage: unknown): boolean {
  if (requestPage === observedPage) return true;
  if (requestPage === "resume" && observedPage === "profile") return true;
  return requestPage === "application_ready" && typeof observedPage === "string" &&
    ["resume", "profile", "questionnaire", "review"].includes(observedPage);
}

function signedAcknowledgement(
  acknowledgement: Record<string, unknown>,
  monitorRequest: Record<string, unknown>,
  signer: Stage2ExternalMonitorObserverSigner | undefined,
): Record<string, unknown> {
  if (signer === undefined ||
      signer.binding.journeyId !== monitorRequest.journeyId ||
      signer.binding.targetHandleId !== monitorRequest.targetHandleId ||
      Object.entries(observerFields(signer.binding)).some(([key, value]) =>
        monitorRequest[key] !== value
      )) ackDenied();
  const unsigned = Object.freeze({
    ...acknowledgement,
    schemaVersion: 5,
    evidenceRevision: "s2-external-monitor-ack-v5",
    observerInstanceSha256: signer.binding.observerInstanceSha256,
    observerPublicKeySha256: signer.binding.publicKeySha256,
  });
  return Object.freeze({
    ...unsigned,
    observerSignature: signStage2ExternalMonitorAcknowledgement(unsigned, signer),
  });
}

function validSignedAcknowledgement(
  acknowledgement: Record<string, unknown>,
  request: Record<string, unknown>,
): boolean {
  try {
    const { observerSignature, ...unsigned } = acknowledgement;
    const binding = Object.freeze({
      schemaVersion: 1 as const,
      liveRevision: "s2-external-monitor-observer-live-v1" as const,
      journeyId: request.journeyId as string,
      targetHandleId: request.targetHandleId as string,
      observerPid: request.observerPid as number,
      observerStartedAt: request.observerStartedAt as string,
      observerInstanceSha256: request.observerInstanceSha256 as string,
      publicKeySpki: request.observerPublicKeySpki as string,
      publicKeySha256: request.observerPublicKeySha256 as string,
    });
    return acknowledgement.observerInstanceSha256 === binding.observerInstanceSha256 &&
      acknowledgement.observerPublicKeySha256 === binding.publicKeySha256 &&
      verifyStage2ExternalMonitorAcknowledgement(unsigned, observerSignature, binding);
  } catch {
    return false;
  }
}

function exactTaxonomy(value: Record<string, unknown>): Record<string, unknown> {
  const arrays = [value.controlTypes, value.questionTypes, value.answerTypes];
  const exactZeroControlArrays = value.fieldCount === 0 &&
    arrays.every((item) => Array.isArray(item) && item.length === 0);
  const exactNonemptyArrays = arrays.every(stringArray);
  if (!count(value.fieldCount) || !count(value.requiredFieldCount) ||
      (value.requiredFieldCount as number) > (value.fieldCount as number) ||
      (!exactZeroControlArrays && !exactNonemptyArrays) || value.validationState !== "clear" ||
      typeof value.submitPresent !== "boolean" || value.submitActivated !== false) denied();
  return Object.freeze({ ...value });
}

function exactDigests(value: Stage2MonitorIdentityDigests): Stage2MonitorIdentityDigests {
  const keys = Object.keys(value);
  const expected = ["hostSha256", "tenantSha256", "postingSha256", "titleSha256"];
  if (keys.length !== expected.length || expected.some((key, index) => key !== keys[index]) ||
      Object.values(value).some((item) => !/^[0-9a-f]{64}$/u.test(item))) ackDenied();
  return Object.freeze({ ...value });
}

function exactSha256(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) ackDenied();
  return value;
}

function exactObservedIdentity(
  value: Stage2MonitorObservedIdentity,
): Stage2MonitorObservedIdentity {
  const keys = Object.keys(value);
  const expected = ["host", "tenant", "posting", "title"];
  if (keys.length !== expected.length || expected.some((key, index) => key !== keys[index])) {
    ackDenied();
  }
  const host = value.host.toLowerCase();
  const tenant = value.tenant.toLowerCase();
  if (
    host !== value.host || tenant !== value.tenant ||
    !/^[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])$/u.test(host) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(tenant) ||
    !/^[A-Za-z0-9-]{2,64}$/u.test(value.posting)
  ) ackDenied();
  return Object.freeze({
    host,
    tenant,
    posting: value.posting.toUpperCase(),
    title: boundedTitle(value.title),
  });
}

function identityDigestsFromObservation(
  value: Stage2MonitorObservedIdentity,
): Stage2MonitorIdentityDigests {
  const observed = exactObservedIdentity(value);
  return identityDigests(observed, observed.title);
}

function observedIdentity(
  beforeValue: string,
  afterValue: string,
  expected: Stage2ExternalMonitorRuntimeOptions,
  pageName: string,
): { readonly host: string; readonly tenant: string; readonly posting: string } {
  try {
    if (beforeValue !== afterValue) denied();
    const parsed = new URL(afterValue);
    const host = parsed.hostname.toLowerCase();
    const tenant = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.wd\d{1,3}\.myworkdayjobs\.com$/u
      .exec(host)?.[1];
    const rawSegments = parsed.pathname.split("/").filter(Boolean);
    const jobBoundary = rawSegments.lastIndexOf("job");
    const postings = (jobBoundary < 0 ? [] : rawSegments.slice(jobBoundary + 1))
      .flatMap((rawSegment) => {
        const segment = decodeURIComponent(rawSegment);
        if (/[\\/]/u.test(segment)) denied();
        const match = /_([A-Za-z0-9-]{2,64})$/u.exec(segment);
        return match === null ? [] : [match[1]!.toUpperCase()];
      });
    if (
      parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
      parsed.port !== "" || tenant === undefined || postings.length > 1 ||
      host !== expected.host || tenant !== expected.tenant ||
      (postings.length === 1
        ? postings[0] !== expected.posting
        : !POSTING_FREE_MONITOR_PAGES.has(pageName))
    ) denied();
    return Object.freeze({ host, tenant, posting: postings[0] ?? expected.posting });
  } catch {
    return denied();
  }
}

function identityDigests(
  observed: { readonly host: string; readonly tenant: string; readonly posting: string },
  title: string,
): Stage2MonitorIdentityDigests {
  return Object.freeze({
    hostSha256: digest(Buffer.from(observed.host, "utf8")),
    tenantSha256: digest(Buffer.from(observed.tenant, "utf8")),
    postingSha256: digest(Buffer.from(observed.posting, "utf8")),
    titleSha256: digest(Buffer.from(canonicalMonitorIdentityTitle(title), "utf8")),
  });
}

function validateOptions(options: Stage2ExternalMonitorRuntimeOptions): Stage2ExternalMonitorRuntimeOptions {
  if (!/^journey_[A-Za-z0-9_-]{16,64}$/u.test(options.journeyId) ||
      !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(options.targetHandleId) ||
      !/^[0-9a-f]{40}$/u.test(options.sourceRevision) ||
      !/^[0-9a-f]{64}$/u.test(options.configSha256) ||
      !/^[0-9a-f]{64}$/u.test(options.processLiveNonceSha256) ||
      !canonicalTimestamp(options.processIssuedAt) ||
      !Number.isSafeInteger(options.processOwnerPid) || options.processOwnerPid < 1 ||
      !canonicalTimestamp(options.processOwnerStartedAt) ||
      options.trace !== undefined && typeof options.trace !== "function" ||
      !/^[a-z0-9.-]{4,253}$/u.test(options.host) ||
      !/^[a-z0-9-]{2,64}$/u.test(options.tenant) ||
      !/^[A-Za-z0-9-]{2,64}$/u.test(options.posting) ||
      options.observer !== undefined && (
        options.observer.journeyId !== options.journeyId ||
        options.observer.targetHandleId !== options.targetHandleId ||
        !(options.processLiveness ?? processInstanceAlive)(
          options.observer.observerPid,
          options.observer.observerStartedAt,
        )
      )) denied();
  return Object.freeze({ ...options });
}

function emitMonitorTrace(
  trace: Stage2ExternalMonitorRuntimeOptions["trace"],
  event: string,
  details: Stage2ExternalMonitorTraceDetails,
): void {
  try { trace?.(event, details); } catch { /* diagnostics never change monitor behavior */ }
}

function validEvent(value: Stage2MonitorLifecycleEvent): boolean {
  return /^operation_[A-Za-z0-9_-]{16,64}$/u.test(value.operationId) &&
    Number.isSafeInteger(value.attempt) && value.attempt >= 1 && value.attempt <= 256;
}

function legalPair(
  chain: "auth" | "application",
  kind: "mutation" | "navigation",
  from: string,
  to: string,
  visited: readonly ApplicationHandlerPage[],
): boolean {
  if (chain === "application") {
    if (kind === "mutation") return from === to;
    if (to === from) return true;
    if (!applicationMonitorPages.includes(from as ApplicationHandlerPage)) return false;
    const destination = to === "review" ? "pre_review" : to;
    if (
      destination !== "pre_review" &&
      !applicationMonitorPages.includes(destination as ApplicationHandlerPage)
    ) return false;
    if (destination !== "pre_review" && visited.length >= maximumApplicationPageVisits) {
      return false;
    }
    return isAllowedApplicationTransition(
      from as ApplicationHandlerPage,
      destination as ApplicationHandlerPage | "pre_review",
      visited,
    );
  }
  if (!safeAuthEffectPage(from) || !safeAuthEffectPage(to)) return false;
  return kind === "mutation" && from === to || legalAuthTransition(from, to);
}

function safeAuthEffectPage(page: string): boolean {
  return AUTH_PAGES.has(page) &&
    !["captcha", "mfa", "access_control", "unknown"].includes(page);
}

function legalAuthTransition(from: string, to: string): boolean {
  const edges: Readonly<Record<string, readonly string[]>> = {
    job_posting: [
      "apply_choice", "email_sign_in_choice", "account_entry", "sign_in", "application_ready",
    ],
    apply_choice: ["email_sign_in_choice", "account_entry", "application_ready"],
    email_sign_in_choice: ["account_entry", "sign_in", "application_ready"],
    account_entry: [
      "verification_required", "verification_navigation", "sign_in", "application_ready",
      "password_reset_request",
    ],
    password_reset_request: ["password_reset_email_sent"],
    password_reset_email_sent: ["verification_navigation"],
    password_reset_set: ["sign_in", "application_ready"],
    verification_required: ["verification_navigation", "sign_in", "application_ready"],
    verification_navigation: ["sign_in", "password_reset_set", "application_ready"],
    sign_in: ["job_posting", "password_reset_request", "application_ready"],
    application_ready: [],
  };
  return edges[from]?.includes(to) === true;
}

function validateLiveFile(path: string, expected: Record<string, unknown>): void {
  const value = JSON.parse(readStable(path, 16 * 1024, 2).toString("utf8")) as Record<string, unknown>;
  const keys = Object.keys(value);
  const exact = [
    "schemaVersion", "liveRevision", "journeyId", "targetHandleId",
    "processLiveNonceSha256", "monitorLiveTokenSha256", "processIssuedAt",
    "processOwnerPid", "processOwnerStartedAt", "processInstanceSha256",
    ...(observerBoundRequest(expected)
      ? ["observerPid", "observerStartedAt", "observerInstanceSha256", "observerPublicKeySpki", "observerPublicKeySha256"]
      : []),
  ];
  if (keys.length !== exact.length || exact.some((key, index) => key !== keys[index]) ||
      value.schemaVersion !== 1 || value.liveRevision !== "s2-external-monitor-live-v1" ||
      value.journeyId !== expected.journeyId || value.targetHandleId !== expected.targetHandleId ||
      value.processLiveNonceSha256 !== expected.processLiveNonceSha256 ||
      value.monitorLiveTokenSha256 !== expected.monitorLiveTokenSha256 ||
      value.processIssuedAt !== expected.processIssuedAt) ackDenied();
  if (value.processInstanceSha256 !== expected.processInstanceSha256 ||
      value.processInstanceSha256 !== processInstanceDigest(
        value.processOwnerPid as number,
        value.processOwnerStartedAt as string,
      )) ackDenied();
  if (observerBoundRequest(expected) &&
      ["observerPid", "observerStartedAt", "observerInstanceSha256", "observerPublicKeySpki", "observerPublicKeySha256"]
        .some((key) => value[key] !== expected[key])) ackDenied();
}

function observerBoundRequest(value: Record<string, unknown>): boolean {
  return value.requestRevision === "s2-external-monitor-request-v2" ||
    value.requestRevision === "s2-external-monitor-request-v4";
}

function monotonicDuration(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function exactExpectedSubmitPresent(value: Record<string, unknown>): boolean {
  if (value.requestRevision === "s2-external-monitor-request-v3" ||
      value.requestRevision === "s2-external-monitor-request-v4") {
    if (typeof value.expectedSubmitPresent !== "boolean") ackDenied();
    return value.expectedSubmitPresent;
  }
  // Historical v1/v2 records predate independent submit-state binding.
  return value.page === "review";
}

export function currentProcessStartedAt(): string {
  return processStartedAt(process.pid);
}

export function processStartedAt(pid: number): string { return processStartTime(pid); }

function processInstanceDigest(pid: number, startedAt: string): string {
  return digest(Buffer.from(`s2-process-instance-v1\0${pid}\0${startedAt}`, "utf8"));
}

function processInstanceAlive(pid: number, startedAt: string): boolean {
  try { return processStartTime(pid) === startedAt; } catch { return false; }
}

function processStartTime(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("process identity denied");
  if (process.platform !== "win32") {
    if (pid !== process.pid) throw new Error("process identity denied");
    return new Date(Date.now() - process.uptime() * 1_000).toISOString();
  }
  const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")`;
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return canonicalTimestamp(output);
}

function exactStructuralIds(value: readonly string[], page?: string): readonly string[] {
  if (!isReviewedMonitorStructuralIds(value, page)) ackDenied();
  return Object.freeze([...value]);
}

function boundedTitle(value: string): string {
  const title = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (title.length < 1 || title.length > 256 || /[\u0000-\u001f\u007f]/u.test(title)) denied();
  return title;
}

export function canonicalMonitorIdentityTitle(value: string): string {
  return boundedTitle(boundedTitle(value).replace(/&/gu, " "));
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function writeJson(path: string, value: unknown): void {
  writeBytes(path, jsonBytes(value));
}

function writeBytes(path: string, value: Uint8Array): void {
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
}

function readStable(path: string, maximum: number, minimum: number): Buffer {
  const admitted = stablePath(path, maximum, minimum);
  const before = statSync(admitted);
  const bytes = readFileSync(admitted);
  const after = statSync(admitted);
  if (before.size !== bytes.byteLength || before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs) throw new Error("unstable monitor evidence");
  return bytes;
}

function stablePath(path: string, maximum: number, minimum: number): string {
  if (!isAbsolute(path) || normalize(path) !== path || !existsSync(path)) ackDenied();
  const item = lstatSync(path);
  if (item.isSymbolicLink() || !item.isFile() || item.nlink !== 1 ||
      item.size < minimum || item.size > maximum ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))) ackDenied();
  return realpathSync.native(path);
}

function directory(value: string, message: string): string {
  try {
    if (!isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
        !statSync(value).isDirectory() ||
        comparable(realpathSync.native(value)) !== comparable(resolve(value))) throw new Error();
    return realpathSync.native(value);
  } catch {
    throw new Error(message);
  }
}

function count(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 256;
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= 16 &&
    new Set(value).size === value.length && value.every((item) =>
      typeof item === "string" && /^[a-z][a-z0-9_.-]{0,63}$/u.test(item)
    );
}

function canonicalTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) denied();
  return value;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new Error("external monitor runtime denied");
}

function ackDenied(): never {
  throw new Error("external monitor acknowledgement denied");
}
