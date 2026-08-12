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
import type { ExternalMonitorPort } from "./external-monitor-port.ts";

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
  readonly externalMonitor?: Pick<ExternalMonitorPort, "auth">;
}

export class OwnedAccountPageCoordinator {
  readonly #options: OwnedAccountPageCoordinatorOptions;
  readonly #operations = new Set<string>();
  #active = false;
  readonly #monitorAttempts = new Map<string, number>();

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
    const beforePage = authMonitorPhase(owned.value.snapshot);
    if (beforePage === "unknown" && this.#options.externalMonitor !== undefined) {
      await this.#observeUnknown(page, request, owned.value.snapshot, signal);
      return failure("browser_target_invalid");
    }
    const attempt = (this.#monitorAttempts.get(beforePage) ?? 0) + 1;
    if (!await this.#monitor(
      page,
      beforePage,
      "before_mutation",
      request.operationId,
      attempt,
      owned.value.snapshot,
      signal,
    )) return failure("browser_effect_uncertain");
    this.#monitorAttempts.set(beforePage, attempt);
    this.#active = true;
    this.#operations.add(request.operationId);
    const scope = new OwnedAccountPageAccessScope(
      page,
      adapter,
      signal,
      this.#options.timeoutMs,
      () => this.#revalidate(page, approvedTarget, request, signal),
      this.#options.invalidate,
      this.#options.externalMonitor === undefined
        ? undefined
        : () => this.#revalidateAfterTransition(page, approvedTarget, request, signal),
    );
    let callbackFailed = false;
    try {
      await use(scope);
    } catch {
      callbackFailed = true;
    } finally {
      scope.deactivate();
      this.#active = false;
    }
    if (this.#options.externalMonitor === undefined) {
      if (callbackFailed || scope.terminalError === "browser_effect_uncertain" ||
          scope.hasUnverifiedEffect) {
        await this.#options.invalidate();
        return failure("browser_effect_uncertain");
      }
      if (scope.terminalError === "operation_cancelled") return cancelled();
      if (scope.terminalError !== undefined) return failure(scope.terminalError);
      return { ok: true, value: undefined };
    }
    if (!scope.effectStarted) {
      await this.#options.invalidate();
      return failure("browser_effect_uncertain");
    }
    const after = await inspectPinnedTarget(
      page,
      this.#options.probe,
      approvedTarget,
      request.target,
      new AbortController().signal,
      this.#options.timeoutMs,
    );
    const afterPage = after.ok && after.value.target.kind === "matched"
      ? authMonitorPhase(after.value.snapshot)
      : "unknown";
    const monitored = after.ok && after.value.target.kind === "matched" && await this.#monitor(
      page,
      afterPage,
      "after_readback",
      request.operationId,
      attempt,
      after.value.snapshot,
      new AbortController().signal,
    );
    if (!monitored || callbackFailed || scope.terminalError === "browser_effect_uncertain" ||
        scope.hasUnverifiedEffect) {
      await this.#options.invalidate();
      return failure("browser_effect_uncertain");
    }
    if (scope.terminalError === "operation_cancelled") return cancelled();
    if (scope.terminalError !== undefined) return failure(scope.terminalError);
    return { ok: true, value: undefined };
  }

  async #observeUnknown(
    page: PersistentPage,
    request: OwnedAccountPageAccessRequest,
    snapshot: import("./types.ts").ValueFreeOwnedPageSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    const attempt = (this.#monitorAttempts.get("unknown:state") ?? 0) + 1;
    await this.#monitor(
      page,
      "unknown",
      "state_observed",
      request.operationId,
      attempt,
      snapshot,
      signal,
    );
    this.#monitorAttempts.set("unknown:state", attempt);
  }

  async #monitor(
    page: PersistentPage,
    phase: string,
    moment: string,
    operationId: OwnedAccountPageAccessRequest["operationId"],
    attempt: number,
    snapshot: import("./types.ts").ValueFreeOwnedPageSnapshot,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.#options.externalMonitor === undefined) return true;
    try {
      await this.#options.externalMonitor.auth(
        page as never,
        phase,
        moment,
        authMonitorTaxonomy(snapshot),
        { operationId, attempt },
        signal,
      );
      return true;
    } catch {
      return false;
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

  async #revalidateAfterTransition(
    page: PersistentPage,
    approvedTarget: ApprovedTargetBinding,
    request: OwnedAccountPageAccessRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>> {
    const deadline = Date.now() + this.#options.timeoutMs;
    while (!signal.aborted) {
      const current = this.#options.state();
      if (
        current.page !== page || current.approvedTarget !== approvedTarget ||
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
      if (inspected.ok && inspected.value.target.kind === "matched") {
        return { ok: true, value: undefined };
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    return failure("browser_session_invalidated");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

export function authMonitorPhase(snapshot: import("./types.ts").ValueFreeOwnedPageSnapshot): string {
  const traits = new Set(snapshot.traitIds);
  if (traits.has("structural_trait_challenge_captcha_v1")) return "captcha";
  if (traits.has("structural_trait_challenge_mfa_v1")) return "mfa";
  if (traits.has("structural_trait_challenge_access_control_v1")) return "access_control";
  if (traits.has("structural_trait_page_email_verification_v1")) return "verification_required";
  if (traits.has("structural_trait_page_account_entry_v1")) {
    return traits.has("structural_trait_account_sign_in_v1") ? "sign_in" : "account_entry";
  }
  if (traits.has("structural_trait_page_profile_step_v1") ||
      traits.has("structural_trait_page_questionnaire_v1") ||
      traits.has("structural_trait_page_review_step_v1") ||
      traits.has("structural_trait_page_candidate_home_v1")) return "application_ready";
  if (traits.has("structural_trait_navigation_email_sign_in_choice_v1")) {
    return "email_sign_in_choice";
  }
  if (traits.has("structural_trait_navigation_apply_choice_v1")) return "apply_choice";
  if (traits.has("structural_trait_page_job_posting_v1")) return "job_posting";
  return "unknown";
}

export function authMonitorTaxonomy(snapshot: import("./types.ts").ValueFreeOwnedPageSnapshot) {
  return Object.freeze({
    fieldCount: snapshot.controlCount,
    requiredFieldCount: snapshot.requiredControlCount,
    controlTypes: Object.freeze(snapshot.controlCount === 0 ? [] : ["text"]),
    questionTypes: Object.freeze(snapshot.controlCount === 0 ? [] : ["unknown"]),
    answerTypes: Object.freeze(snapshot.controlCount === 0 ? [] : ["text"]),
    validationState: "clear" as const,
    submitPresent: false,
    submitActivated: false as const,
  });
}
