import type { AccountPageAccessProvider } from "../../account/entry/index.ts";
import type {
  AccountLifecycleVerificationEmailRequester,
  VerificationEmailRequest,
} from "../../account/lifecycle/types.ts";
import type {
  LivePortResult,
  PersistentBrowserErrorCode,
  S2PortError,
  TargetIdentityV1,
} from "../../contracts/live/index.ts";
import { s2StableErrorPolicy } from "../../contracts/s2-common-wire.ts";

type RequestResult = Awaited<
  ReturnType<AccountLifecycleVerificationEmailRequester["request"]>
>;

export function createVerificationEmailRequestAdapter(options: {
  readonly accountPage: AccountPageAccessProvider;
  readonly binding: {
    readonly approvalId: string;
    readonly journeyId: VerificationEmailRequest["journeyId"];
    readonly operationId: VerificationEmailRequest["operationId"];
    readonly sessionId: VerificationEmailRequest["sessionId"];
    readonly target: TargetIdentityV1;
  };
}): AccountLifecycleVerificationEmailRequester {
  let attempted = false;
  return Object.freeze({
    async request(request: VerificationEmailRequest, signal: AbortSignal): Promise<RequestResult> {
      if (!exactRequest(request, options.binding)) return failure("browser_target_invalid");
      if (attempted) return failure("browser_effect_uncertain");
      attempted = true;
      if (signal.aborted) return cancelled();
      let result: RequestResult | undefined;
      const scoped = await options.accountPage.withOwnedAccountPageAccess({
        schemaVersion: 1,
        journeyId: request.journeyId,
        operationId: request.operationId,
        sessionId: request.sessionId,
        target: request.target,
        now: request.now,
      }, signal, async (access) => {
        const inspected = await access.inspectAction("request_verification_email");
        if (!inspected.ok) {
          result = inspected;
          return;
        }
        if (inspected.value.cardinality === 0 && inspected.value.actionable) {
          result = { ok: true, value: { kind: "not_required" } };
          return;
        }
        if (inspected.value.cardinality !== 1 || !inspected.value.actionable) {
          result = failure(
            inspected.value.cardinality > 1
              ? "browser_target_ambiguous"
              : "browser_target_invalid",
          );
          return;
        }
        const activated = await access.activate("request_verification_email");
        result = activated.ok
          ? { ok: true, value: { kind: "sent", independentlyObserved: true } }
          : activated;
      });
      if (!scoped.ok) return scoped;
      return result ?? failure("browser_effect_uncertain");
    },
  });
}

function exactRequest(
  request: VerificationEmailRequest,
  binding: {
    readonly approvalId: string;
    readonly journeyId: VerificationEmailRequest["journeyId"];
    readonly operationId: VerificationEmailRequest["operationId"];
    readonly sessionId: VerificationEmailRequest["sessionId"];
    readonly target: TargetIdentityV1;
  },
): boolean {
  const parsedNow = Date.parse(request.now);
  return request.schemaVersion === 1 && request.approvalId === binding.approvalId &&
    request.journeyId === binding.journeyId && request.operationId === binding.operationId &&
    request.sessionId === binding.sessionId && sameTarget(request.target, binding.target) &&
    Number.isFinite(parsedNow) && new Date(parsedNow).toISOString() === request.now;
}

function sameTarget(left: TargetIdentityV1, right: TargetIdentityV1): boolean {
  return left.schemaVersion === right.schemaVersion && left.atsFamily === right.atsFamily &&
    left.hostId === right.hostId && left.tenantId === right.tenantId &&
    left.postingId === right.postingId;
}

function failure<const C extends PersistentBrowserErrorCode>(
  code: C,
): { readonly ok: false; readonly error: S2PortError<C> } {
  return {
    ok: false,
    error: { code, retryable: s2StableErrorPolicy[code].retryable } as S2PortError<C>,
  };
}

function cancelled(): LivePortResult<never, PersistentBrowserErrorCode> {
  return { ok: false, error: { code: "operation_cancelled", retryable: false } };
}
