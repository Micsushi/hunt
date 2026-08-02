import type {
  GmailAuthErrorCode,
  LiveIdentifier,
  LivePortResult,
  MailboxPollRequest,
  MailboxPollResultV1,
  MailboxProvider,
  MailboxProviderErrorCode,
} from "../../../contracts/live/index.ts";

type MailboxErrorCode = GmailAuthErrorCode | MailboxProviderErrorCode;
type MailboxResult = LivePortResult<MailboxPollResultV1, MailboxErrorCode>;

export type MailboxPollingTraceEvent =
  | "mailbox_poll_attempt"
  | "mailbox_poll_backoff"
  | "mailbox_poll_exhausted";

export interface MailboxPollingScheduler {
  arm(
    delayMs: number,
    callback: () => void,
  ): { cancel(): void };
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface BoundedVerificationMailboxPollingOptions {
  readonly clock: () => string;
  readonly authorizationExpiresAt: string;
  readonly maxDurationMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly createQueryId: () => LiveIdentifier<"mailbox_query">;
  readonly createAttemptProvider: (binding: MailboxPollRequest) => MailboxProvider;
  readonly scheduler?: MailboxPollingScheduler;
  readonly trace?: (event: MailboxPollingTraceEvent) => void;
}

const maximumDurationMs = 60_000;
const mailboxWindowMs = 24 * 60 * 60 * 1_000;
const queryIdPattern = /^mailbox_query_[A-Za-z0-9_-]{16,64}$/u;
const retryableAvailabilityErrors = new Set<string>([
  "secret_store_unavailable",
  "gmail_rate_limited",
  "gmail_network_unavailable",
  "mailbox_timeout",
]);

export function createBoundedVerificationMailboxPolling(
  options: BoundedVerificationMailboxPollingOptions,
): MailboxProvider {
  validateOptions(options);
  const scheduler = options.scheduler ?? systemScheduler;
  return Object.freeze({
    poll(request: MailboxPollRequest, signal: AbortSignal) {
      return pollUntilBounded(request, signal, options, scheduler);
    },
  });
}

async function pollUntilBounded(
  request: MailboxPollRequest,
  parentSignal: AbortSignal,
  options: BoundedVerificationMailboxPollingOptions,
  scheduler: MailboxPollingScheduler,
): Promise<MailboxResult> {
  if (parentSignal.aborted) return cancelled();
  const startedAt = readClock(options.clock);
  const authorizationDeadline = Date.parse(options.authorizationExpiresAt);
  if (startedAt === null || authorizationDeadline <= Date.parse(startedAt)) {
    return cancelled();
  }
  const startedAtMs = Date.parse(startedAt);
  const deadline = Math.min(
    startedAtMs + options.maxDurationMs,
    authorizationDeadline,
  );
  const notBefore = new Date(startedAtMs - mailboxWindowMs).toISOString();
  const controller = new AbortController();
  let deadlineReached = false;
  let lastResult: MailboxResult | undefined;
  let retryIndex = 0;
  const queryIds = new Set<string>();
  const cancelFromParent = () => controller.abort();
  parentSignal.addEventListener("abort", cancelFromParent, { once: true });
  const deadlineTimer = scheduler.arm(deadline - startedAtMs, () => {
    deadlineReached = true;
    controller.abort();
  });

  try {
    for (;;) {
      if (parentSignal.aborted) return cancelled();
      const attemptNow = readClock(options.clock);
      if (attemptNow === null || Date.parse(attemptNow) < startedAtMs) {
        return failure("mailbox_query_invalid");
      }
      if (deadlineReached || Date.parse(attemptNow) >= deadline) {
        emit(options, "mailbox_poll_exhausted");
        return lastResult ?? failure("mailbox_timeout");
      }
      const queryId = readFreshQueryId(options.createQueryId, queryIds);
      if (queryId === null) return failure("mailbox_query_invalid");
      const attemptRequest = Object.freeze({
        ...request,
        queryId,
        notBefore,
        notAfter: attemptNow,
      });
      emit(options, "mailbox_poll_attempt");
      let result: MailboxResult;
      try {
        const provider = options.createAttemptProvider(attemptRequest);
        result = await provider.poll(attemptRequest, controller.signal);
      } catch {
        result = failure("gmail_network_unavailable");
      }
      if (parentSignal.aborted) return cancelled();
      if (deadlineReached) {
        emit(options, "mailbox_poll_exhausted");
        return lastResult ?? (
          result.ok || result.error.code !== "operation_cancelled"
            ? result
            : failure("mailbox_timeout")
        );
      }
      if (!shouldRetry(result)) return result;
      lastResult = result;
      const afterAttempt = readClock(options.clock);
      if (afterAttempt === null || Date.parse(afterAttempt) < Date.parse(attemptNow)) {
        return failure("mailbox_query_invalid");
      }
      const remaining = deadline - Date.parse(afterAttempt);
      if (remaining <= 0) {
        emit(options, "mailbox_poll_exhausted");
        return lastResult;
      }
      const delay = Math.min(backoff(options, retryIndex), remaining);
      retryIndex += 1;
      emit(options, "mailbox_poll_backoff");
      try {
        await scheduler.wait(delay, controller.signal);
      } catch {
        if (parentSignal.aborted) return cancelled();
        if (deadlineReached) {
          emit(options, "mailbox_poll_exhausted");
          return lastResult;
        }
        return cancelled();
      }
    }
  } finally {
    deadlineTimer.cancel();
    parentSignal.removeEventListener("abort", cancelFromParent);
  }
}

function shouldRetry(result: MailboxResult): boolean {
  if (result.ok) return exactZeroCandidate(result.value);
  return result.error.retryable === true &&
    retryableAvailabilityErrors.has(result.error.code);
}

function exactZeroCandidate(value: MailboxPollResultV1): boolean {
  const keys = Object.keys(value);
  return keys.length === 5 &&
    Object.hasOwn(value, "provider") &&
    Object.hasOwn(value, "receivedTimeBucket") &&
    Object.hasOwn(value, "expiresAt") &&
    Object.hasOwn(value, "candidateCount") &&
    Object.hasOwn(value, "verificationHandle") &&
    value.provider === "gmail_api_v1" &&
    value.receivedTimeBucket === null &&
    value.expiresAt === null &&
    value.candidateCount === 0 &&
    value.verificationHandle === null;
}

function backoff(
  options: BoundedVerificationMailboxPollingOptions,
  retryIndex: number,
): number {
  return Math.min(
    options.baseDelayMs * (2 ** Math.min(retryIndex, 30)),
    options.maxDelayMs,
  );
}

function readFreshQueryId(
  create: () => LiveIdentifier<"mailbox_query">,
  seen: Set<string>,
): LiveIdentifier<"mailbox_query"> | null {
  try {
    const value = create();
    if (!queryIdPattern.test(value) || seen.has(value)) return null;
    seen.add(value);
    return value;
  } catch {
    return null;
  }
}

function validateOptions(options: BoundedVerificationMailboxPollingOptions): void {
  if (
    !Number.isSafeInteger(options.maxDurationMs) ||
    options.maxDurationMs < 1 ||
    options.maxDurationMs > maximumDurationMs ||
    !Number.isSafeInteger(options.baseDelayMs) ||
    options.baseDelayMs < 1 ||
    !Number.isSafeInteger(options.maxDelayMs) ||
    options.maxDelayMs < options.baseDelayMs ||
    readClock(() => options.authorizationExpiresAt) === null
  ) {
    throw new TypeError("invalid mailbox polling configuration");
  }
}

function readClock(clock: () => string): string | null {
  try {
    const value = clock();
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
      ? value
      : null;
  } catch {
    return null;
  }
}

function emit(
  options: BoundedVerificationMailboxPollingOptions,
  event: MailboxPollingTraceEvent,
): void {
  try {
    options.trace?.(event);
  } catch {
    // Value-free diagnostics cannot alter mailbox behavior.
  }
}

const systemScheduler: MailboxPollingScheduler = Object.freeze({
  arm(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
  wait(delayMs: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const cancel = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      }, delayMs);
      timer.unref();
    });
  },
});

function abortError(): Error {
  return Object.assign(new Error("operation cancelled"), { name: "AbortError" });
}

function cancelled(): MailboxResult {
  return {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  };
}

function failure<const Code extends MailboxErrorCode>(code: Code): MailboxResult {
  const retryable = retryableAvailabilityErrors.has(code);
  return { ok: false, error: { code, retryable } } as MailboxResult;
}
