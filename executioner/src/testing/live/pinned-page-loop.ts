import {
  providerError,
  type BrowserSession,
  type BrowserSessionError,
  type BrowserSessionResult,
  type PortError,
} from "../../contracts/index.ts";
import type {
  LiveBrowserSessionV1,
  PinnedPageLoopBindingRequestV1,
  PinnedPageLoopBrowserBinder,
  TargetIdentityV1,
} from "../../contracts/live/index.ts";

export interface PinnedPageLoopBinderFakeOptions {
  readonly browser: BrowserSession;
  readonly coordinates: BrowserSessionResult;
  readonly now: () => string;
  readonly validateStartTarget: (
    target: string,
    expected: TargetIdentityV1,
  ) => boolean;
}

export interface PinnedPageLoopBinderFake {
  readonly binder: PinnedPageLoopBrowserBinder;
  readonly calls: readonly string[];
  readonly lastSafeBinding: PinnedPageLoopBindingRequestV1 | null;
}

export function createPinnedPageLoopBrowserBinderFake(
  options: PinnedPageLoopBinderFakeOptions,
): PinnedPageLoopBinderFake {
  const calls: string[] = [];
  const consumed = new Set<string>();
  let lastSafeBinding: PinnedPageLoopBindingRequestV1 | null = null;

  const binder: PinnedPageLoopBrowserBinder = {
    async bind(request, signal) {
      if (signal.aborted) return failure("operation_cancelled");
      calls.push("bind");
      if (consumed.has(request.operationId)) {
        return failure("browser_operation_replayed");
      }
      if (
        request.journeyId !== request.session.journeyId ||
        !sameTarget(request.expectedTarget, request.session.target)
      ) {
        return failure("browser_target_invalid");
      }
      if (request.expectedSessionId !== request.session.sessionId) {
        return failure("browser_session_missing");
      }
      if (!hasCurrentLease(request.session, options.now)) {
        return failure("browser_target_stale");
      }

      consumed.add(request.operationId);
      lastSafeBinding = Object.freeze({ ...request });
      return {
        ok: true,
        value: boundBrowser(request),
      };
    },
  };

  function boundBrowser(
    binding: PinnedPageLoopBindingRequestV1,
  ): BrowserSession {
    let started = false;
    return {
      async start(request, signal) {
        if (signal.aborted) return failure("operation_cancelled");
        if (started) return failure("browser_operation_replayed");
        if (!hasCurrentLease(binding.session, options.now)) {
          return failure("browser_target_stale");
        }
        if (
          request.journeyId !== binding.journeyId ||
          !startTargetMatches(
            options.validateStartTarget,
            request.target,
            binding.expectedTarget,
          )
        ) {
          return failure("browser_target_invalid");
        }
        started = true;
        calls.push("start");
        return { ok: true, value: options.coordinates };
      },
      async observe(request, signal) {
        if (signal.aborted) return failure("operation_cancelled");
        if (!started) return failure("browser_session_missing");
        calls.push("observe");
        return options.browser.observe(request, signal);
      },
      async mutate(request, signal) {
        if (signal.aborted) return failure("operation_cancelled");
        if (!started) return failure("browser_session_missing");
        calls.push("mutate");
        return options.browser.mutate(request, signal);
      },
      async navigate(request, signal) {
        if (signal.aborted) return failure("operation_cancelled");
        if (!started) return failure("browser_session_missing");
        calls.push("navigate");
        return options.browser.navigate(request, signal);
      },
      async close(request, signal) {
        if (signal.aborted) return failure("operation_cancelled");
        if (!started) return failure("browser_session_missing");
        calls.push("close");
        return options.browser.close(request, signal);
      },
    };
  }

  return {
    binder,
    calls,
    get lastSafeBinding() {
      return lastSafeBinding;
    },
  };
}

function sameTarget(
  expected: TargetIdentityV1,
  actual: TargetIdentityV1,
): boolean {
  return expected.atsFamily === actual.atsFamily &&
    expected.hostId === actual.hostId &&
    expected.tenantId === actual.tenantId &&
    expected.postingId === actual.postingId;
}

function hasCurrentLease(
  session: LiveBrowserSessionV1,
  now: () => string,
): boolean {
  try {
    const expiresAt = Date.parse(session.leaseExpiresAt);
    const current = Date.parse(now());
    return Number.isFinite(expiresAt) &&
      Number.isFinite(current) &&
      expiresAt > current;
  } catch {
    return false;
  }
}

function startTargetMatches(
  validate: PinnedPageLoopBinderFakeOptions["validateStartTarget"],
  target: string,
  expected: TargetIdentityV1,
): boolean {
  try {
    return validate(target, expected);
  } catch {
    return false;
  }
}

type PinnedBindingErrorCode =
  | "operation_cancelled"
  | Extract<
      BrowserSessionError["code"],
      | "browser_target_invalid"
      | "browser_session_missing"
      | "browser_target_stale"
      | "browser_operation_replayed"
    >;

function failure<const C extends PinnedBindingErrorCode>(
  code: C,
): { readonly ok: false; readonly error: PortError<C> } {
  return { ok: false, error: providerError(code) } as const;
}
