import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Page } from "playwright";

import {
  createApplicationLaneAcceptanceCollector,
  type ApplicationLaneAcceptance,
} from "../ats/workday/application/lane-composition.ts";
import { PlaywrightWorkdayApplicationPage } from "../ats/workday/application/playwright-page.ts";
import {
  completeWorkdayProfilePage,
  PlaywrightWorkdayProfilePage,
} from "../ats/workday/application/profile/index.ts";
import {
  createQuestionnairePageHandler,
} from "../ats/workday/application/questions/index.ts";
import {
  createPlaywrightWorkdayResumePage,
  createWorkdayResumeUploadDriver,
  createWorkdayResumeUploadHandler,
  createWorkdayResumeVerifier,
} from "../ats/workday/application/resume/index.ts";
import type {
  ApplicationPage,
  ApplicationPageCheck,
  ApplicationPageHandlerPort,
  ApplicationPortFailure,
  ApplicationWalkDependencies,
} from "../ats/workday/application/page-walk.ts";
import type { ApplicationWalkResume } from "../ats/workday/application/page-walk.ts";
import { inspectPage } from "../browser/adapter.ts";
import { createPlaywrightPersistentBrowserSession } from "../browser/playwright-live/index.ts";
import {
  ownedApplicationPageAccess,
  suspendOwnedApplicationSession,
  type OwnedApplicationOperation,
  type OwnedApplicationPageAdapter,
  type OwnedApplicationPageCapability,
  type OwnedApplicationPageRequest,
} from "../browser/playwright-live/private/application-page-types.ts";
import type { PersistentPage } from "../browser/playwright-live/private/types.ts";
import { PlaywrightBrowserSession } from "../browser/session.ts";
import {
  browserPageId,
  browserTargetToken,
  boundedText,
  createGeneratedIdAllocator,
  generatedOperationId,
  guardRevision,
  fieldId,
  type BrowserPageId,
  type BrowserSessionId,
  type FieldId,
  type OperationId,
} from "../contracts/index.ts";
import type { BrowserReadback, SemanticPageSnapshot } from "../contracts/index.ts";
import type {
  LiveBrowserSessionV1,
  LivePortResult,
  PersistentBrowserCloseRequest,
  PersistentBrowserErrorCode,
  PersistentBrowserOpenRequest,
  PersistentBrowserOpenResult,
  PersistentBrowserReconcileRequest,
  PersistentBrowserReconcileResult,
  ProfileLeaseId,
  TargetHostId,
  TargetIdentityV1,
  TargetPostingId,
  TargetTenantId,
} from "../contracts/live/index.ts";
import type { SanitizedStructuralObservationV1 } from "../contracts/live/index.ts";
import { s2StableErrorPolicy } from "../contracts/s2-common-wire.ts";
import { discoverFields } from "../form/discovery/discover-fields.ts";
import { createSemanticSnapshot } from "../form/semantic-snapshot.ts";
import { createFieldDriver } from "../interaction/drivers/registry.ts";
import {
  workdayReviewSignatures,
  type ReviewReadOnlyLocator,
  type ReviewReadOnlyPage,
  type WorkdayReviewStructuralObservationV1,
} from "../interaction/review/index.ts";
import { createFieldVerifier } from "../interaction/verification/field-verifier.ts";
import type {
  RecoveryBrowserPageTruth,
  RecoveryCheckpoint,
  RecoveryDependencies,
  RecoveryReconciliationRecord,
  RecoveryTerminal,
} from "../journey/recovery/index.ts";
import { createSafetyGuard } from "../safety/guards.ts";
import type {
  Stage2ApplicationWalkRuntimeBindingRequest,
} from "../composition/s2-application-walk-runner.ts";
import { readStablePrivateFile } from "../composition/private/s2-stable-private-file.ts";
import type {
  Stage2RealJourneyLiveRuntimeBinding,
} from "./s2-production-binding.ts";

interface OwnedApplicationBrowser extends OwnedApplicationPageCapability {
  open(
    request: PersistentBrowserOpenRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<PersistentBrowserOpenResult, PersistentBrowserErrorCode>>;
  reconcile(
    request: PersistentBrowserReconcileRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<PersistentBrowserReconcileResult, PersistentBrowserErrorCode>>;
  close(
    request: PersistentBrowserCloseRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
}

export interface Stage2PlaywrightRuntimeOptions {
  readonly browser?: (
    request: Stage2ApplicationWalkRuntimeBindingRequest,
    adapter: OwnedApplicationPageAdapter,
  ) => OwnedApplicationBrowser;
  readonly now?: () => string;
  readonly nextOperationId?: () => OperationId;
  readonly timeoutMs?: number;
}

const runtimeRevision = guardRevision("s2-playwright-runtime-v1");

export function createStage2PlaywrightLiveRuntimeBinding(
  options: Stage2PlaywrightRuntimeOptions = {},
): Stage2RealJourneyLiveRuntimeBinding {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? (() => new Date().toISOString());
  const nextOperationId = options.nextOperationId ?? operationId;
  return Object.freeze({
    async bind(
      request: Stage2ApplicationWalkRuntimeBindingRequest,
      signal: AbortSignal,
    ) {
      if (signal.aborted) throw new TypeError("Playwright runtime binding denied");
      const target = targetFor(request);
      const store = new RecoveryFileStore(
        request.owner.roots.runtime.path,
        `${request.owner.revisionId}.recovery.json`,
      );
      const initialRecovery = store.load();
      const acceptances = createApplicationLaneAcceptanceCollector();
      const adapter = new Stage2PlaywrightApplicationAdapter({
        request,
        acceptances,
        nextOperationId,
        timeoutMs,
      });
      adapter.restoreReviewExpectations(initialRecovery?.reviewExpected ?? []);
      const browser = options.browser?.(request, adapter) ??
        createPlaywrightPersistentBrowserSession({
          binding: request.ownerBinding,
          timeoutMs,
          applicationPage: adapter,
        });
      const opened = await browser.open({
        schemaVersion: 1,
        journeyId: request.owner.journeyId as never,
        operationId: nextOperationId(),
        profileLeaseId: profileLeaseFor(request.owner.profileRef),
        target,
      }, signal);
      if (!opened.ok) throw new TypeError("Playwright runtime binding denied");

      const session = opened.value.session;
      adapter.bindSession(session);
      let checkpointRevision = initialRecovery?.checkpoint.revision ?? 0;
      let lastObservedPageId: BrowserPageId | undefined;
      const access = async <Value>(
        operation: OwnedApplicationOperation,
        activeSignal: AbortSignal,
      ): Promise<LivePortResult<Value, PersistentBrowserErrorCode>> =>
        await browser[ownedApplicationPageAccess]({
        schemaVersion: 1,
        journeyId: session.journeyId,
        operationId: nextOperationId(),
        sessionId: session.sessionId,
        target,
        now: now(),
      }, operation, activeSignal) as LivePortResult<Value, PersistentBrowserErrorCode>;

      const observer = Object.freeze({
        async observe(activeSignal: AbortSignal) {
          const result = await access<Awaited<ReturnType<PlaywrightWorkdayApplicationPage["observe"]>>>(
            { kind: "observe" }, activeSignal,
          );
          if (!result.ok) return applicationFailure(result.error.code, "page_observation", "ui_behavior");
          if (result.value.ok) lastObservedPageId = result.value.value.pageId;
          return result.value;
        },
      });
      const navigation = Object.freeze({
        async next(
          input: Parameters<ApplicationWalkDependencies["navigation"]["next"]>[0],
          activeSignal: AbortSignal,
        ) {
          const result = await access<Awaited<ReturnType<PlaywrightWorkdayApplicationPage["next"]>>>(
            { kind: "next", input }, activeSignal,
          );
          return result.ok ? result.value : applicationFailure(result.error.code, "next", "navigation");
        },
      });
      const handlers = applicationHandlers({
        access,
      });
      const progress = Object.freeze({
        async record(
          progress: Parameters<ApplicationWalkDependencies["progress"]["record"]>[0],
          activeSignal: AbortSignal,
        ) {
          if (activeSignal.aborted) {
            return applicationFailure("operation_cancelled", "record", "none");
          }
          if (progress.browserPage === "resume") return { ok: true as const, value: undefined };
          const pageKind = recoveryPage(progress.browserPage);
          if (pageKind === undefined) {
            return applicationFailure("failure_context_invalid", "record", "page_type");
          }
          if (lastObservedPageId === undefined) {
            return applicationFailure("failure_context_invalid", "record", "page_type");
          }
          const state: RecoveryCheckpoint = Object.freeze({
            schemaVersion: 1,
            journeyId: session.journeyId,
            sourceRevision: request.owner.revisionId as never,
            revision: checkpointRevision + 1,
            target,
            page: Object.freeze({
              id: lastObservedPageId,
              kind: pageKind,
            }),
            verification: "verified",
            terminal: null,
          });
          if (!store.save(
            checkpointRevision,
            state,
            progress.pageChecks,
            adapter.reviewExpectations(),
          )) {
            return applicationFailure("recovery_state_ambiguous", "record", "none");
          }
          checkpointRevision = state.revision;
          return { ok: true as const, value: undefined };
        },
      });

      return Object.freeze({
        walk: Object.freeze({ observer, navigation, handlers, progress }),
        laneAcceptances: acceptances,
        recovery: Object.freeze({
          async pending(activeSignal: AbortSignal) {
            const artifact = store.load();
            if (artifact === null) return null;
            const checkpoint = artifact.checkpoint;
            const dependencies = recoveryDependencies({
              browser,
              session,
              target,
              store,
              access,
              nextOperationId,
              onStateSaved: (revision) => { checkpointRevision = revision; },
            });
            return Object.freeze({
              input: Object.freeze({
                schemaVersion: 1 as const,
                journeyId: session.journeyId,
                sourceRevision: request.owner.revisionId as never,
                expectedTarget: target,
                operationId: nextOperationId(),
                interruption: Object.freeze({
                  code: "process_interrupted" as const,
                  effect: "none" as const,
                }),
              }),
              dependencies,
              resume: resumeFromArtifact(artifact),
            });
          },
        }),
        review: Object.freeze({
          async capture(activeSignal: AbortSignal) {
            const captured = await access<{
              readonly application: { readonly pageId: BrowserPageId };
              readonly structure: WorkdayReviewStructuralObservationV1;
              readonly review: {
                readonly page: SemanticPageSnapshot;
                readonly verification: readonly { readonly kind: "verified"; readonly fieldId: FieldId }[];
              };
            }>({ kind: "capture_review" }, activeSignal);
            if (!captured.ok) throw new TypeError("Review capture denied");
            const pageId = captured.value.application.pageId;
            return Object.freeze({
              page: reviewSnapshotPage(captured.value.structure),
              request: Object.freeze({
                  state: Object.freeze({
                    schemaVersion: 3 as const,
                    journeyId: session.journeyId,
                    status: "running" as const,
                    pageId,
                    revision: checkpointRevision,
                  }),
                  operationId: nextOperationId(),
                  pageId,
                  page: captured.value.review.page,
                  verification: captured.value.review.verification,
                  completion: Object.freeze({
                    kind: "complete" as const,
                    decision: Object.freeze({ kind: "stop_review" as const }),
                  }),
              }),
            });
          },
        }),
        privacy: Object.freeze({
          async forbiddenTokens(activeSignal: AbortSignal) {
            return adapter.forbiddenTokens(activeSignal);
          },
        }),
        cleanup: Object.freeze({
          async close(activeSignal: AbortSignal, accepted?: boolean) {
            const closeRequest = {
              schemaVersion: 1,
              journeyId: session.journeyId,
              operationId: nextOperationId(),
              sessionId: session.sessionId,
            } as const;
            try {
              const closed = accepted === false
                ? await browser[suspendOwnedApplicationSession](closeRequest, activeSignal)
                : await browser.close(closeRequest, activeSignal);
              if (!closed.ok) return false;
              if (accepted === true) store.finalize();
              return true;
            } finally {
              adapter.dispose();
            }
          },
        }),
      });
    },
  });
}

function forbiddenCorpus(
  bindingValues: readonly string[],
  sourceValues: readonly string[],
): readonly string[] {
  const valid = (value: string) => value.length >= 3 && value.length <= 512;
  const binding = [...new Set(bindingValues.filter(valid))];
  if (binding.length > 32) throw new TypeError("privacy binding corpus denied");
  // Live evidence is a closed value-free schema; the corpus is an additional
  // substring tripwire. Prefer the longest unique owner values within its
  // contract bound because short values are both ambiguous and inadmissible.
  const sources = [...new Set(sourceValues.filter(valid))]
    .filter((value) => !binding.includes(value))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  return Object.freeze([...binding, ...sources.slice(0, 32 - binding.length)]);
}

function applicationHandlers(options: {
  readonly access: <Value>(operation: OwnedApplicationOperation, signal: AbortSignal) => Promise<LivePortResult<Value, PersistentBrowserErrorCode>>;
}): ApplicationWalkDependencies["handlers"] {
  return Object.freeze({
    resume: handler("resume", async (request, signal) => {
      const used = await options.access<Awaited<ReturnType<ApplicationPageHandlerPort<"resume">["reconcile"]>>>(
        { kind: "reconcile_resume", input: request }, signal,
      );
      return used.ok ? used.value : applicationFailure(used.error.code, "file_upload", "ui_behavior");
    }),
    profile: handler("profile", async (request, signal) => {
      const used = await options.access<Awaited<ReturnType<ApplicationPageHandlerPort<"profile">["reconcile"]>>>(
        { kind: "reconcile_profile", input: request }, signal,
      );
      return used.ok ? used.value : applicationFailure(used.error.code, "profile_control", "ui_behavior");
    }),
    questionnaire: handler("questionnaire", async (request, signal) => {
      const used = await options.access<Awaited<ReturnType<ApplicationPageHandlerPort<"questionnaire">["reconcile"]>>>(
        { kind: "reconcile_questionnaire", input: request }, signal,
      );
      return used.ok ? used.value : applicationFailure(used.error.code, "question_control", "ui_behavior");
    }),
  });
}

class Stage2PlaywrightApplicationAdapter implements OwnedApplicationPageAdapter {
  #request: Stage2ApplicationWalkRuntimeBindingRequest | undefined;
  #session: LiveBrowserSessionV1 | undefined;
  readonly #acceptances: ReturnType<typeof createApplicationLaneAcceptanceCollector>;
  readonly #nextOperationId: () => OperationId;
  readonly #timeoutMs: number;
  readonly #reviewExpected = new Map<string, ReviewExpectedField>();

  constructor(options: {
    readonly request: Stage2ApplicationWalkRuntimeBindingRequest;
    readonly acceptances: ReturnType<typeof createApplicationLaneAcceptanceCollector>;
    readonly nextOperationId: () => OperationId;
    readonly timeoutMs: number;
  }) {
    this.#request = options.request;
    this.#acceptances = options.acceptances;
    this.#nextOperationId = options.nextOperationId;
    this.#timeoutMs = options.timeoutMs;
  }

  bindSession(session: LiveBrowserSessionV1): void {
    if (this.#session !== undefined) throw new TypeError("application adapter already bound");
    this.#session = session;
  }

  dispose(): void {
    this.#request = undefined;
    this.#session = undefined;
  }

  reviewExpectations(): readonly ReviewExpectedField[] {
    return Object.freeze([...this.#reviewExpected.values()]);
  }

  restoreReviewExpectations(values: readonly ReviewExpectedField[]): void {
    if (this.#reviewExpected.size !== 0) throw new TypeError("review expectations already bound");
    for (const value of values) {
      if (!isReviewExpectedField(value) || this.#reviewExpected.has(value.fieldId)) {
        throw new TypeError("review expectation recovery denied");
      }
      this.#reviewExpected.set(value.fieldId, Object.freeze({ ...value }));
    }
  }

  forbiddenTokens(signal: AbortSignal): readonly string[] {
    const request = this.#request;
    if (signal.aborted || request === undefined) throw new TypeError("privacy source revoked");
    return forbiddenCorpus([
      request.owner.target.url,
      request.owner.target.host,
      request.owner.target.tenant,
      request.owner.target.posting,
      request.owner.roots.runtime.path,
      request.owner.roots.secrets.path,
      request.owner.roots.evidence.path,
    ], request.ownerSources.sensitiveValues);
  }

  async execute(
    ownedPage: PersistentPage,
    operation: OwnedApplicationOperation,
    signal: AbortSignal,
  ): Promise<unknown> {
    const page = playwrightPage(ownedPage);
    const request = this.#request;
    const session = this.#session;
    if (request === undefined || session === undefined || signal.aborted) {
      throw new TypeError("application adapter revoked");
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
    for (const verified of verifiedFields) {
      const candidates = plans.filter(({ fieldId: planned }) => planned === verified.fieldId);
      if (candidates.length !== 1 || candidates[0]?.answer.kind !== "answered") {
        throw new TypeError("profile review truth unavailable");
      }
      const plan = candidates[0];
      if (plan.answer.kind !== "answered") throw new TypeError("profile review truth unavailable");
      const value = plan.optionMapping?.visibleOption ?? plan.answer.value;
      this.#recordReviewExpectation(verified.fieldId, verified.provenance, value);
    }
  }

  #recordReviewExpectation(field: string, provenance: string, value: string): void {
    if (this.#reviewExpected.has(field)) throw new TypeError("review field ambiguous");
    const normalized = normalizeReviewValue(value);
    if (normalized === "") throw new TypeError("review field value unavailable");
    this.#reviewExpected.set(field, Object.freeze({
      fieldId: field,
      provenance,
      valueSha256: createHash("sha256").update(normalized, "utf8").digest("hex"),
    }));
  }
}

interface ReviewExpectedField {
  readonly fieldId: string;
  readonly provenance: string;
  readonly valueSha256: string;
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
      const fact = expected.get(id);
      if (fact === undefined || seen.has(id) || value === "" ||
          createHash("sha256").update(value, "utf8").digest("hex") !== fact.valueSha256 ||
          fact.provenance.length === 0) throw new TypeError("Review field mismatch");
      seen.add(id);
    }
  } else {
    const realRows = page.locator(
      '[data-automation-id="applyFlowReviewPage"] [data-automation-id^="formField-"]',
    );
    const realCount = await realRows.count();
    const byHash = new Map<string, ReviewExpectedField>();
    for (const fact of expected.values()) {
      if (byHash.has(fact.valueSha256)) throw new TypeError("Review values ambiguous");
      byHash.set(fact.valueSha256, fact);
    }
    if (realCount < 1 || realCount > 128) throw new TypeError("Review rows unavailable");
    for (let index = 0; index < realCount; index += 1) {
      const values = await realRows.nth(index).evaluate((root) => {
        const leaves = [...root.querySelectorAll<HTMLElement>("*")]
          .filter((element) => element.children.length === 0)
          .map((element) => element.textContent ?? "");
        return leaves.length === 0 ? [root.textContent ?? ""] : leaves;
      });
      const matched = new Set<string>();
      for (const raw of values) {
        const normalized = normalizeReviewValue(raw);
        if (normalized === "") continue;
        const fact = byHash.get(createHash("sha256").update(normalized, "utf8").digest("hex"));
        if (fact !== undefined) matched.add(fact.fieldId);
      }
      if (matched.size === 0) throw new TypeError("Unknown Review row");
      for (const id of matched) {
        if (seen.has(id)) throw new TypeError("Review field ambiguous");
        seen.add(id);
      }
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
    verification: Object.freeze(fields.map(({ fieldId }) => Object.freeze({
      kind: "verified" as const,
      fieldId,
    }))),
  });
}

function handler<PageKind extends "resume" | "profile" | "questionnaire">(
  _page: PageKind,
  reconcile: ApplicationPageHandlerPort<PageKind>["reconcile"],
): ApplicationPageHandlerPort<PageKind> {
  return Object.freeze({ reconcile });
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

function targetFor(request: Stage2ApplicationWalkRuntimeBindingRequest): TargetIdentityV1 {
  const suffix = opaqueSuffix(request.owner.target.handleId, "target_ref_");
  return Object.freeze({
    schemaVersion: 1,
    atsFamily: "workday",
    hostId: `host_${suffix}` as TargetHostId,
    tenantId: `tenant_${suffix}` as TargetTenantId,
    postingId: `posting_${suffix}` as TargetPostingId,
  });
}

function profileLeaseFor(profileRef: string): ProfileLeaseId {
  return `profile_lease_${opaqueSuffix(profileRef, "profile_ref_")}` as ProfileLeaseId;
}

function opaqueSuffix(value: string, prefix: string): string {
  const suffix = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(suffix)) throw new TypeError("opaque binding denied");
  return suffix;
}

function operationId(): OperationId {
  return generatedOperationId(`operation_${randomBytes(16).toString("hex")}`);
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
      control.setAttribute(
        "data-hunt-target-token",
        reviewed[label] ?? `target-unreviewed-${index}`,
      );
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

function recoveryPage(page: ApplicationPage): RecoveryCheckpoint["page"]["kind"] | undefined {
  if (page === "profile" || page === "questionnaire") return page;
  if (page === "pre_review") return "review";
  return undefined;
}

function recoveryDependencies(options: {
  readonly browser: OwnedApplicationBrowser;
  readonly session: LiveBrowserSessionV1;
  readonly target: TargetIdentityV1;
  readonly store: RecoveryFileStore;
  readonly access: <Value>(operation: OwnedApplicationOperation, signal: AbortSignal) => Promise<LivePortResult<Value, PersistentBrowserErrorCode>>;
  readonly nextOperationId: () => OperationId;
  readonly onStateSaved: (revision: number) => void;
}): RecoveryDependencies {
  const state = {
    load: async () => ({
      ok: true as const,
      value: options.store.load()?.checkpoint ?? null,
    }),
    save: async (request: Parameters<RecoveryDependencies["state"]["save"]>[0]) => {
      if (!options.store.save(request.expectedRevision, request.state)) {
        return recoveryFailure("recovery_state_ambiguous");
      }
      options.onStateSaved(request.state.revision);
      return { ok: true as const, value: request.state };
    },
  };
  return Object.freeze({
    state,
    browser: Object.freeze({
      async inspect(signal: AbortSignal) {
        const inspected = await options.access<Awaited<ReturnType<PlaywrightWorkdayApplicationPage["observe"]>>>(
          { kind: "inspect_recovery" }, signal,
        );
        if (inspected.ok) {
          const truth = inspected.value;
          if (!truth.ok) return recoveryFailure("browser_target_stale");
          const kind = recoveryPage(truth.value.page);
          const value: RecoveryBrowserPageTruth = Object.freeze({
            page: Object.freeze({
              id: truth.value.pageId,
              kind: kind ?? "unknown",
            }),
            target: options.target,
            verification: "verified",
            surface: "primary",
          });
          return { ok: true as const, value: Object.freeze({ pages: Object.freeze([value]) }) };
        }
        return recoveryFailure(inspected.error.code);
      },
      async reload(signal: AbortSignal) {
        const reloaded = await options.access({ kind: "reload" }, signal);
        return reloaded.ok ? { ok: true as const, value: undefined } : recoveryFailure(reloaded.error.code);
      },
      async reattach(signal: AbortSignal) {
        const reconciled = await options.browser.reconcile({
          schemaVersion: 1,
          journeyId: options.session.journeyId,
          operationId: options.nextOperationId(),
          session: options.session,
          expectedTarget: options.target,
        }, signal);
        return reconciled.ok && reconciled.value.kind === "matched"
          ? { ok: true as const, value: undefined }
          : recoveryFailure(reconciled.ok ? "browser_target_invalid" : reconciled.error.code);
      },
    }),
    reconciliation: Object.freeze({
      async record(request: { readonly record: RecoveryReconciliationRecord }) {
        return options.store.record(request.record)
          ? { ok: true as const, value: undefined }
          : recoveryFailure("recovery_state_ambiguous");
      },
    }),
    terminal: Object.freeze({
      async commit(request: { readonly terminal: RecoveryTerminal }) {
        return options.store.commitTerminal(request.terminal)
          ? { ok: true as const, value: request.terminal }
          : recoveryFailure("recovery_state_ambiguous");
      },
    }),
  });
}

function recoveryFailure(code: string) {
  return { ok: false as const, error: { code: code as never } };
}

async function captureReviewStructure(page: Page): Promise<WorkdayReviewStructuralObservationV1> {
  const root = page.locator(workdayReviewSignatures.reviewRoot);
  const active = page.locator(workdayReviewSignatures.activeStep);
  const errors = page.locator(workdayReviewSignatures.validationError);
  const submit = root.getByRole("button", { name: workdayReviewSignatures.finalSubmitName });
  const [rootCount, activeCount, errorCount, submitCount] = await Promise.all([
    root.count(), active.count(), errors.count(), submit.count(),
  ]);
  if ([rootCount, activeCount, errorCount, submitCount].some((count) =>
    !Number.isInteger(count) || count < 0 || count > 64
  )) throw new TypeError("Review structure denied");
  return Object.freeze({
    schemaVersion: 1,
    reviewRoot: Object.freeze({
      count: rootCount,
      visible: rootCount === 1 && await root.isVisible(),
    }),
    activeStep: Object.freeze({
      count: activeCount,
      visible: activeCount === 1 && await active.isVisible(),
    }),
    validationErrorCount: errorCount,
    finalSubmit: Object.freeze({
      count: submitCount,
      visible: submitCount === 1 && await submit.isVisible(),
      enabled: submitCount === 1 && await submit.isEnabled(),
    }),
  });
}

function reviewSnapshotPage(value: WorkdayReviewStructuralObservationV1): ReviewReadOnlyPage {
  return Object.freeze({
    locator(selector: string): ReviewReadOnlyLocator {
      if (selector === workdayReviewSignatures.reviewRoot) {
        return snapshotLocator(value.reviewRoot.count, value.reviewRoot.visible, false, value.finalSubmit);
      }
      if (selector === workdayReviewSignatures.activeStep) {
        return snapshotLocator(value.activeStep.count, value.activeStep.visible, false);
      }
      if (selector === workdayReviewSignatures.validationError) {
        return snapshotLocator(value.validationErrorCount, value.validationErrorCount > 0, false);
      }
      return snapshotLocator(0, false, false);
    },
  });
}

function snapshotLocator(
  count: number,
  visible: boolean,
  enabled: boolean,
  nested?: WorkdayReviewStructuralObservationV1["finalSubmit"],
): ReviewReadOnlyLocator {
  return Object.freeze({
    count: async () => count,
    isVisible: async () => visible,
    isEnabled: async () => enabled,
    getByRole: () => nested === undefined
      ? snapshotLocator(0, false, false)
      : snapshotLocator(nested.count, nested.visible, nested.enabled),
  });
}

interface RecoveryArtifactV1 {
  readonly schemaVersion: 1;
  readonly checkpoint: RecoveryCheckpoint;
  readonly pageChecks: readonly ApplicationPageCheck[];
  readonly reviewExpected: readonly ReviewExpectedField[];
}

function resumeFromArtifact(artifact: RecoveryArtifactV1): ApplicationWalkResume {
  const currentPage = artifact.checkpoint.page.kind === "review"
    ? "pre_review"
    : artifact.checkpoint.page.kind;
  if (currentPage !== "profile" && currentPage !== "questionnaire" &&
      currentPage !== "pre_review") {
    throw new TypeError("recovery progress denied");
  }
  return Object.freeze({ currentPage, pageChecks: artifact.pageChecks });
}

class RecoveryFileStore {
  readonly #root: string;
  readonly #directory: string;
  readonly #path: string;
  readonly #recordPath: string;

  constructor(root: string, file: string) {
    if (!/^revision_[A-Za-z0-9_-]{16,64}\.recovery\.json$/u.test(file)) {
      throw new TypeError("recovery coordinate denied");
    }
    this.#root = realpathSync.native(root);
    this.#directory = join(this.#root, "stage2-acceptance");
    mkdirSync(this.#directory, { recursive: true });
    this.#path = join(this.#directory, file);
    this.#recordPath = `${this.#path}.reconciliation`;
    this.#assertBoundary();
  }

  load(): RecoveryArtifactV1 | null {
    this.#assertBoundary();
    if (!existsSync(this.#path)) {
      if (existsSync(this.#recordPath) || readdirSync(this.#directory).some((name) =>
        name.startsWith(`${this.#fileName()}.`) && name.endsWith(".tmp")
      )) throw new TypeError("recovery artifact ambiguous");
      return null;
    }
    const stable = readStablePrivateFile(this.#path, 64 * 1024);
    try {
      const value: unknown = JSON.parse(stable.bytes.toString("utf8"));
      if (!isRecoveryArtifact(value)) throw new TypeError("recovery artifact denied");
      return value;
    } finally {
      stable.bytes.fill(0);
    }
  }

  save(
    expectedRevision: number,
    state: RecoveryCheckpoint,
    pageChecks?: readonly ApplicationPageCheck[],
    reviewExpected?: readonly ReviewExpectedField[],
  ): boolean {
    const current = this.load();
    if ((current?.checkpoint.revision ?? 0) !== expectedRevision ||
        state.revision !== expectedRevision + 1) {
      return false;
    }
    const checks = pageChecks ?? current?.pageChecks;
    const expected = reviewExpected ?? current?.reviewExpected;
    if (checks === undefined || expected === undefined) return false;
    return this.#write(this.#path, Object.freeze({
      schemaVersion: 1 as const,
      checkpoint: state,
      pageChecks: Object.freeze([...checks]),
      reviewExpected: Object.freeze([...expected]),
    }));
  }

  record(value: RecoveryReconciliationRecord): boolean {
    return this.#write(this.#recordPath, value);
  }

  commitTerminal(terminal: RecoveryTerminal): boolean {
    const current = this.load();
    return current !== null && this.#write(this.#path, {
      ...current,
      checkpoint: { ...current.checkpoint, terminal },
    });
  }

  finalize(): void {
    this.#assertBoundary();
    rmSync(this.#path, { force: true });
    rmSync(this.#recordPath, { force: true });
  }

  #write(path: string, value: unknown): boolean {
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      this.#assertBoundary();
      writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
      this.#assertBoundary();
      renameSync(temporary, path);
      return true;
    } catch {
      rmSync(temporary, { force: true });
      return false;
    }
  }

  #assertBoundary(): void {
    const directory = lstatSync(this.#directory);
    if (
      directory.isSymbolicLink() ||
      !directory.isDirectory() ||
      realpathSync.native(this.#directory) !== resolve(this.#directory) ||
      dirname(this.#directory) !== this.#root
    ) throw new TypeError("recovery storage denied");
    for (const path of [this.#path, this.#recordPath]) {
      if (!existsSync(path)) continue;
      const item = lstatSync(path);
      if (
        item.isSymbolicLink() ||
        !statSync(path).isFile() ||
        realpathSync.native(path) !== resolve(path) ||
        dirname(path) !== this.#directory
      ) throw new TypeError("recovery storage denied");
    }
  }

  #fileName(): string {
    return this.#path.slice(this.#directory.length + 1);
  }
}

function isRecoveryArtifact(value: unknown): value is RecoveryArtifactV1 {
  if (typeof value !== "object" || value === null) return false;
  const artifact = value as Partial<RecoveryArtifactV1>;
  if (!hasExactKeys(value, ["schemaVersion", "checkpoint", "pageChecks", "reviewExpected"])) {
    return false;
  }
  if (artifact.schemaVersion !== 1 || !Array.isArray(artifact.pageChecks) ||
      !Array.isArray(artifact.reviewExpected) ||
      !isRecoveryCheckpoint(artifact.checkpoint)) return false;
  const expectedPage = artifact.checkpoint.page.kind === "profile" ? "profile"
    : artifact.checkpoint.page.kind === "questionnaire" ? "questionnaire"
    : artifact.checkpoint.page.kind === "review" ? "pre_review" : undefined;
  if (expectedPage === undefined) return false;
  const expectedCount = expectedPage === "profile" ? 2 : 3;
  if (artifact.pageChecks.length !== expectedCount) return false;
  return artifact.pageChecks.every((check, index) => {
    if (typeof check !== "object" || check === null) return false;
    const page = ["resume", "profile", "questionnaire"][index];
    const checkpoint = ["resume_verified", "profile_verified", "questionnaire_verified"][index];
    const item = check as Partial<ApplicationPageCheck>;
    return hasExactKeys(check, [
      "page", "checkpoint", "independentlyVerified", "requiredFields",
      "verifiedFields", "duplicateRows",
    ]) && item.page === page && item.checkpoint === checkpoint &&
      item.independentlyVerified === true &&
      Number.isSafeInteger(item.requiredFields) && (item.requiredFields ?? -1) >= 0 &&
      item.verifiedFields === item.requiredFields && item.duplicateRows === 0;
  }) && artifact.reviewExpected.length <= 128 &&
    new Set(artifact.reviewExpected.map(({ fieldId }) => fieldId)).size === artifact.reviewExpected.length &&
    artifact.reviewExpected.every(isReviewExpectedField);
}

function isReviewExpectedField(value: unknown): value is ReviewExpectedField {
  if (typeof value !== "object" || value === null) return false;
  const field = value as Partial<ReviewExpectedField>;
  return hasExactKeys(value, ["fieldId", "provenance", "valueSha256"]) &&
    typeof field.fieldId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(field.fieldId) &&
    typeof field.provenance === "string" && new Set([
      "owner_provided", "resume_verified", "configured_template", "reviewed_catalog", "visible_option",
    ]).has(field.provenance) &&
    typeof field.valueSha256 === "string" && /^[0-9a-f]{64}$/u.test(field.valueSha256);
}

function isRecoveryCheckpoint(value: unknown): value is RecoveryCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<RecoveryCheckpoint>;
  const target = checkpoint.target as Partial<TargetIdentityV1> | undefined;
  const page = checkpoint.page as Partial<RecoveryCheckpoint["page"]> | undefined;
  return hasExactKeys(value, [
    "schemaVersion", "journeyId", "sourceRevision", "revision", "target",
    "page", "verification", "terminal",
  ]) && checkpoint.schemaVersion === 1 &&
    typeof checkpoint.journeyId === "string" && /^journey_[A-Za-z0-9_-]{16,64}$/u.test(checkpoint.journeyId) &&
    typeof checkpoint.sourceRevision === "string" && /^revision_[A-Za-z0-9_-]{16,64}$/u.test(checkpoint.sourceRevision) &&
    Number.isSafeInteger(checkpoint.revision) && (checkpoint.revision ?? 0) > 0 &&
    checkpoint.verification === "verified" && checkpoint.terminal === null &&
    typeof target === "object" && target !== null && hasExactKeys(target, [
      "schemaVersion", "atsFamily", "hostId", "tenantId", "postingId",
    ]) && target.schemaVersion === 1 && target.atsFamily === "workday" &&
    typeof target.hostId === "string" && /^host_[A-Za-z0-9_-]{16,64}$/u.test(target.hostId) &&
    typeof target.tenantId === "string" && /^tenant_[A-Za-z0-9_-]{16,64}$/u.test(target.tenantId) &&
    typeof target.postingId === "string" && /^posting_[A-Za-z0-9_-]{16,64}$/u.test(target.postingId) &&
    typeof page === "object" && page !== null && hasExactKeys(page, ["id", "kind"]) &&
    typeof page.id === "string" && page.id.length >= 1 && page.id.length <= 128 &&
    typeof page.kind === "string" &&
    new Set(["profile", "questionnaire", "review"]).has(page.kind);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
