import type {
  LiveBrowserSessionV1,
  LivePortResult,
  PersistentBrowserErrorCode,
  VerificationNavigationResult,
} from "../../../contracts/live/index.ts";
import { OwnedVerificationNavigationAccessScope } from "./owned-verification-navigation-access.ts";
import { authMonitorPhase, authMonitorTaxonomy } from "./owned-account-page-coordinator.ts";
import { inspectPinnedTarget } from "./owned-page-inspection.ts";
import { cancelled, failure } from "./port-results.ts";
import { sameTarget } from "./target-binding.ts";
import type {
  ApprovedTargetBinding,
  OwnedTargetProbe,
  PersistentPage,
  ProfileMarkerV1,
} from "./types.ts";
import type {
  ByteScopedVerificationBrowserCapability,
  OwnedVerificationNavigationAccessRequest,
  SemanticVerificationNavigationAdapter,
} from "./verification-navigation-types.ts";
import type { ExternalMonitorPort } from "./external-monitor-port.ts";
import { isStablePostVerificationState } from "./workday-verification-navigation.ts";
import { valueFreeExternalMonitorPage } from "./value-free-external-monitor-page.ts";

interface VerificationOwnershipState {
  readonly page: PersistentPage | undefined;
  readonly session: LiveBrowserSessionV1 | undefined;
  readonly approvedTarget: ApprovedTargetBinding | undefined;
  readonly marker: ProfileMarkerV1 | undefined;
}

interface CoordinatorOptions {
  readonly adapter: SemanticVerificationNavigationAdapter | undefined;
  readonly probe: OwnedTargetProbe;
  readonly timeoutMs: number;
  readonly state: () => VerificationOwnershipState;
  readonly invalidate: () => Promise<void>;
  readonly externalMonitor?: Pick<ExternalMonitorPort, "auth">;
}

type NavigationPortResult = LivePortResult<
  VerificationNavigationResult,
  PersistentBrowserErrorCode
>;

export class OwnedVerificationNavigationCoordinator {
  readonly #options: CoordinatorOptions;
  #active = false;
  readonly #monitorAttempts = new Map<string, number>();
  #pendingMonitor: { readonly operationId: string; readonly attempt: number } | undefined;

  constructor(options: CoordinatorOptions) { this.#options = options; }

  async withAccess(
    request: OwnedVerificationNavigationAccessRequest,
    signal: AbortSignal,
    use: (access: ByteScopedVerificationBrowserCapability) => Promise<void>,
  ): Promise<NavigationPortResult> {
    if (signal.aborted) return cancelled();
    if (this.#active) return failure("browser_operation_replayed");
    const state = this.#options.state();
    if (!validAdmission(state, this.#options.adapter, request)) {
      return failure("browser_session_missing");
    }
    const page = state.page!;
    const approvedTarget = state.approvedTarget!;
    const initial = await this.#inspect(page, approvedTarget, request, signal);
    if (!initial.ok) return initial;
    if (initial.value.target.kind !== "matched") return failure("browser_target_invalid");
    this.#active = true;
    const scope = new OwnedVerificationNavigationAccessScope(
      page,
      this.#options.adapter!,
      approvedTarget,
      signal,
      this.#options.timeoutMs,
      (effectSignal) => this.#revalidateBeforeEffect(
        page, approvedTarget, request, effectSignal,
      ),
      (effectSignal) => this.#observeAfterEffect(
        page, approvedTarget, request, effectSignal,
      ),
      (effectSignal) => this.#monitorBeforeNavigation(
        page, initial.value.snapshot, request, effectSignal,
      ),
      this.#options.invalidate,
      this.#options.externalMonitor !== undefined,
    );
    try {
      await use(scope.capability);
    } catch {
      await scope.failCallback();
    } finally {
      scope.deactivate();
      this.#active = false;
    }
    if (scope.terminalError === "operation_cancelled") return cancelled();
    if (scope.terminalError !== undefined) {
      if (scope.effectStarted && this.#pendingMonitor !== undefined) {
        const uncertain = await this.#inspect(
          page,
          approvedTarget,
          request,
          new AbortController().signal,
        );
        if (uncertain.ok && uncertain.value.target.kind === "matched") {
          await this.#monitorTransition(
            page,
            uncertain.value.snapshot,
            request,
            new AbortController().signal,
          );
        }
        await this.#options.invalidate();
      }
      return failure(scope.terminalError);
    }
    return scope.used && scope.result !== undefined
      ? { ok: true, value: scope.result }
      : failure("browser_target_invalid");
  }

  async #inspect(
    page: PersistentPage,
    approvedTarget: ApprovedTargetBinding,
    request: OwnedVerificationNavigationAccessRequest,
    signal: AbortSignal,
  ) {
    return inspectPinnedTarget(
      page,
      this.#options.probe,
      approvedTarget,
      request.target,
      signal,
      this.#options.timeoutMs,
    );
  }

  async #revalidateBeforeEffect(
    page: PersistentPage,
    approvedTarget: ApprovedTargetBinding,
    request: OwnedVerificationNavigationAccessRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>> {
    if (!sameOwnership(this.#options.state(), page, approvedTarget, request)) {
      return failure("browser_session_invalidated");
    }
    const inspected = await this.#inspect(page, approvedTarget, request, signal);
    return inspected.ok && inspected.value.target.kind === "matched"
      ? { ok: true, value: undefined }
      : inspected.ok
        ? failure("browser_session_invalidated")
        : inspected;
  }

  async #observeAfterEffect(
    page: PersistentPage,
    approvedTarget: ApprovedTargetBinding,
    request: OwnedVerificationNavigationAccessRequest,
    signal: AbortSignal,
  ): Promise<NavigationPortResult> {
    const deadline = Date.now() + Math.min(this.#options.timeoutMs, 30_000);
    while (true) {
      if (!sameOwnership(this.#options.state(), page, approvedTarget, request)) {
        return failure("browser_session_invalidated");
      }
      const inspected = await this.#inspect(page, approvedTarget, request, signal);
      if (!inspected.ok) return inspected;
      if (inspected.value.target.kind === "posting_unavailable") {
        return { ok: true, value: { kind: "target_unavailable" } };
      }
      if (inspected.value.target.kind !== "matched") {
        return failure("browser_target_invalid");
      }
      if (isStablePostVerificationState(inspected.value.snapshot)) {
        if (!await this.#monitorTransition(page, inspected.value.snapshot, request, signal)) {
          return failure("browser_effect_uncertain");
        }
        return { ok: true, value: { kind: "navigated" } };
      }
      if (
        signal.aborted || Date.now() >= deadline ||
        inspected.value.snapshot.traitIds.some((trait) =>
          trait === "structural_trait_challenge_captcha_v1" ||
          trait === "structural_trait_challenge_mfa_v1" ||
          trait === "structural_trait_challenge_access_control_v1"
        )
      ) return failure("browser_target_invalid");
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }

  async #monitorBeforeNavigation(
    page: PersistentPage,
    snapshot: import("./types.ts").ValueFreeOwnedPageSnapshot,
    request: OwnedVerificationNavigationAccessRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>> {
    if (this.#options.externalMonitor === undefined) return { ok: true, value: undefined };
    const phase = authMonitorPhase(snapshot);
    if (phase === "unknown") return failure("browser_target_invalid");
    const attempt = (this.#monitorAttempts.get(phase) ?? 0) + 1;
    try {
      await this.#options.externalMonitor.auth(
        valueFreeExternalMonitorPage(page),
        phase,
        "before_navigation",
        authMonitorTaxonomy(snapshot),
        { operationId: request.operationId, attempt },
        signal,
      );
      this.#monitorAttempts.set(phase, attempt);
      this.#pendingMonitor = Object.freeze({ operationId: request.operationId, attempt });
      return { ok: true, value: undefined };
    } catch {
      return failure("browser_effect_uncertain");
    }
  }

  async #monitorTransition(
    page: PersistentPage,
    snapshot: import("./types.ts").ValueFreeOwnedPageSnapshot,
    request: OwnedVerificationNavigationAccessRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.#options.externalMonitor === undefined) return true;
    const phase = authMonitorPhase(snapshot);
    const pending = this.#pendingMonitor;
    if (phase === "unknown" || pending === undefined ||
        pending.operationId !== request.operationId) return false;
    try {
      await this.#options.externalMonitor.auth(
        valueFreeExternalMonitorPage(page),
        phase,
        "transition",
        authMonitorTaxonomy(snapshot),
        { operationId: request.operationId, attempt: pending.attempt },
        signal,
      );
      this.#pendingMonitor = undefined;
      return true;
    } catch {
      return false;
    }
  }
}

function validAdmission(
  state: VerificationOwnershipState,
  adapter: SemanticVerificationNavigationAdapter | undefined,
  request: OwnedVerificationNavigationAccessRequest,
): boolean {
  const now = Date.parse(request.now);
  return request.schemaVersion === 1 && adapter !== undefined &&
    state.page !== undefined && !state.page.isClosed() &&
    state.session !== undefined && state.approvedTarget !== undefined &&
    state.marker !== undefined && request.journeyId === state.session.journeyId &&
    request.sessionId === state.session.sessionId &&
    sameTarget(request.target, state.session.target) &&
    request.journeyId === state.marker.journeyId &&
    request.sessionId === state.marker.sessionId &&
    sameTarget(request.target, state.marker.target) && Number.isFinite(now) &&
    now >= Date.parse(state.marker.admittedAt) &&
    now < Date.parse(state.session.leaseExpiresAt);
}

function sameOwnership(
  state: VerificationOwnershipState,
  page: PersistentPage,
  approvedTarget: ApprovedTargetBinding,
  request: OwnedVerificationNavigationAccessRequest,
): boolean {
  return state.page === page && state.approvedTarget === approvedTarget &&
    state.session?.sessionId === request.sessionId &&
    sameTarget(state.session.target, request.target);
}
