import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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
  ApplicationPageHandlerPort,
  ApplicationPortFailure,
  ApplicationWalkDependencies,
} from "../ats/workday/application/page-walk.ts";
import { inspectPage } from "../browser/adapter.ts";
import { createPlaywrightPersistentBrowserSession } from "../browser/playwright-live/index.ts";
import {
  ownedApplicationPageAccess,
  type OwnedApplicationPageCapability,
  type OwnedApplicationPageRequest,
} from "../browser/playwright-live/private/application-page-types.ts";
import type { PersistentPage } from "../browser/playwright-live/private/types.ts";
import { PlaywrightBrowserSession } from "../browser/session.ts";
import {
  browserPageId,
  createGeneratedIdAllocator,
  generatedOperationId,
  guardRevision,
  type BrowserPageId,
  type BrowserSessionId,
  type FieldId,
  type OperationId,
} from "../contracts/index.ts";
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
      const browser = options.browser?.(request) ??
        createPlaywrightPersistentBrowserSession({
          binding: request.ownerBinding,
          timeoutMs,
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
      const acceptances = createApplicationLaneAcceptanceCollector();
      let checkpointRevision = store.peek()?.revision ?? 0;
      let lastObservedPageId: BrowserPageId | undefined;
      const access = <Value>(
        effect: OwnedApplicationPageRequest["effect"],
        activeSignal: AbortSignal,
        use: (page: Page) => Promise<Value>,
      ) => browser[ownedApplicationPageAccess]({
        schemaVersion: 1,
        journeyId: session.journeyId,
        operationId: nextOperationId(),
        sessionId: session.sessionId,
        target,
        now: now(),
        effect,
      }, activeSignal, (page) => use(playwrightPage(page)));

      const observer = Object.freeze({
        async observe(activeSignal: AbortSignal) {
          const result = await access("read", activeSignal, (page) =>
            new PlaywrightWorkdayApplicationPage(page, { timeoutMs }).observe(activeSignal)
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
          const result = await access("mutation", activeSignal, (page) =>
            new PlaywrightWorkdayApplicationPage(page, { timeoutMs }).next(input, activeSignal)
          );
          return result.ok ? result.value : applicationFailure(result.error.code, "next", "navigation");
        },
      });
      const handlers = applicationHandlers({
        request,
        session,
        access,
        acceptances,
        nextOperationId,
        timeoutMs,
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
          if (!store.save(checkpointRevision, state)) {
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
            const checkpoint = store.peek();
            if (checkpoint === null) return null;
            const dependencies = recoveryDependencies({
              browser,
              session,
              target,
              store,
              access,
              nextOperationId,
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
            });
          },
        }),
        review: Object.freeze({
          async capture(activeSignal: AbortSignal) {
            const captured = await access("read", activeSignal, async (page) => {
              const application = await new PlaywrightWorkdayApplicationPage(
                page,
                { timeoutMs },
              ).observe(activeSignal);
              if (!application.ok || application.value.page !== "pre_review" ||
                  application.value.submitActivated) {
                throw new TypeError("Review page is unavailable");
              }
              const structure = await captureReviewStructure(page);
              const pageId = application.value.pageId;
              return Object.freeze({
                page: reviewSnapshotPage(structure),
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
                  page: Object.freeze({
                    pageIdentity: Object.freeze({ kind: "workday" as const, page: "review" as const }),
                    fields: Object.freeze([]),
                  }),
                  verification: Object.freeze([]),
                  completion: Object.freeze({
                    kind: "complete" as const,
                    decision: Object.freeze({ kind: "stop_review" as const }),
                  }),
                }),
              });
            });
            if (!captured.ok) throw new TypeError("Review capture denied");
            return captured.value;
          },
        }),
        privacy: Object.freeze({
          async forbiddenTokens(activeSignal: AbortSignal) {
            if (activeSignal.aborted) throw new TypeError("privacy scan cancelled");
            return forbiddenCorpus([
              request.owner.target.url,
              request.owner.target.host,
              request.owner.target.tenant,
              request.owner.target.posting,
              request.owner.roots.runtime.path,
              request.owner.roots.secrets.path,
              request.owner.roots.evidence.path,
            ], request.ownerSources.sensitiveValues);
          },
        }),
        cleanup: Object.freeze({
          async close(activeSignal: AbortSignal, accepted = false) {
            const closed = await browser.close({
              schemaVersion: 1,
              journeyId: session.journeyId,
              operationId: nextOperationId(),
              sessionId: session.sessionId,
            }, activeSignal);
            if (!closed.ok) return false;
            if (accepted) store.finalize();
            return true;
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
  readonly request: Stage2ApplicationWalkRuntimeBindingRequest;
  readonly session: LiveBrowserSessionV1;
  readonly access: <Value>(effect: "read" | "mutation", signal: AbortSignal, use: (page: Page) => Promise<Value>) => Promise<LivePortResult<Value, PersistentBrowserErrorCode>>;
  readonly acceptances: ReturnType<typeof createApplicationLaneAcceptanceCollector>;
  readonly nextOperationId: () => OperationId;
  readonly timeoutMs: number;
}): ApplicationWalkDependencies["handlers"] {
  return Object.freeze({
    resume: handler("resume", async (request, signal) => {
      const used = await options.access("mutation", signal, async (page) => {
        const resumePage = createPlaywrightWorkdayResumePage(page);
        const result = await createWorkdayResumeUploadHandler({
          driver: createWorkdayResumeUploadDriver(resumePage, { timeoutMs: options.timeoutMs }),
          verifier: createWorkdayResumeVerifier(resumePage, { maxAttempts: 20, intervalMs: 50 }),
          replaceExisting: true,
        }).upload(options.request.ownerSources.resumeIntent, signal);
        if (!result.ok) throw new TypeError("resume reconciliation denied");
        options.acceptances.record(result.value);
        return verified("resume", "resume_verified", request.pageId);
      });
      return used.ok ? used.value : applicationFailure(used.error.code, "file_upload", "ui_behavior");
    }),
    profile: handler("profile", async (request, signal) => {
      const used = await options.access("mutation", signal, async (page) => {
        const result = await completeWorkdayProfilePage(
          options.request.ownerSources.profilePlan,
          new PlaywrightWorkdayProfilePage(page, {
            pageType: options.request.ownerSources.profilePlan.pageType,
            timeoutMs: options.timeoutMs,
          }),
          signal,
        );
        if (result.kind !== "verified" || result.ownedDuplicateRows !== 0) {
          throw new TypeError("profile reconciliation denied");
        }
        options.acceptances.record(Object.freeze({
          schemaVersion: 1,
          checkpoint: "profile_verified",
          pageType: result.pageType,
          verifiedFields: result.verifiedFields,
          ownedDuplicateRows: 0,
          independentlyVerified: true,
          submitActivated: false,
          privacyScan: "pass",
        }));
        return verified("profile", "profile_verified", request.pageId);
      });
      return used.ok ? used.value : applicationFailure(used.error.code, "profile_control", "ui_behavior");
    }),
    questionnaire: handler("questionnaire", async (request, signal) => {
      const used = await options.access("mutation", signal, async (page) => {
        await bindQuestionnaireTargets(page, request.pageId);
        const semanticSessionId = `browser_session_${randomBytes(12).toString("hex")}` as BrowserSessionId;
        const semantic = new PlaywrightBrowserSession({
          attached: { page, sessionId: semanticSessionId, pageId: request.pageId },
          ids: createGeneratedIdAllocator({ next: () => randomBytes(8).toString("hex") }),
          timeoutMs: options.timeoutMs,
        });
        try {
          const observed = await semantic.observe({
            sessionId: semanticSessionId,
            pageId: request.pageId,
          }, signal);
          if (!observed.ok) return applicationFailure(observed.error.code, "question_control", "ui_behavior");
          const snapshot = createSemanticSnapshot(
            { kind: "workday", page: "questionnaire" },
            discoverFields(observed.value.targets),
          );
          const facts = structuralObservations(snapshot.fields, options.request.owner.revisionId);
          const questionnaire = createQuestionnairePageHandler({
            profileQuery: options.request.ownerSources.profileQuery,
            driver: createFieldDriver(semantic, createSafetyGuard()),
            verifier: createFieldVerifier(semantic),
            narrative: options.request.ownerSources.narrative,
            nextOperationId: options.nextOperationId,
            allocateCandidateId: () => `unknown_candidate_${randomBytes(12).toString("hex")}` as never,
            observationFor: (fieldId, layer) => facts.get(`${fieldId}:${layer}`),
          });
          const completed = await questionnaire.complete({
            journeyId: options.session.journeyId,
            sessionId: semanticSessionId,
            pageId: request.pageId,
            guardRevision: runtimeRevision,
            profileId: options.request.ownerSources.profileId,
            profileRevision: options.request.ownerSources.profileRevision,
            resume: {
              resumeId: options.request.ownerSources.resumeIntent.artifact.resumeId,
              sha256: options.request.ownerSources.resumeIntent.artifact.sha256,
            },
            resumeArtifact: options.request.ownerSources.resumeIntent.artifact,
            page: snapshot,
          }, signal);
          if (!completed.ok && new Set([
            "browser_effect_uncertain",
            "browser_session_invalidated",
            "browser_target_stale",
          ]).has(completed.error.code)) {
            throw new TypeError("questionnaire browser effect uncertain");
          }
          if (!completed.ok || completed.value.kind !== "verified" ||
              completed.value.protectedPlaceholderCount !== 0) {
            return applicationFailure("page_incomplete", "question_control", "question");
          }
          options.acceptances.record(Object.freeze({
            schemaVersion: 1,
            checkpoint: "questionnaire_verified",
            answers: completed.value.answers,
            protectedPlaceholderCount: 0,
            independentlyVerified: true,
            submitActivated: false,
            privacyScan: "pass",
          }));
          return verified("questionnaire", "questionnaire_verified", request.pageId);
        } finally {
          await semantic.close({ sessionId: semanticSessionId }, new AbortController().signal);
        }
      });
      return used.ok ? used.value : applicationFailure(used.error.code, "question_control", "ui_behavior");
    }),
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
  readonly access: <Value>(effect: "read" | "mutation", signal: AbortSignal, use: (page: Page) => Promise<Value>) => Promise<LivePortResult<Value, PersistentBrowserErrorCode>>;
  readonly nextOperationId: () => OperationId;
}): RecoveryDependencies {
  const state = {
    load: async () => ({ ok: true as const, value: options.store.peek() }),
    save: async (request: Parameters<RecoveryDependencies["state"]["save"]>[0]) =>
      options.store.save(request.expectedRevision, request.state)
        ? { ok: true as const, value: request.state }
        : recoveryFailure("recovery_state_ambiguous"),
  };
  return Object.freeze({
    state,
    browser: Object.freeze({
      async inspect(signal: AbortSignal) {
        const inspected = await options.access("read", signal, async (page) => {
          const truth = await new PlaywrightWorkdayApplicationPage(page).observe(signal);
          if (!truth.ok) throw new TypeError("browser truth unavailable");
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
          return Object.freeze({ pages: Object.freeze([value]) });
        });
        return inspected.ok ? { ok: true as const, value: inspected.value } : recoveryFailure(inspected.error.code);
      },
      async reload(signal: AbortSignal) {
        const reloaded = await options.access("mutation", signal, async (page) => {
          await page.reload({ waitUntil: "domcontentloaded" });
        });
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

  peek(): RecoveryCheckpoint | null {
    this.#assertBoundary();
    if (!existsSync(this.#path)) return null;
    try {
      const bytes = readFileSync(this.#path);
      try {
        if (bytes.byteLength < 2 || bytes.byteLength > 64 * 1024) return null;
        return JSON.parse(bytes.toString("utf8")) as RecoveryCheckpoint;
      } finally {
        bytes.fill(0);
      }
    } catch {
      return null;
    }
  }

  save(expectedRevision: number, state: RecoveryCheckpoint): boolean {
    const current = this.peek();
    if ((current?.revision ?? 0) !== expectedRevision || state.revision !== expectedRevision + 1) {
      return false;
    }
    return this.#write(this.#path, state);
  }

  record(value: RecoveryReconciliationRecord): boolean {
    return this.#write(this.#recordPath, value);
  }

  commitTerminal(terminal: RecoveryTerminal): boolean {
    const current = this.peek();
    return current !== null && this.#write(this.#path, { ...current, terminal });
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
}
