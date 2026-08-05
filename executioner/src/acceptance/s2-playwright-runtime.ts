import { randomBytes } from "node:crypto";
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

import { createApplicationLaneAcceptanceCollector } from
  "../ats/workday/application/lane-composition.ts";
import { PlaywrightWorkdayApplicationPage } from "../ats/workday/application/playwright-page.ts";
import type {
  ApplicationPage,
  ApplicationPageCheck,
  ApplicationPageHandlerPort,
  ApplicationPortFailure,
  ApplicationWalkDependencies,
} from "../ats/workday/application/page-walk.ts";
import type { ApplicationWalkResume } from "../ats/workday/application/page-walk.ts";
import { createPlaywrightPersistentBrowserSession } from "../browser/playwright-live/index.ts";
import {
  ownedApplicationPageAccess,
  suspendOwnedApplicationSession,
  type OwnedApplicationOperation,
  type OwnedApplicationPageCapability,
  type OwnedApplicationPageRequest,
} from "../browser/playwright-live/private/application-page-types.ts";
import type {
  OwnedWorkdayApplicationRuntimeOptions,
  ReviewExpectedField,
} from "../browser/playwright-live/private/workday-application-runtime.ts";
import { isReviewExpectedField } from
  "../browser/playwright-live/private/workday-application-runtime.ts";
import {
  generatedOperationId,
  fieldId,
  type BrowserPageId,
  type FieldId,
  type OperationId,
} from "../contracts/index.ts";
import type { SemanticPageSnapshot } from "../contracts/index.ts";
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
import { s2StableErrorPolicy } from "../contracts/s2-common-wire.ts";
import {
  workdayReviewSignatures,
  type ReviewReadOnlyLocator,
  type ReviewReadOnlyPage,
  type WorkdayReviewStructuralObservationV1,
} from "../interaction/review/index.ts";
import type {
  RecoveryBrowserPageTruth,
  RecoveryCheckpoint,
  RecoveryDependencies,
  RecoveryReconciliationRecord,
  RecoveryTerminal,
} from "../journey/recovery/index.ts";
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
    applicationRuntime: OwnedWorkdayApplicationRuntimeOptions,
  ) => OwnedApplicationBrowser;
  readonly now?: () => string;
  readonly nextOperationId?: () => OperationId;
  readonly timeoutMs?: number;
}

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
        recoveryScopeFor(request, target),
      );
      const initialRecovery = store.load();
      const acceptances = createApplicationLaneAcceptanceCollector();
      const applicationRuntime: OwnedWorkdayApplicationRuntimeOptions = Object.freeze({
        request,
        acceptances,
        nextOperationId,
        timeoutMs,
        initialReviewExpected: initialRecovery?.reviewExpected ?? [],
      });
      let liveRequest: Stage2ApplicationWalkRuntimeBindingRequest | undefined = request;
      const browser = options.browser?.(request, applicationRuntime) ??
        createPlaywrightPersistentBrowserSession({
          binding: request.ownerBinding,
          timeoutMs,
          applicationRuntime,
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
          const expected = await access<readonly ReviewExpectedField[]>(
            { kind: "review_expectations" }, activeSignal,
          );
          if (!expected.ok || !store.save(
            checkpointRevision,
            state,
            progress.pageChecks,
            expected.value,
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
              resume(state: RecoveryCheckpoint) {
                const reconciled = store.load();
                if (reconciled === null || !sameRecoveryCheckpoint(reconciled.checkpoint, state)) {
                  throw new TypeError("recovery progress denied");
                }
                return resumeFromArtifact(reconciled);
              },
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
            const activeRequest = liveRequest;
            if (activeSignal.aborted || activeRequest === undefined) {
              throw new TypeError("privacy source revoked");
            }
            return forbiddenCorpus([
              activeRequest.owner.target.url,
              activeRequest.owner.target.host,
              activeRequest.owner.target.tenant,
              activeRequest.owner.target.posting,
              activeRequest.owner.roots.runtime.path,
              activeRequest.owner.roots.secrets.path,
              activeRequest.owner.roots.evidence.path,
            ], activeRequest.ownerSources.sensitiveValues);
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
              liveRequest = undefined;
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

function handler<PageKind extends "resume" | "profile" | "questionnaire">(
  _page: PageKind,
  reconcile: ApplicationPageHandlerPort<PageKind>["reconcile"],
): ApplicationPageHandlerPort<PageKind> {
  return Object.freeze({ reconcile });
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

function recoveryPage(page: ApplicationPage): RecoveryCheckpoint["page"]["kind"] | undefined {
  if (page === "resume" || page === "profile" || page === "questionnaire") return page;
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
  readonly scope: RecoveryScopeV1;
  readonly checkpoint: RecoveryCheckpoint;
  readonly pageChecks: readonly ApplicationPageCheck[];
  readonly reviewExpected: readonly ReviewExpectedField[];
}

interface RecoveryScopeV1 {
  readonly sourceRevision: string;
  readonly configSha256: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly target: TargetIdentityV1;
}

function recoveryScopeFor(
  request: Stage2ApplicationWalkRuntimeBindingRequest,
  target: TargetIdentityV1,
): RecoveryScopeV1 {
  return Object.freeze({
    sourceRevision: request.sourceRevision,
    configSha256: request.configSha256,
    revisionId: request.owner.revisionId,
    approvalId: request.owner.approval.approvalId,
    journeyId: request.owner.journeyId,
    targetHandleId: request.owner.target.handleId,
    target,
  });
}

function resumeFromArtifact(artifact: RecoveryArtifactV1): ApplicationWalkResume {
  const currentPage = artifact.checkpoint.page.kind === "review"
    ? "pre_review"
    : artifact.checkpoint.page.kind;
  if (currentPage !== "resume" && currentPage !== "profile" && currentPage !== "questionnaire" &&
      currentPage !== "pre_review") {
    throw new TypeError("recovery progress denied");
  }
  return Object.freeze({ currentPage, pageChecks: artifact.pageChecks });
}

function sameRecoveryCheckpoint(left: RecoveryCheckpoint, right: RecoveryCheckpoint): boolean {
  return left.schemaVersion === right.schemaVersion && left.journeyId === right.journeyId &&
    left.sourceRevision === right.sourceRevision && left.revision === right.revision &&
    left.page.id === right.page.id && left.page.kind === right.page.kind &&
    left.verification === right.verification && left.terminal === right.terminal &&
    left.target.schemaVersion === right.target.schemaVersion &&
    left.target.atsFamily === right.target.atsFamily && left.target.hostId === right.target.hostId &&
    left.target.tenantId === right.target.tenantId && left.target.postingId === right.target.postingId;
}

class RecoveryFileStore {
  readonly #root: string;
  readonly #directory: string;
  readonly #path: string;
  readonly #recordPath: string;
  readonly #scope: RecoveryScopeV1;

  constructor(root: string, file: string, scope: RecoveryScopeV1) {
    if (!/^revision_[A-Za-z0-9_-]{16,64}\.recovery\.json$/u.test(file)) {
      throw new TypeError("recovery coordinate denied");
    }
    this.#root = realpathSync.native(root);
    this.#directory = join(this.#root, "stage2-acceptance");
    mkdirSync(this.#directory, { recursive: true });
    this.#path = join(this.#directory, file);
    this.#recordPath = `${this.#path}.reconciliation`;
    this.#scope = scope;
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
      if (!isRecoveryArtifact(value) || !sameRecoveryScope(value.scope, this.#scope)) {
        throw new TypeError("recovery artifact scope denied");
      }
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
      scope: this.#scope,
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
  if (!hasExactKeys(value, ["schemaVersion", "scope", "checkpoint", "pageChecks", "reviewExpected"])) {
    return false;
  }
  if (artifact.schemaVersion !== 1 || !isRecoveryScope(artifact.scope) ||
      !Array.isArray(artifact.pageChecks) ||
      !Array.isArray(artifact.reviewExpected) ||
      !isRecoveryCheckpoint(artifact.checkpoint)) return false;
  const expectedPage = artifact.checkpoint.page.kind === "resume" ? "resume"
    : artifact.checkpoint.page.kind === "profile" ? "profile"
    : artifact.checkpoint.page.kind === "questionnaire" ? "questionnaire"
    : artifact.checkpoint.page.kind === "review" ? "pre_review" : undefined;
  if (expectedPage === undefined) return false;
  const bounds = expectedPage === "resume" ? [1, 1] as const
    : expectedPage === "profile" ? [1, 2] as const
    : expectedPage === "questionnaire" ? [2, 3] as const
    : [3, 3] as const;
  if (artifact.pageChecks.length < bounds[0] || artifact.pageChecks.length > bounds[1]) return false;
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

function isRecoveryScope(value: unknown): value is RecoveryScopeV1 {
  if (typeof value !== "object" || value === null || !hasExactKeys(value, [
    "sourceRevision", "configSha256", "revisionId", "approvalId", "journeyId",
    "targetHandleId", "target",
  ])) return false;
  const scope = value as Partial<RecoveryScopeV1>;
  return typeof scope.sourceRevision === "string" && /^[0-9a-f]{40}$/u.test(scope.sourceRevision) &&
    typeof scope.configSha256 === "string" && /^[0-9a-f]{64}$/u.test(scope.configSha256) &&
    typeof scope.revisionId === "string" && /^revision_[A-Za-z0-9_-]{16,64}$/u.test(scope.revisionId) &&
    typeof scope.approvalId === "string" && /^approval_[A-Za-z0-9_-]{16,64}$/u.test(scope.approvalId) &&
    typeof scope.journeyId === "string" && /^journey_[A-Za-z0-9_-]{16,64}$/u.test(scope.journeyId) &&
    typeof scope.targetHandleId === "string" && /^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(scope.targetHandleId) &&
    isTargetIdentity(scope.target);
}

function sameRecoveryScope(left: RecoveryScopeV1, right: RecoveryScopeV1): boolean {
  return left.sourceRevision === right.sourceRevision && left.configSha256 === right.configSha256 &&
    left.revisionId === right.revisionId && left.approvalId === right.approvalId &&
    left.journeyId === right.journeyId && left.targetHandleId === right.targetHandleId &&
    left.target.schemaVersion === right.target.schemaVersion &&
    left.target.atsFamily === right.target.atsFamily && left.target.hostId === right.target.hostId &&
    left.target.tenantId === right.target.tenantId && left.target.postingId === right.target.postingId;
}

function isTargetIdentity(value: unknown): value is TargetIdentityV1 {
  if (typeof value !== "object" || value === null || !hasExactKeys(value, [
    "schemaVersion", "atsFamily", "hostId", "tenantId", "postingId",
  ])) return false;
  const target = value as Partial<TargetIdentityV1>;
  return target.schemaVersion === 1 && target.atsFamily === "workday" &&
    typeof target.hostId === "string" && /^host_[A-Za-z0-9_-]{16,64}$/u.test(target.hostId) &&
    typeof target.tenantId === "string" && /^tenant_[A-Za-z0-9_-]{16,64}$/u.test(target.tenantId) &&
    typeof target.postingId === "string" && /^posting_[A-Za-z0-9_-]{16,64}$/u.test(target.postingId);
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
    new Set(["resume", "profile", "questionnaire", "review"]).has(page.kind);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
