import type {
  LiveBrowserSessionV1,
  LivePortResult,
  PersistentBrowserCloseRequest,
  PersistentBrowserErrorCode,
  PersistentBrowserOpenRequest,
  PersistentBrowserOpenResult,
  PersistentBrowserReconcileRequest,
  PersistentBrowserReconcileResult,
  PersistentBrowserSession,
} from "../../contracts/live/index.ts";
import { inspectPinnedTarget, reconcileOwnedPages } from "./private/owned-page-inspection.ts";
import {
  applicationOperationEffect,
  isOwnedApplicationOperation,
  ownedApplicationPageAccess,
  suspendOwnedApplicationSession,
  type OwnedApplicationOperation,
  type OwnedApplicationPageRequest,
} from "./private/application-page-types.ts";
import type {
  OwnedAccountPageAccess,
  OwnedAccountPageAccessRequest,
} from "./private/account-page-types.ts";
import type {
  AccountEntryAdvancePortResult,
  AccountEntryAdvanceRequest,
  AccountEntryAdvanceResult,
  PostingNavigationAction,
  PostingNavigationSessionTraceEvent,
} from "./private/account-navigation-types.ts";
import {
  authMonitorPhase,
  authMonitorTaxonomy,
  OwnedAccountPageCoordinator,
} from "./private/owned-account-page-coordinator.ts";
import { OwnedVerificationNavigationCoordinator } from "./private/owned-verification-navigation-coordinator.ts";
import { bounded, cancelled, failure } from "./private/port-results.ts";
import { isExactMarker, sessionFromMarker } from "./private/profile-marker.ts";
import { bindApprovedTarget, sameSession, sameTarget } from "./private/target-binding.ts";
import { classifyWorkdayAccountNavigation } from "./private/workday-account-navigation.ts";
import type {
  ByteScopedVerificationBrowserCapability,
  OwnedVerificationNavigationAccessRequest,
} from "./private/verification-navigation-types.ts";
import type {
  PersistentContext,
  PersistentPage,
  PlaywrightPersistentBrowserSessionOptions,
  ProfileMarkerV1,
  ApprovedTargetBinding,
  OwnedTargetInspection,
} from "./private/types.ts";
import {
  OwnedWorkdayApplicationRuntime,
  type OwnedWorkdayApplicationRuntimeOptions,
} from
  "./private/workday-application-runtime.ts";

type RetainedSessionOptions = Omit<
  PlaywrightPersistentBrowserSessionOptions,
  "applicationRuntime"
>;

interface FailedOpenCleanupResult {
  readonly inspectionPassed: boolean;
  readonly resourcesCleaned: boolean;
}

export class PlaywrightPersistentBrowserSession
  implements PersistentBrowserSession
{
  readonly #options: RetainedSessionOptions;
  #context: PersistentContext | undefined;
  #page: PersistentPage | undefined;
  #session: LiveBrowserSessionV1 | undefined;
  #approvedTarget: ApprovedTargetBinding | undefined;
  #marker: ProfileMarkerV1 | undefined;
  #profilePath: string | undefined;
  #closedSessionId: LiveBrowserSessionV1["sessionId"] | undefined;
  #closedJourneyId: LiveBrowserSessionV1["journeyId"] | undefined;
  #cleanupFailedSessionId: LiveBrowserSessionV1["sessionId"] | undefined;
  #cleanupFailedJourneyId: LiveBrowserSessionV1["journeyId"] | undefined;
  #inspectionFailedSessionId: LiveBrowserSessionV1["sessionId"] | undefined;
  #inspectionFailedJourneyId: LiveBrowserSessionV1["journeyId"] | undefined;
  readonly #accountAccess: OwnedAccountPageCoordinator;
  readonly #verificationNavigation: OwnedVerificationNavigationCoordinator;
  readonly #applicationRuntime: RevocableWorkdayApplicationRuntime;
  readonly #openOperations = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<OpenPortResult> }
  >();
  readonly #closeOperations = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<ClosePortResult> }
  >();
  readonly #reconcileOperations = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<ReconcilePortResult> }
  >();
  readonly #accountAdvanceOperations = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<AccountEntryAdvancePortResult> }
  >();
  readonly #applicationPageOperations = new Set<string>();
  readonly #applicationSuspendOperations = new Map<string, Promise<ClosePortResult>>();
  #applicationPageActive = false;
  readonly #authNavigationAttempts = new Map<string, number>();

  constructor(options: PlaywrightPersistentBrowserSessionOptions) {
    const { applicationRuntime: runtimeOptions, ...retainedOptions } = options;
    this.#options = Object.freeze(retainedOptions);
    this.#applicationRuntime = new RevocableWorkdayApplicationRuntime(runtimeOptions);
    this.#accountAccess = new OwnedAccountPageCoordinator({
      adapter: options.accountPage,
      probe: options.probe,
      timeoutMs: options.timeoutMs,
      externalMonitor: options.externalMonitor,
      trace: options.accountNavigationTrace,
      state: () => ({
        page: this.#page,
        session: this.#session,
        approvedTarget: this.#approvedTarget,
        marker: this.#marker,
      }),
      invalidate: () => this.#invalidateAccountSession(),
    });
    this.#verificationNavigation = new OwnedVerificationNavigationCoordinator({
      adapter: options.verificationNavigation,
      probe: options.probe,
      timeoutMs: options.timeoutMs,
      externalMonitor: options.externalMonitor,
      state: () => ({
        page: this.#page,
        session: this.#session,
        approvedTarget: this.#approvedTarget,
        marker: this.#marker,
      }),
      invalidate: () => this.#invalidateAccountSession(),
    });
  }

  async open(
    request: PersistentBrowserOpenRequest,
    signal: AbortSignal,
  ): Promise<OpenPortResult> {
    const fingerprint = JSON.stringify(request);
    const previous = this.#openOperations.get(request.operationId);
    if (previous !== undefined) {
      return previous.fingerprint === fingerprint
        ? previous.result
        : failure("browser_operation_replayed");
    }
    const result = this.#openOnce(request, signal).then(
      (opened) => {
        if (!opened.ok) {
          this.#applicationRuntime.revoke();
          return opened;
        }
        try {
          this.#applicationRuntime.current()?.bindSession(opened.value.session);
          return opened;
        } catch (error) {
          this.#applicationRuntime.revoke();
          throw error;
        }
      },
      (error: unknown) => {
        this.#applicationRuntime.revoke();
        throw error;
      },
    );
    this.#openOperations.set(request.operationId, { fingerprint, result });
    return result;
  }

  async #openOnce(
    request: PersistentBrowserOpenRequest,
    signal: AbortSignal,
  ): Promise<OpenPortResult> {
    if (signal.aborted) return cancelled();
    const runtime = this.#options.binding.forPersistentBrowser();
    this.#profilePath = runtime.profilePath;
    const approvedTarget = bindApprovedTarget(runtime.targetUrl, request.target);
    if (approvedTarget === undefined) return failure("browser_target_invalid");
    if (
      this.#approvedTarget !== undefined &&
      !sameTarget(this.#approvedTarget.identity, request.target)
    ) {
      return failure("browser_target_invalid");
    }
    this.#approvedTarget = approvedTarget;
    if (this.#context !== undefined || this.#session !== undefined) {
      if (
        this.#context === undefined ||
        this.#session === undefined ||
        this.#page === undefined ||
        this.#page.isClosed()
      ) {
        return failure("browser_session_invalidated");
      }
      if (
        request.journeyId !== this.#session.journeyId ||
        request.profileLeaseId !== this.#session.profileLeaseId ||
        !sameTarget(request.target, this.#session.target) ||
        Date.parse(runtime.admittedAt) >= Date.parse(this.#session.leaseExpiresAt)
      ) {
        return failure("browser_target_invalid");
      }
      return {
        ok: true,
        value: { kind: "reattached", session: this.#session },
      };
    }
    try {
      const persisted = await this.#options.profiles.read(runtime.profilePath);
      const exactMarker = isExactMarker(persisted, request, runtime);
      if (persisted !== undefined && !exactMarker) {
        const removed = await bounded(
          this.#options.profiles.cleanupPartial(runtime.profilePath),
          signal,
          this.#options.timeoutMs,
        );
        if (removed.kind === "cancelled") return cancelled();
        if (removed.kind !== "value") {
          return failure("browser_profile_cleanup_failed");
        }
      }
      if (signal.aborted) return cancelled();
      const launchPromise = this.#options.launcher.launchPersistentContext(
        runtime.profilePath,
        { headless: false },
      );
      const launched = await bounded(
        launchPromise,
        signal,
        this.#options.timeoutMs,
      );
      if (launched.kind !== "value") {
        void launchPromise.then(
          (context) => this.#cleanupDetachedContext(context, runtime.profilePath),
          () => this.#options.profiles.cleanupPartial(runtime.profilePath).catch(() => undefined),
        );
        return failure("browser_effect_uncertain");
      }
      this.#context = launched.value;
      if (exactMarker) {
        const owned = [] as PersistentPage[];
        for (const page of this.#context.pages()) {
          if (page.isClosed()) continue;
          const inspected = await bounded(
            this.#options.probe.inspect(page, approvedTarget, signal),
            signal,
            this.#options.timeoutMs,
          );
          if (inspected.kind !== "value") {
            const cleaned = await this.#cleanupFailedOpen(
              runtime.profilePath,
              persisted,
            );
            if (!cleaned.resourcesCleaned) return failure("browser_profile_cleanup_failed");
            if (!cleaned.inspectionPassed) return failure("browser_effect_uncertain");
            if (inspected.kind === "cancelled") return cancelled();
            return failure(
              inspected.kind === "timeout"
                ? "browser_timeout"
                : "browser_target_stale",
            );
          }
          const observation = inspected.value;
          if (
            observation.ownership === "owned" &&
            admissibleInitialTarget(observation.target)
          ) {
            owned.push(page);
          }
        }
        if (owned.length !== 1) {
          const cleaned = await this.#cleanupFailedOpen(
            runtime.profilePath,
            persisted,
          );
          if (!cleaned.resourcesCleaned) return failure("browser_profile_cleanup_failed");
          return cleaned.inspectionPassed
            ? failure(
                owned.length === 0
                  ? "browser_session_missing"
                  : "browser_target_ambiguous",
              )
            : failure("browser_effect_uncertain");
        }
        this.#page = owned[0];
        this.#session = sessionFromMarker(persisted, request);
        this.#resetTerminalCleanup();
        this.#marker = persisted;
        return {
          ok: true,
          value: { kind: "reattached", session: this.#session },
        };
      }
      const launchPages = this.#context.pages().filter((page) => !page.isClosed());
      if (launchPages.length > 1) {
        const cleaned = await this.#cleanupFailedOpen(runtime.profilePath);
        if (!cleaned.resourcesCleaned) return failure("browser_profile_cleanup_failed");
        return cleaned.inspectionPassed
          ? failure("browser_target_ambiguous")
          : failure("browser_effect_uncertain");
      }
      const pageResult = await bounded(
        launchPages.length === 1
          ? Promise.resolve(launchPages[0]!)
          : this.#context.newPage(),
        signal,
        this.#options.timeoutMs,
      );
      if (pageResult.kind !== "value") {
        const cleaned = await this.#cleanupFailedOpen(runtime.profilePath);
        return cleaned.resourcesCleaned
          ? failure("browser_effect_uncertain")
          : failure("browser_profile_cleanup_failed");
      }
      this.#page = pageResult.value;
      const navigation = await bounded(
        this.#page.goto(runtime.targetUrl, { waitUntil: "domcontentloaded" }),
        signal,
        this.#options.timeoutMs,
      );
      if (navigation.kind !== "value") {
        const cleaned = await this.#cleanupFailedOpen(runtime.profilePath);
        return cleaned.resourcesCleaned
          ? failure("browser_effect_uncertain")
          : failure("browser_profile_cleanup_failed");
      }
      const inspected = await bounded(
        this.#options.probe.inspect(this.#page, approvedTarget, signal),
        signal,
        this.#options.timeoutMs,
      );
      if (inspected.kind !== "value") {
        const cleaned = await this.#cleanupFailedOpen(runtime.profilePath);
        return cleaned.resourcesCleaned
          ? failure("browser_effect_uncertain")
          : failure("browser_profile_cleanup_failed");
      }
      const observation = inspected.value;
      if (
        observation.ownership !== "owned" ||
        !admissibleInitialTarget(observation.target)
      ) {
        const cleaned = await this.#cleanupFailedOpen(runtime.profilePath);
        if (!cleaned.resourcesCleaned) return failure("browser_profile_cleanup_failed");
        return cleaned.inspectionPassed
          ? failure("browser_target_invalid")
          : failure("browser_effect_uncertain");
      }
      this.#session = {
        schemaVersion: 1,
        journeyId: request.journeyId,
        sessionId: this.#options.ids(),
        profileLeaseId: request.profileLeaseId,
        target: request.target,
        leaseExpiresAt: runtime.leaseExpiresAt,
      };
      this.#resetTerminalCleanup();
      const marker: ProfileMarkerV1 = {
        schemaVersion: 1,
        journeyId: request.journeyId,
        profileLeaseId: request.profileLeaseId,
        sessionId: this.#session.sessionId,
        target: request.target,
        admittedAt: runtime.admittedAt,
        leaseExpiresAt: runtime.leaseExpiresAt,
      };
      const written = await bounded(
        this.#options.profiles.write(runtime.profilePath, marker),
        signal,
        this.#options.timeoutMs,
      );
      if (written.kind !== "value") {
        const cleaned = await this.#cleanupFailedOpen(runtime.profilePath);
        return cleaned.resourcesCleaned
          ? failure("browser_effect_uncertain")
          : failure("browser_profile_cleanup_failed");
      }
      this.#marker = marker;
      return { ok: true, value: { kind: "opened", session: this.#session } };
    } catch {
      const cleaned = await this.#cleanupFailedOpen(runtime.profilePath);
      return cleaned.resourcesCleaned
        ? failure("browser_effect_uncertain")
        : failure("browser_profile_cleanup_failed");
    }
  }

  async reconcile(
    request: PersistentBrowserReconcileRequest,
    signal: AbortSignal,
  ): Promise<ReconcilePortResult> {
    const fingerprint = JSON.stringify(request);
    const previous = this.#reconcileOperations.get(request.operationId);
    if (previous !== undefined) {
      return previous.fingerprint === fingerprint
        ? previous.result
        : failure("browser_operation_replayed");
    }
    const result = this.#reconcileOnce(request, signal);
    this.#reconcileOperations.set(request.operationId, { fingerprint, result });
    return result;
  }

  async #reconcileOnce(
    request: PersistentBrowserReconcileRequest,
    signal: AbortSignal,
  ): Promise<ReconcilePortResult> {
    if (signal.aborted) return cancelled();
    if (
      this.#context === undefined ||
      this.#session === undefined ||
      this.#approvedTarget === undefined ||
      !sameSession(this.#session, request.session) ||
      request.journeyId !== this.#session.journeyId
    ) {
      return failure("browser_session_missing");
    }
    try {
      const reconciled = await reconcileOwnedPages(
        this.#context,
        this.#options.probe,
        this.#approvedTarget,
        request.expectedTarget,
        signal,
        this.#options.timeoutMs,
      );
      if (!reconciled.ok) return reconciled;
      if (reconciled.value.kind !== "matched") {
        return { ok: true, value: reconciled.value };
      }
      this.#page = reconciled.value.page;
      this.#session = { ...this.#session, target: request.expectedTarget };
      return {
        ok: true,
        value: { kind: "matched", session: this.#session },
      };
    } catch {
      return failure("browser_target_stale");
    }
  }

  async inspectOwnedTarget(
    sessionId: LiveBrowserSessionV1["sessionId"],
    expectedTarget: PersistentBrowserReconcileRequest["expectedTarget"],
    signal: AbortSignal,
  ): Promise<
    LivePortResult<OwnedTargetInspection, PersistentBrowserErrorCode>
  > {
    if (signal.aborted) return cancelled();
    if (
      this.#page === undefined ||
      this.#page.isClosed() ||
      this.#session?.sessionId !== sessionId ||
      this.#approvedTarget === undefined ||
      !sameTarget(this.#session.target, expectedTarget)
    ) {
      return failure("browser_session_missing");
    }
    try {
      return await inspectPinnedTarget(
        this.#page,
        this.#options.probe,
        this.#approvedTarget,
        expectedTarget,
        signal,
        this.#options.timeoutMs,
      );
    } catch {
      return failure("browser_target_stale");
    }
  }

  async close(
    request: PersistentBrowserCloseRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>> {
    const fingerprint = JSON.stringify(request);
    const previous = this.#closeOperations.get(request.operationId);
    if (previous !== undefined) {
      return previous.fingerprint === fingerprint
        ? previous.result
        : failure("browser_operation_replayed");
    }
    const result = this.#closeOnce(request, signal);
    this.#closeOperations.set(request.operationId, { fingerprint, result });
    return result;
  }

  async withOwnedAccountPageAccess(
    request: OwnedAccountPageAccessRequest,
    signal: AbortSignal,
    use: (access: OwnedAccountPageAccess) => Promise<void>,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>> {
    return this.#accountAccess.withAccess(request, signal, use);
  }

  /** Runs one closed application operation; raw Page authority never leaves this owner. */
  async [ownedApplicationPageAccess](
    request: OwnedApplicationPageRequest,
    operation: OwnedApplicationOperation,
    signal: AbortSignal,
  ): Promise<LivePortResult<unknown, PersistentBrowserErrorCode>> {
    if (signal.aborted) return cancelled();
    const applicationRuntime = this.#applicationRuntime.current();
    if (
      this.#applicationPageActive ||
      this.#applicationPageOperations.has(request.operationId)
    ) return failure("browser_operation_replayed");
    const now = Date.parse(request.now);
    if (
      request.schemaVersion !== 1 ||
      !isOwnedApplicationOperation(operation) ||
      applicationRuntime === undefined ||
      this.#page === undefined ||
      this.#page.isClosed() ||
      this.#session === undefined ||
      this.#approvedTarget === undefined ||
      this.#marker === undefined ||
      request.journeyId !== this.#session.journeyId ||
      request.sessionId !== this.#session.sessionId ||
      !sameTarget(request.target, this.#session.target) ||
      request.journeyId !== this.#marker.journeyId ||
      request.sessionId !== this.#marker.sessionId ||
      !sameTarget(request.target, this.#marker.target) ||
      !Number.isFinite(now) ||
      now < Date.parse(this.#marker.admittedAt) ||
      now >= Date.parse(this.#session.leaseExpiresAt)
    ) return failure("browser_session_missing");

    const page = this.#page;
    const approvedTarget = this.#approvedTarget;
    const before = await inspectPinnedTarget(
      page,
      this.#options.probe,
      approvedTarget,
      request.target,
      signal,
      this.#options.timeoutMs,
    );
    if (!before.ok) return before;
    if (before.value.target.kind !== "matched") {
      return failure("browser_target_invalid");
    }

    this.#applicationPageActive = true;
    this.#applicationPageOperations.add(request.operationId);
    const effect = applicationOperationEffect(operation);
    try {
      const result = await bounded(
        applicationRuntime.run(page, request, operation, signal),
        signal,
        this.#options.applicationOperationTimeoutMs ?? this.#options.timeoutMs,
      );
      if (result.kind !== "value") {
        if (effect === "mutation") {
          await this.#invalidateAccountSession();
          return failure("browser_effect_uncertain");
        }
        return result.kind === "cancelled"
          ? cancelled()
          : failure(result.kind === "timeout"
            ? "browser_timeout"
            : "browser_target_stale");
      }
      const current = this.#page === page &&
        this.#approvedTarget === approvedTarget &&
        this.#session?.sessionId === request.sessionId;
      const after = current
        ? await inspectPinnedTarget(
            page,
            this.#options.probe,
            approvedTarget,
            request.target,
            signal,
            this.#options.timeoutMs,
          )
        : failure("browser_session_invalidated");
      if (!after.ok || after.value.target.kind !== "matched") {
        if (effect === "mutation") {
          await this.#invalidateAccountSession();
          return failure("browser_effect_uncertain");
        }
        return failure("browser_session_invalidated");
      }
      return { ok: true, value: result.value };
    } catch {
      if (effect === "mutation") {
        await this.#invalidateAccountSession();
        return failure("browser_effect_uncertain");
      }
      return failure("browser_target_stale");
    } finally {
      this.#applicationPageActive = false;
    }
  }

  async [suspendOwnedApplicationSession](
    request: PersistentBrowserCloseRequest,
    signal: AbortSignal,
  ): Promise<ClosePortResult> {
    const prior = this.#applicationSuspendOperations.get(request.operationId);
    if (prior !== undefined) return prior;
    const result = this.#suspendApplicationOnce(request, signal);
    this.#applicationSuspendOperations.set(request.operationId, result);
    return result;
  }

  async #suspendApplicationOnce(
    request: PersistentBrowserCloseRequest,
    signal: AbortSignal,
  ): Promise<ClosePortResult> {
    if (signal.aborted || this.#context === undefined || this.#session === undefined ||
        this.#marker === undefined || this.#profilePath === undefined ||
        request.journeyId !== this.#session.journeyId ||
        request.sessionId !== this.#session.sessionId) return failure("browser_session_missing");
    const context = this.#context;
    const inspectionPassed = await this.#holdBeforeCleanup(context);
    const closed = await this.#boundedCleanup(() => context.close());
    this.#context = undefined;
    this.#page = undefined;
    this.#session = undefined;
    this.#approvedTarget = undefined;
    this.#marker = undefined;
    this.#profilePath = undefined;
    this.#applicationRuntime.revoke();
    if (!closed) return failure("browser_profile_cleanup_failed");
    if (!inspectionPassed) {
      this.#inspectionFailedSessionId = request.sessionId;
      this.#inspectionFailedJourneyId = request.journeyId;
      return failure("browser_effect_uncertain");
    }
    return { ok: true, value: undefined };
  }

  async withOwnedVerificationNavigationAccess(
    request: OwnedVerificationNavigationAccessRequest,
    signal: AbortSignal,
    use: (access: ByteScopedVerificationBrowserCapability) => Promise<void>,
  ) {
    return this.#verificationNavigation.withAccess(request, signal, use);
  }

  async advanceToAccountEntry(
    request: AccountEntryAdvanceRequest,
    signal: AbortSignal,
  ): Promise<AccountEntryAdvancePortResult> {
    const fingerprint = JSON.stringify(request);
    const previous = this.#accountAdvanceOperations.get(request.operationId);
    if (previous !== undefined) {
      return previous.fingerprint === fingerprint
        ? previous.result
        : failure("browser_operation_replayed");
    }
    const result = this.#advanceToAccountEntryOnce(request, signal);
    this.#accountAdvanceOperations.set(request.operationId, { fingerprint, result });
    return result;
  }

  async #advanceToAccountEntryOnce(
    request: AccountEntryAdvanceRequest,
    signal: AbortSignal,
  ): Promise<AccountEntryAdvancePortResult> {
    if (signal.aborted) return cancelled();
    if (!this.#validAdvanceRequest(request)) return failure("browser_target_invalid");
    let transitionCount = 0;
    const visitedStates = new Set<string>();
    while (transitionCount < 3) {
      const inspected = await inspectPinnedTarget(
        this.#page!,
        this.#options.probe,
        this.#approvedTarget!,
        request.target,
        signal,
        this.#options.timeoutMs,
      );
      if (!inspected.ok) return inspected;
      if (inspected.value.target.kind !== "matched") {
        return this.#stopAfterTargetFact(inspected.value.target);
      }
      const state = classifyWorkdayAccountNavigation(inspected.value.snapshot);
      if (state.kind === "account_boundary") {
        return { ok: true, value: { kind: "account_boundary" } };
      }
      if (state.kind === "ambiguous") {
        return failure("browser_target_ambiguous");
      }
      if (state.kind === "invalid") return failure("browser_target_invalid");
      if (visitedStates.has(state.kind)) return failure("browser_target_invalid");
      visitedStates.add(state.kind);
      if (state.kind === "job_posting" && transitionCount !== 0) {
        return failure("browser_target_invalid");
      }
      let action: PostingNavigationAction = state.kind === "job_posting"
        ? inspected.value.snapshot.traitIds.includes("structural_trait_account_sign_in_v1")
          ? "account_sign_in"
          : "start_application"
        : state.kind === "apply_choice"
          ? "apply_manually"
          : "sign_in_with_email";
      if (state.kind === "job_posting" && action === "start_application") {
        const signInControl = await bounded(
          this.#options.postingNavigation!.inspect(
            this.#page!,
            "account_sign_in",
          ),
          signal,
          this.#options.timeoutMs,
        );
        if (signInControl.kind === "cancelled") return cancelled();
        if (signInControl.kind === "timeout") return failure("browser_timeout");
        if (signInControl.kind === "error") return failure("browser_target_invalid");
        if (signInControl.value.cardinality > 1) {
          return failure("browser_target_ambiguous");
        }
        if (signInControl.value.cardinality === 1) {
          if (!signInControl.value.actionable) return failure("browser_target_invalid");
          action = "account_sign_in";
        }
      }
      const control = await bounded(
        this.#options.postingNavigation!.inspect(this.#page!, action),
        signal,
        this.#options.timeoutMs,
      );
      if (control.kind === "cancelled") return cancelled();
      if (control.kind === "timeout" || control.kind === "error") {
        const reclassified = await this.#reclassifyAfterUnavailableControl(
          state.kind,
          request,
          signal,
        );
        if (reclassified === "retry") continue;
        if (reclassified !== undefined) return reclassified;
        return failure(
          control.kind === "timeout" ? "browser_timeout" : "browser_target_invalid",
        );
      }
      if (control.value.cardinality > 1) {
        const reclassified = await this.#reclassifyAfterUnavailableControl(
          state.kind,
          request,
          signal,
        );
        if (reclassified === "retry") continue;
        return reclassified ?? failure("browser_target_ambiguous");
      }
      if (control.value.cardinality !== 1 || !control.value.actionable) {
        const reclassified = await this.#reclassifyAfterUnavailableControl(
          state.kind,
          request,
          signal,
        );
        if (reclassified === "retry") continue;
        return reclassified ?? failure("browser_target_invalid");
      }
      const monitorOperationId = generatedOperationId(`operation_${createHash("sha256").update(
        `${request.operationId}\0${transitionCount}`,
        "utf8",
      ).digest("hex").slice(0, 24)}`);
      const fromPhase = authMonitorPhase(inspected.value.snapshot);
      const monitorAttempt = (this.#authNavigationAttempts.get(fromPhase) ?? 0) + 1;
      if (this.#options.externalMonitor !== undefined) {
        try {
          await this.#options.externalMonitor.auth(
            this.#page! as never,
            fromPhase,
            "before_navigation",
            authMonitorTaxonomy(inspected.value.snapshot),
            { operationId: monitorOperationId, attempt: monitorAttempt },
            signal,
          );
          this.#authNavigationAttempts.set(fromPhase, monitorAttempt);
        } catch {
          return failure("browser_effect_uncertain");
        }
      }
      const activated = await bounded(
        this.#options.postingNavigation!.activate(this.#page!, action),
        signal,
        this.#options.timeoutMs,
      );
      transitionCount += 1;
      if (activated.kind !== "value") {
        const recovered = await this.#reconcileAfterUncertainActivation(
          state.kind,
          request,
          new AbortController().signal,
          { operationId: monitorOperationId, attempt: monitorAttempt },
        );
        if (activated.kind !== "cancelled") {
          if (recovered === "retry") continue;
          if (recovered !== undefined) return recovered;
        }
        return this.#uncertainAdvanceFailure();
      }
      const reconciled = await reconcileOwnedPages(
        this.#context!,
        this.#options.probe,
        this.#approvedTarget!,
        request.target,
        signal,
        this.#options.timeoutMs,
      );
      if (!reconciled.ok) {
        this.#emitAccountNavigationTrace(
          `posting_navigation_reconcile_failed_${reconciled.error.code}`,
        );
        return this.#uncertainAdvanceFailure();
      }
      this.#emitAccountNavigationTrace(
        `posting_navigation_reconcile_observed_${reconciled.value.kind}`,
      );
      if (reconciled.value.kind !== "matched") {
        return this.#stopAfterTargetFact(reconciled.value);
      }
      this.#page = reconciled.value.page;
      if (this.#options.externalMonitor !== undefined) {
        const transitioned = await inspectPinnedTarget(
          this.#page,
          this.#options.probe,
          this.#approvedTarget!,
          request.target,
          signal,
          this.#options.timeoutMs,
        );
        if (!transitioned.ok) {
          this.#emitAccountNavigationTrace(
            `posting_navigation_transition_inspection_failed_${transitioned.error.code}`,
          );
          return failure("browser_effect_uncertain");
        }
        this.#emitAccountNavigationTrace(
          `posting_navigation_transition_inspection_observed_${transitioned.value.target.kind}`,
        );
        if (transitioned.value.target.kind !== "matched") {
          return failure("browser_effect_uncertain");
        }
        try {
          this.#emitAccountNavigationTrace("posting_navigation_transition_monitor_started");
          await this.#options.externalMonitor.auth(
            this.#page as never,
            authMonitorPhase(transitioned.value.snapshot),
            "transition",
            authMonitorTaxonomy(transitioned.value.snapshot),
            { operationId: monitorOperationId, attempt: monitorAttempt },
            signal,
          );
          this.#emitAccountNavigationTrace("posting_navigation_transition_monitor_succeeded");
        } catch {
          this.#emitAccountNavigationTrace("posting_navigation_transition_monitor_failed");
          return failure("browser_effect_uncertain");
        }
      }
    }
    const final = await inspectPinnedTarget(
      this.#page!,
      this.#options.probe,
      this.#approvedTarget!,
      request.target,
      signal,
      this.#options.timeoutMs,
    );
    if (!final.ok) return final;
    if (final.value.target.kind !== "matched") {
      return this.#stopAfterTargetFact(final.value.target);
    }
    return classifyWorkdayAccountNavigation(final.value.snapshot).kind === "account_boundary"
      ? { ok: true, value: { kind: "account_boundary" } }
      : failure("browser_target_invalid");
  }

  #emitAccountNavigationTrace(event: PostingNavigationSessionTraceEvent): void {
    try {
      this.#options.accountNavigationTrace?.(event);
    } catch {
      // Diagnostics must never change navigation behavior.
    }
  }

  #validAdvanceRequest(request: AccountEntryAdvanceRequest): boolean {
    return request.schemaVersion === 1 &&
      this.#options.postingNavigation !== undefined &&
      this.#context !== undefined &&
      this.#page !== undefined &&
      !this.#page.isClosed() &&
      this.#session !== undefined &&
      this.#approvedTarget !== undefined &&
      this.#marker !== undefined &&
      request.journeyId === this.#session.journeyId &&
      request.sessionId === this.#session.sessionId &&
      sameTarget(request.target, this.#session.target) &&
      Number.isFinite(Date.parse(request.now)) &&
      Date.parse(request.now) >= Date.parse(this.#marker.admittedAt) &&
      Date.parse(request.now) < Date.parse(this.#session.leaseExpiresAt);
  }

  async #stopAfterTargetFact(
    fact: Exclude<AccountEntryAdvanceResult, { readonly kind: "account_boundary" }>,
  ): Promise<AccountEntryAdvancePortResult> {
    if (this.#profilePath === undefined) return failure("browser_profile_cleanup_failed");
    const cleaned = await this.#cleanupFailedOpen(this.#profilePath, this.#marker);
    if (!cleaned.resourcesCleaned) return failure("browser_profile_cleanup_failed");
    return cleaned.inspectionPassed
      ? { ok: true, value: copyAdvanceFact(fact) }
      : failure("browser_effect_uncertain");
  }

  async #reclassifyAfterUnavailableControl(
    previous: "job_posting" | "apply_choice" | "email_sign_in_choice",
    request: AccountEntryAdvanceRequest,
    signal: AbortSignal,
  ): Promise<AccountEntryAdvancePortResult | "retry" | undefined> {
    const inspected = await inspectPinnedTarget(
      this.#page!,
      this.#options.probe,
      this.#approvedTarget!,
      request.target,
      signal,
      this.#options.timeoutMs,
    );
    if (!inspected.ok) return inspected;
    if (inspected.value.target.kind !== "matched") {
      return this.#stopAfterTargetFact(inspected.value.target);
    }
    const settled = classifyWorkdayAccountNavigation(inspected.value.snapshot);
    if (settled.kind === previous) return undefined;
    if (settled.kind === "account_boundary") {
      return { ok: true, value: { kind: "account_boundary" } };
    }
    if (settled.kind === "ambiguous") return failure("browser_target_ambiguous");
    if (settled.kind === "invalid") return failure("browser_target_invalid");
    return navigationRank(settled.kind) > navigationRank(previous)
      ? "retry"
      : failure("browser_target_invalid");
  }

  async #reconcileAfterUncertainActivation(
    previous: "job_posting" | "apply_choice" | "email_sign_in_choice",
    request: AccountEntryAdvanceRequest,
    signal: AbortSignal,
    monitor: { readonly operationId: import("../../contracts/index.ts").OperationId; readonly attempt: number },
  ): Promise<AccountEntryAdvancePortResult | "retry" | undefined> {
    const reconciled = await reconcileOwnedPages(
      this.#context!,
      this.#options.probe,
      this.#approvedTarget!,
      request.target,
      signal,
      this.#options.timeoutMs,
    );
    if (!reconciled.ok) return undefined;
    if (reconciled.value.kind !== "matched") {
      return this.#stopAfterTargetFact(reconciled.value);
    }
    this.#page = reconciled.value.page;
    const inspected = await inspectPinnedTarget(
      this.#page,
      this.#options.probe,
      this.#approvedTarget!,
      request.target,
      signal,
      this.#options.timeoutMs,
    );
    if (!inspected.ok) return undefined;
    if (inspected.value.target.kind !== "matched") {
      return this.#stopAfterTargetFact(inspected.value.target);
    }
    if (this.#options.externalMonitor !== undefined) {
      try {
        await this.#options.externalMonitor.auth(
          this.#page as never,
          authMonitorPhase(inspected.value.snapshot),
          "transition",
          authMonitorTaxonomy(inspected.value.snapshot),
          monitor,
          signal,
        );
      } catch {
        return undefined;
      }
    }
    const settled = classifyWorkdayAccountNavigation(inspected.value.snapshot);
    if (settled.kind === "account_boundary") {
      return { ok: true, value: { kind: "account_boundary" } };
    }
    if (
      settled.kind !== "ambiguous" &&
      settled.kind !== "invalid" &&
      navigationRank(settled.kind) > navigationRank(previous)
    ) return "retry";
    return undefined;
  }

  async #uncertainAdvanceFailure(): Promise<AccountEntryAdvancePortResult> {
    if (this.#profilePath === undefined) return failure("browser_profile_cleanup_failed");
    const cleaned = await this.#cleanupFailedOpen(this.#profilePath, this.#marker);
    return cleaned.resourcesCleaned
      ? failure("browser_effect_uncertain")
      : failure("browser_profile_cleanup_failed");
  }

  async #invalidateAccountSession(): Promise<void> {
    if (this.#profilePath === undefined) return;
    await this.#cleanupFailedOpen(this.#profilePath, this.#marker);
  }

  async #closeOnce(
    request: PersistentBrowserCloseRequest,
    signal: AbortSignal,
  ): Promise<ClosePortResult> {
    if (signal.aborted) return cancelled();
    if (
      this.#cleanupFailedSessionId === request.sessionId &&
      this.#cleanupFailedJourneyId === request.journeyId
    ) {
      return failure("browser_profile_cleanup_failed");
    }
    if (
      this.#inspectionFailedSessionId === request.sessionId &&
      this.#inspectionFailedJourneyId === request.journeyId
    ) {
      return failure("browser_effect_uncertain");
    }
    if (
      this.#closedSessionId === request.sessionId &&
      this.#closedJourneyId === request.journeyId
    ) {
      return { ok: true, value: undefined };
    }
    if (
      this.#session === undefined ||
      request.journeyId !== this.#session.journeyId ||
      request.sessionId !== this.#session.sessionId ||
      this.#context === undefined ||
      this.#profilePath === undefined ||
      this.#marker === undefined
    ) {
      return failure("browser_session_missing");
    }
    const context = this.#context;
    const profilePath = this.#profilePath;
    const marker = this.#marker;
    const closedSession = this.#session;
    const inspectionPassed = await this.#holdBeforeCleanup(context);
    const contextCleanup = await this.#boundedCleanup(() => context.close());
    const profileCleanup = await this.#boundedCleanup(
      () => this.#options.profiles.cleanup(profilePath, marker),
    );
    this.#context = undefined;
    this.#page = undefined;
    this.#approvedTarget = undefined;
    this.#marker = undefined;
    this.#profilePath = undefined;
    this.#applicationRuntime.revoke();
    if (
      !contextCleanup ||
      !profileCleanup
    ) {
      this.#cleanupFailedSessionId = closedSession.sessionId;
      this.#cleanupFailedJourneyId = closedSession.journeyId;
      return failure("browser_profile_cleanup_failed");
    }
    this.#closedSessionId = closedSession.sessionId;
    this.#closedJourneyId = closedSession.journeyId;
    if (!inspectionPassed) {
      this.#inspectionFailedSessionId = closedSession.sessionId;
      this.#inspectionFailedJourneyId = closedSession.journeyId;
      return failure("browser_effect_uncertain");
    }
    return { ok: true, value: undefined };
  }

  async #cleanupFailedOpen(
    profilePath: string,
    marker?: ProfileMarkerV1,
  ): Promise<FailedOpenCleanupResult> {
    const context = this.#context;
    const failedSession = this.#session;
    const inspectionPassed = await this.#holdBeforeCleanup(context);
    const contextCleaned = await this.#boundedCleanup(
      () => context?.close() ?? Promise.resolve(),
    );
    const profileCleaned = await this.#boundedCleanup(() => marker === undefined
      ? this.#options.profiles.cleanupPartial(profilePath)
      : this.#options.profiles.cleanup(profilePath, marker));
    this.#context = undefined;
    this.#page = undefined;
    this.#session = undefined;
    this.#approvedTarget = undefined;
    this.#marker = undefined;
    this.#profilePath = undefined;
    this.#applicationRuntime.revoke();
    const cleaned = contextCleaned && profileCleaned;
    if (failedSession !== undefined) {
      if (cleaned && inspectionPassed) {
        this.#closedSessionId = failedSession.sessionId;
        this.#closedJourneyId = failedSession.journeyId;
      } else if (cleaned) {
        this.#inspectionFailedSessionId = failedSession.sessionId;
        this.#inspectionFailedJourneyId = failedSession.journeyId;
      } else {
        this.#cleanupFailedSessionId = failedSession.sessionId;
        this.#cleanupFailedJourneyId = failedSession.journeyId;
      }
    }
    return { inspectionPassed, resourcesCleaned: cleaned };
  }

  #resetTerminalCleanup(): void {
    this.#closedSessionId = undefined;
    this.#closedJourneyId = undefined;
    this.#cleanupFailedSessionId = undefined;
    this.#cleanupFailedJourneyId = undefined;
    this.#inspectionFailedSessionId = undefined;
    this.#inspectionFailedJourneyId = undefined;
  }

  async #cleanupDetachedContext(
    context: PersistentContext,
    profilePath: string,
  ): Promise<void> {
    await this.#holdBeforeCleanup(context);
    await this.#boundedCleanup(() => context.close());
    await this.#boundedCleanup(
      () => this.#options.profiles.cleanupPartial(profilePath),
    );
  }

  async #holdBeforeCleanup(context: PersistentContext | undefined): Promise<boolean> {
    if (context === undefined || this.#options.inspectionHoldBeforeCleanup === undefined) return true;
    try {
      await this.#options.inspectionHoldBeforeCleanup();
      return true;
    } catch {
      return false;
    }
  }

  async #boundedCleanup(action: () => Promise<unknown>): Promise<boolean> {
    const result = await bounded(
      Promise.resolve().then(action),
      new AbortController().signal,
      this.#options.timeoutMs,
    );
    return result.kind === "value";
  }
}

class RevocableWorkdayApplicationRuntime {
  #runtime: OwnedWorkdayApplicationRuntime | undefined;

  constructor(options: OwnedWorkdayApplicationRuntimeOptions | undefined) {
    this.#runtime = options === undefined
      ? undefined
      : new OwnedWorkdayApplicationRuntime(options);
  }

  current(): OwnedWorkdayApplicationRuntime | undefined {
    return this.#runtime;
  }

  revoke(): void {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    runtime?.dispose();
  }
}

type OpenPortResult = LivePortResult<
  PersistentBrowserOpenResult,
  PersistentBrowserErrorCode
>;
type ClosePortResult = LivePortResult<void, PersistentBrowserErrorCode>;
type ReconcilePortResult = LivePortResult<
  PersistentBrowserReconcileResult,
  PersistentBrowserErrorCode
>;

function admissibleInitialTarget(
  target: OwnedTargetInspection["target"],
): boolean {
  return target.kind === "matched" || target.kind === "posting_unavailable";
}

function navigationRank(
  state: "job_posting" | "apply_choice" | "email_sign_in_choice",
): number {
  return state === "job_posting" ? 0 : state === "apply_choice" ? 1 : 2;
}

function copyAdvanceFact(
  fact: Exclude<AccountEntryAdvanceResult, { readonly kind: "account_boundary" }>,
): Exclude<AccountEntryAdvanceResult, { readonly kind: "account_boundary" }> {
  if (fact.kind === "target_mismatch") {
    return Object.freeze({ kind: fact.kind, dimension: fact.dimension });
  }
  if (fact.kind === "posting_unavailable") {
    return Object.freeze({ kind: fact.kind, reason: fact.reason });
  }
  return Object.freeze({ kind: "target_ambiguous" });
}
import { createHash } from "node:crypto";
import { generatedOperationId } from "../../contracts/index.ts";
