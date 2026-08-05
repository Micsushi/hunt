import { createHash, randomBytes } from "node:crypto";

import type { Page } from "playwright";

import type { ApplicationLaneAcceptance } from
  "../../../ats/workday/application/lane-composition.ts";
import { PlaywrightWorkdayApplicationPage } from
  "../../../ats/workday/application/playwright-page.ts";
import {
  completeWorkdayProfilePage,
  PlaywrightWorkdayProfilePage,
} from "../../../ats/workday/application/profile/index.ts";
import { createQuestionnairePageHandler } from
  "../../../ats/workday/application/questions/index.ts";
import {
  createPlaywrightWorkdayResumePage,
  createWorkdayResumeUploadDriver,
  createWorkdayResumeUploadHandler,
  createWorkdayResumeVerifier,
} from "../../../ats/workday/application/resume/index.ts";
import type {
  ApplicationPageHandlerPort,
  ApplicationPortFailure,
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
import { createSafetyGuard } from "../../../safety/guards.ts";
import type { OwnedApplicationOperation } from "./application-page-types.ts";
import type { PersistentPage } from "./types.ts";

const runtimeRevision = guardRevision("s2-playwright-runtime-v1");

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
}

/** Fixed browser-owner implementation. Callers supply data, never executable page code. */
export class OwnedWorkdayApplicationRuntime {
  #request: Stage2ApplicationWalkRuntimeBindingRequest | undefined;
  #session: LiveBrowserSessionV1 | undefined;
  readonly #acceptances: OwnedWorkdayApplicationRuntimeOptions["acceptances"];
  readonly #nextOperationId: () => OperationId;
  readonly #timeoutMs: number;
  readonly #reviewExpected = new Map<string, ReviewExpectedField>();

  constructor(options: OwnedWorkdayApplicationRuntimeOptions) {
    this.#request = options.request;
    this.#acceptances = options.acceptances;
    this.#nextOperationId = options.nextOperationId;
    this.#timeoutMs = options.timeoutMs;
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
      case "inspect_recovery":
        return new PlaywrightWorkdayApplicationPage(page, { timeoutMs: this.#timeoutMs }).observe(signal);
      case "next":
        return new PlaywrightWorkdayApplicationPage(page, { timeoutMs: this.#timeoutMs }).next(
          operation.input as Parameters<PlaywrightWorkdayApplicationPage["next"]>[0], signal,
        );
      case "reconcile_resume": {
        const input = operation.input as Parameters<ApplicationPageHandlerPort<"resume">["reconcile"]>[0];
        const resumePage = createPlaywrightWorkdayResumePage(page);
        const result = await createWorkdayResumeUploadHandler({
          driver: createWorkdayResumeUploadDriver(resumePage, { timeoutMs: this.#timeoutMs }),
          verifier: createWorkdayResumeVerifier(resumePage, { maxAttempts: 20, intervalMs: 50 }),
          replaceExisting: true,
        }).upload(request.ownerSources.resumeIntent, signal);
        if (!result.ok) throw new TypeError("resume reconciliation denied");
        this.#acceptances.record(result.value);
        this.#recordReviewExpectation("s1-field-resume", "resume_verified", "resume.pdf");
        return verified("resume", "resume_verified", input.pageId);
      }
      case "reconcile_profile": {
        const input = operation.input as Parameters<ApplicationPageHandlerPort<"profile">["reconcile"]>[0];
        const result = await completeWorkdayProfilePage(
          request.ownerSources.profilePlan,
          new PlaywrightWorkdayProfilePage(page, {
            pageType: request.ownerSources.profilePlan.pageType,
            timeoutMs: this.#timeoutMs,
          }),
          signal,
        );
        if (result.kind !== "verified" || result.ownedDuplicateRows !== 0) {
          throw new TypeError("profile reconciliation denied");
        }
        this.#acceptances.record(Object.freeze({
          schemaVersion: 1,
          checkpoint: "profile_verified",
          pageType: result.pageType,
          verifiedFields: result.verifiedFields,
          ownedDuplicateRows: 0,
          independentlyVerified: true,
          submitActivated: false,
          privacyScan: "pass",
        }));
        this.#recordProfileReviewExpectations(request, result.verifiedFields);
        return verified("profile", "profile_verified", input.pageId);
      }
      case "reconcile_questionnaire":
        return this.#reconcileQuestionnaire(
          page,
          operation.input as Parameters<ApplicationPageHandlerPort<"questionnaire">["reconcile"]>[0],
          request,
          session,
          signal,
        );
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded" });
        return undefined;
      case "review_expectations":
        return Object.freeze([...this.#reviewExpected.values()]);
      case "capture_review": {
        const application = await new PlaywrightWorkdayApplicationPage(
          page,
          { timeoutMs: this.#timeoutMs },
        ).observe(signal);
        if (!application.ok || application.value.page !== "pre_review" ||
            application.value.submitActivated) throw new TypeError("Review page is unavailable");
        const review = await captureIndependentReviewFields(page, this.#reviewExpected);
        return Object.freeze({
          application: application.value,
          structure: await captureReviewStructure(page),
          review,
        });
      }
    }
  }

  async #reconcileQuestionnaire(
    page: Page,
    input: Parameters<ApplicationPageHandlerPort<"questionnaire">["reconcile"]>[0],
    request: Stage2ApplicationWalkRuntimeBindingRequest,
    session: LiveBrowserSessionV1,
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
      const facts = structuralObservations(snapshot.fields, request.owner.revisionId);
      const questionnaire = createQuestionnairePageHandler({
        profileQuery: request.ownerSources.profileQuery,
        driver: createFieldDriver(semantic, createSafetyGuard()),
        verifier: createFieldVerifier(semantic),
        narrative: request.ownerSources.narrative,
        nextOperationId: this.#nextOperationId,
        allocateCandidateId: () => `unknown_candidate_${randomBytes(12).toString("hex")}` as never,
        observationFor: (fieldId, layer) => facts.get(`${fieldId}:${layer}`),
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
      if (!completed.ok || completed.value.kind !== "verified" ||
          completed.value.protectedPlaceholderCount !== 0) {
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
    verifiedFields: readonly { readonly fieldId: string; readonly provenance: string }[],
  ): void {
    const plans = [
      ...request.ownerSources.profilePlan.fields,
      ...request.ownerSources.profilePlan.repeatables.flatMap(({ rows }) =>
        rows.flatMap(({ fields }) => fields)
      ),
    ];
    for (const verifiedField of verifiedFields) {
      const candidates = plans.filter(({ fieldId: planned }) => planned === verifiedField.fieldId);
      if (candidates.length !== 1 || candidates[0]?.answer.kind !== "answered") {
        throw new TypeError("profile review truth unavailable");
      }
      const plan = candidates[0];
      if (plan.answer.kind !== "answered") throw new TypeError("profile review truth unavailable");
      this.#recordReviewExpectation(
        verifiedField.fieldId,
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

function reviewReadbackValue(readback: BrowserReadback): string | undefined {
  if (readback.kind === "text") return readback.value;
  if (readback.kind === "selected") return readback.option ?? undefined;
  if (readback.kind === "checked") return readback.checked ? "true" : "false";
  return undefined;
}

function normalizeReviewValue(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
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
      "owner_provided", "resume_verified", "configured_template", "reviewed_catalog", "visible_option",
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
    },
  };
}

function playwrightPage(page: PersistentPage): Page {
  if (!("locator" in page) || !("evaluate" in page) || !("reload" in page)) {
    throw new TypeError("Playwright page capability unavailable");
  }
  return page as Page;
}

async function bindQuestionnaireTargets(page: Page, pageId: BrowserPageId): Promise<void> {
  const result = await page.evaluate((declaredPageId) => {
    const roots = document.querySelectorAll('[data-automation-id="applyFlowApplicationQuestionsPage"]');
    if (roots.length !== 1) return false;
    document.documentElement.setAttribute("data-hunt-page-id", declaredPageId);
    const controls = roots[0]!.querySelectorAll<HTMLElement>(
      'fieldset, input:not([type="hidden"]), textarea, select, [role="listbox"], button',
    );
    let index = 0;
    for (const control of controls) {
      if (control instanceof HTMLInputElement && control.type === "radio" &&
          control.closest("fieldset") !== null) continue;
      const normalize = (value: string | null | undefined) =>
        (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
      let label = normalize(control.getAttribute("aria-label"));
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
      control.setAttribute("data-hunt-target-token", reviewed[label] ?? `target-unreviewed-${index}`);
      index += 1;
    }
    return index > 0 && index <= 128;
  }, pageId);
  if (!result) throw new TypeError("questionnaire control binding denied");
}

function structuralObservations(
  fields: readonly { readonly fieldId: FieldId; readonly required: boolean; readonly options: readonly unknown[] }[],
  revisionId: string,
): ReadonlyMap<string, SanitizedStructuralObservationV1> {
  const values = new Map<string, SanitizedStructuralObservationV1>();
  for (const [index, field] of fields.entries()) {
    for (const layer of ["question", "visible_option"] as const) {
      values.set(`${field.fieldId}:${layer}`, Object.freeze({
        schemaVersion: 1,
        observationId: `structural_observation_${index}_${layer}` as never,
        layer,
        sourceRevisionId: revisionId as never,
        parentLineage: Object.freeze([]),
        traitIds: Object.freeze([
          `structural_trait_required_${field.required ? "yes" : "no"}` as never,
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
