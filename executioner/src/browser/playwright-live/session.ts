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
import { OwnedAccountPageCoordinator } from "./private/owned-account-page-coordinator.ts";
import { bounded, cancelled, failure } from "./private/port-results.ts";
import { isExactMarker, sessionFromMarker } from "./private/profile-marker.ts";
import { bindApprovedTarget, sameSession, sameTarget } from "./private/target-binding.ts";
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
      this.#closedSessionId === request.sessionId &&
      request.journeyId === this.#session?.journeyId
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
    const [contextCleanup, profileCleanup] = await Promise.all([
      this.#boundedCleanup(() => context.close()),
      this.#boundedCleanup(() => this.#options.profiles.cleanup(profilePath, marker)),
    ]);
    this.#context = undefined;
    this.#page = undefined;
    this.#approvedTarget = undefined;
    this.#marker = undefined;
    this.#profilePath = undefined;
    this.#closedSessionId = closedSession.sessionId;
    if (
      !contextCleanup ||
      !profileCleanup
    ) {
      return failure("browser_profile_cleanup_failed");
    }
    return { ok: true, value: undefined };
  }

  async #cleanupFailedOpen(
    profilePath: string,
    marker?: ProfileMarkerV1,
  ): Promise<boolean> {
    const context = this.#context;
    const [contextCleaned, profileCleaned] = await Promise.all([
      this.#boundedCleanup(() => context?.close() ?? Promise.resolve()),
      this.#boundedCleanup(() => marker === undefined
        ? this.#options.profiles.cleanupPartial(profilePath)
        : this.#options.profiles.cleanup(profilePath, marker)),
    ]);
    this.#context = undefined;
    this.#page = undefined;
    this.#session = undefined;
    this.#approvedTarget = undefined;
    this.#marker = undefined;
    this.#profilePath = undefined;
    return contextCleaned && profileCleaned;
  }

  async #cleanupDetachedContext(
    context: PersistentContext,
    profilePath: string,
  ): Promise<void> {
    await Promise.all([
      this.#boundedCleanup(() => context.close()),
      this.#boundedCleanup(() => this.#options.profiles.cleanupPartial(profilePath)),
    ]);
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
