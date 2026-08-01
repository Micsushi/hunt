import type {
  LiveBrowserSessionV1,
  LivePortResult,
  PersistentBrowserErrorCode,
} from "../../../contracts/live/index.ts";
import type {
  OwnedAccountPageAccess,
  OwnedAccountPageAccessRequest,
  SemanticAccountPageAdapter,
} from "./account-page-types.ts";
import { OwnedAccountPageAccessScope } from "./owned-account-page-access.ts";
import { inspectPinnedTarget } from "./owned-page-inspection.ts";
import { cancelled, failure } from "./port-results.ts";
import { sameTarget } from "./target-binding.ts";
import type {
  ApprovedTargetBinding,
  OwnedTargetProbe,
  PersistentPage,
  ProfileMarkerV1,
} from "./types.ts";

export interface AccountPageOwnershipState {
  readonly page: PersistentPage | undefined;
  readonly session: LiveBrowserSessionV1 | undefined;
  readonly approvedTarget: ApprovedTargetBinding | undefined;
  readonly marker: ProfileMarkerV1 | undefined;
}

interface OwnedAccountPageCoordinatorOptions {
  readonly adapter: SemanticAccountPageAdapter | undefined;
  readonly probe: OwnedTargetProbe;
  readonly timeoutMs: number;
  readonly state: () => AccountPageOwnershipState;
  readonly invalidate: () => Promise<void>;
}

export class OwnedAccountPageCoordinator {
  readonly #options: OwnedAccountPageCoordinatorOptions;
  readonly #operations = new Set<string>();
  #active = false;

  constructor(options: OwnedAccountPageCoordinatorOptions) {
    this.#options = options;
  }

  async withAccess(
    request: OwnedAccountPageAccessRequest,
    signal: AbortSignal,
    use: (access: OwnedAccountPageAccess) => Promise<void>,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>> {
    if (signal.aborted) return cancelled();
    if (this.#active || this.#operations.has(request.operationId)) {
      return failure("browser_operation_replayed");
    }
    const state = this.#options.state();
    const now = Date.parse(request.now);
    if (!validAdmission(state, this.#options.adapter, request, now)) {
      return failure("browser_session_missing");
    }
    const page = state.page!;
    const approvedTarget = state.approvedTarget!;
    const adapter = this.#options.adapter!;
    const owned = await inspectPinnedTarget(
      page,
      this.#options.probe,
      approvedTarget,
      request.target,
      signal,
      this.#options.timeoutMs,
    );
    if (!owned.ok) return owned;
    if (owned.value.target.kind !== "matched") {
      return failure("browser_target_invalid");
    }
    this.#active = true;
    this.#operations.add(request.operationId);
    const scope = new OwnedAccountPageAccessScope(
      page,
      adapter,
      signal,
      this.#options.timeoutMs,
      () => this.#revalidate(page, approvedTarget, request, signal),
      this.#options.invalidate,
    );
    try {
      await use(scope);
      if (scope.terminalError === "operation_cancelled") return cancelled();
      if (scope.terminalError === "browser_effect_uncertain" || scope.hasUnverifiedEffect) {
        await this.#options.invalidate();
        return failure("browser_effect_uncertain");
      }
      if (scope.terminalError !== undefined) return failure(scope.terminalError);
      return { ok: true, value: undefined };
    } catch {
      await this.#options.invalidate();
      return failure("browser_effect_uncertain");
    } finally {
      scope.deactivate();
      this.#active = false;
    }
  }

  async #revalidate(
    page: PersistentPage,
    approvedTarget: ApprovedTargetBinding,
    request: OwnedAccountPageAccessRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>> {
    const current = this.#options.state();
    if (
      current.page !== page ||
      current.approvedTarget !== approvedTarget ||
      current.session?.sessionId !== request.sessionId
    ) return failure("browser_session_invalidated");
    const inspected = await inspectPinnedTarget(
      page,
      this.#options.probe,
      approvedTarget,
      request.target,
      signal,
      this.#options.timeoutMs,
    );
    return inspected.ok && inspected.value.target.kind === "matched"
      ? { ok: true, value: undefined }
      : failure("browser_session_invalidated");
  }
}

function validAdmission(
  state: AccountPageOwnershipState,
  adapter: SemanticAccountPageAdapter | undefined,
  request: OwnedAccountPageAccessRequest,
  now: number,
): boolean {
  return adapter !== undefined &&
    request.schemaVersion === 1 &&
    state.page !== undefined &&
    !state.page.isClosed() &&
    state.session !== undefined &&
    state.approvedTarget !== undefined &&
    state.marker !== undefined &&
    request.journeyId === state.session.journeyId &&
    request.sessionId === state.session.sessionId &&
    sameTarget(request.target, state.session.target) &&
    request.journeyId === state.marker.journeyId &&
    request.sessionId === state.marker.sessionId &&
    sameTarget(request.target, state.marker.target) &&
    Number.isFinite(now) &&
    now >= Date.parse(state.marker.admittedAt) &&
    now < Date.parse(state.session.leaseExpiresAt);
}
