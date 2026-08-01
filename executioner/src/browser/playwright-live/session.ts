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
import type {
  OwnedAccountPageAccess,
  OwnedAccountPageAccessRequest,
} from "./private/account-page-types.ts";
import type {
  AccountEntryAdvancePortResult,
  AccountEntryAdvanceRequest,
  AccountEntryAdvanceResult,
  PostingNavigationAction,
} from "./private/account-navigation-types.ts";
import { OwnedAccountPageCoordinator } from "./private/owned-account-page-coordinator.ts";
import { bounded, cancelled, failure } from "./private/port-results.ts";
import { isExactMarker, sessionFromMarker } from "./private/profile-marker.ts";
import { bindApprovedTarget, sameSession, sameTarget } from "./private/target-binding.ts";
import { classifyWorkdayAccountNavigation } from "./private/workday-account-navigation.ts";
import type {
  PersistentContext,
  PersistentPage,
  PlaywrightPersistentBrowserSessionOptions,
  ProfileMarkerV1,
  ApprovedTargetBinding,
  OwnedTargetInspection,
} from "./private/types.ts";

export class PlaywrightPersistentBrowserSession
  implements PersistentBrowserSession
{
  readonly #options: PlaywrightPersistentBrowserSessionOptions;
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
  readonly #accountAccess: OwnedAccountPageCoordinator;
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

  constructor(options: PlaywrightPersistentBrowserSessionOptions) {
    this.#options = options;
    this.#accountAccess = new OwnedAccountPageCoordinator({
      adapter: options.accountPage,
      probe: options.probe,
      timeoutMs: options.timeoutMs,
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
    const result = this.#openOnce(request, signal);
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
            if (!cleaned) return failure("browser_profile_cleanup_failed");
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
            observation.target.kind === "matched"
          ) {
            owned.push(page);
          }
        }
        if (owned.length !== 1) {
          const cleaned = await this.#cleanupFailedOpen(
            runtime.profilePath,
            persisted,
          );
          return cleaned
            ? failure(
                owned.length === 0
                  ? "browser_session_missing"
                  : "browser_target_ambiguous",
              )
            : failure("browser_profile_cleanup_failed");
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
      const pageResult = await bounded(
        this.#context.newPage(),
        signal,
        this.#options.timeoutMs,
      );
      if (pageResult.kind !== "value") {
        const cleaned = await this.#cleanupFailedOpen(runtime.profilePath);
        return cleaned
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
        return cleaned
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
        return cleaned
          ? failure("browser_effect_uncertain")
          : failure("browser_profile_cleanup_failed");
      }
      const observation = inspected.value;
      if (
        observation.ownership !== "owned" ||
        observation.target.kind !== "matched"
      ) {
        const cleaned = await this.#cleanupFailedOpen(runtime.profilePath);
        return cleaned
          ? failure("browser_target_invalid")
          : failure("browser_profile_cleanup_failed");
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
        return cleaned
          ? failure("browser_effect_uncertain")
          : failure("browser_profile_cleanup_failed");
      }
      this.#marker = marker;
      return { ok: true, value: { kind: "opened", session: this.#session } };
    } catch {
      const cleaned = await this.#cleanupFailedOpen(runtime.profilePath);
      return cleaned
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
    while (transitionCount < 2) {
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
      if (state.kind === "job_posting" && transitionCount !== 0) {
        return failure("browser_target_invalid");
      }
      const action: PostingNavigationAction = state.kind === "job_posting"
        ? "start_application"
        : "apply_manually";
      const control = await bounded(
        this.#options.postingNavigation!.inspect(this.#page!, action),
        signal,
        this.#options.timeoutMs,
      );
      if (control.kind === "cancelled") return cancelled();
      if (control.kind === "timeout") return failure("browser_timeout");
      if (control.kind === "error") return failure("browser_target_invalid");
      if (control.value.cardinality > 1) {
        return failure("browser_target_ambiguous");
      }
      if (control.value.cardinality !== 1 || !control.value.actionable) {
        return failure("browser_target_invalid");
      }
      const activated = await bounded(
        this.#options.postingNavigation!.activate(this.#page!, action),
        signal,
        this.#options.timeoutMs,
      );
      transitionCount += 1;
      if (activated.kind !== "value") return this.#uncertainAdvanceFailure();
      const reconciled = await reconcileOwnedPages(
        this.#context!,
        this.#options.probe,
        this.#approvedTarget!,
        request.target,
        signal,
        this.#options.timeoutMs,
      );
      if (!reconciled.ok) return this.#uncertainAdvanceFailure();
      if (reconciled.value.kind !== "matched") {
        return this.#stopAfterTargetFact(reconciled.value);
      }
      this.#page = reconciled.value.page;
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
    const cleaned = this.#profilePath !== undefined &&
      await this.#cleanupFailedOpen(this.#profilePath, this.#marker);
    return cleaned
      ? { ok: true, value: copyAdvanceFact(fact) }
      : failure("browser_profile_cleanup_failed");
  }

  async #uncertainAdvanceFailure(): Promise<AccountEntryAdvancePortResult> {
    const cleaned = this.#profilePath !== undefined &&
      await this.#cleanupFailedOpen(this.#profilePath, this.#marker);
    return cleaned
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
    const contextCleanup = await this.#boundedCleanup(() => context.close());
    const profileCleanup = await this.#boundedCleanup(
      () => this.#options.profiles.cleanup(profilePath, marker),
    );
    this.#context = undefined;
    this.#page = undefined;
    this.#approvedTarget = undefined;
    this.#marker = undefined;
    this.#profilePath = undefined;
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
    return { ok: true, value: undefined };
  }

  async #cleanupFailedOpen(
    profilePath: string,
    marker?: ProfileMarkerV1,
  ): Promise<boolean> {
    const context = this.#context;
    const failedSession = this.#session;
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
    const cleaned = contextCleaned && profileCleaned;
    if (failedSession !== undefined) {
      if (cleaned) {
        this.#closedSessionId = failedSession.sessionId;
        this.#closedJourneyId = failedSession.journeyId;
      } else {
        this.#cleanupFailedSessionId = failedSession.sessionId;
        this.#cleanupFailedJourneyId = failedSession.journeyId;
      }
    }
    return cleaned;
  }

  #resetTerminalCleanup(): void {
    this.#closedSessionId = undefined;
    this.#closedJourneyId = undefined;
    this.#cleanupFailedSessionId = undefined;
    this.#cleanupFailedJourneyId = undefined;
  }

  async #cleanupDetachedContext(
    context: PersistentContext,
    profilePath: string,
  ): Promise<void> {
    await this.#boundedCleanup(() => context.close());
    await this.#boundedCleanup(
      () => this.#options.profiles.cleanupPartial(profilePath),
    );
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

type OpenPortResult = LivePortResult<
  PersistentBrowserOpenResult,
  PersistentBrowserErrorCode
>;
type ClosePortResult = LivePortResult<void, PersistentBrowserErrorCode>;
type ReconcilePortResult = LivePortResult<
  PersistentBrowserReconcileResult,
  PersistentBrowserErrorCode
>;

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
