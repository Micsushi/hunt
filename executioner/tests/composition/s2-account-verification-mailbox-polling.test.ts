import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  LivePortResult,
  MailboxPollRequest,
  MailboxPollResultV1,
  MailboxProvider,
  MailboxProviderErrorCode,
  GmailAuthErrorCode,
} from "../../src/contracts/live/index.ts";
import {
  createBoundedVerificationMailboxPolling,
  type MailboxPollingScheduler,
} from "../../src/account/lifecycle/mailbox-polling.ts";
import { liveFixtures } from "../../src/testing/live/index.ts";

type MailboxResult = LivePortResult<
  MailboxPollResultV1,
  MailboxProviderErrorCode | GmailAuthErrorCode
>;

const startedAt = "2026-08-02T12:00:00.000Z";
const authorizationExpiresAt = "2026-08-02T12:01:00.000Z";
const empty: MailboxPollResultV1 = {
  provider: "gmail_api_v1",
  receivedTimeBucket: null,
  expiresAt: null,
  candidateCount: 0,
  verificationHandle: null,
};

const reorderedEmpty: MailboxPollResultV1 = {
  verificationHandle: null,
  candidateCount: 0,
  expiresAt: null,
  receivedTimeBucket: null,
  provider: "gmail_api_v1",
};

test("admits an exact five-minute mailbox polling window", () => {
  const runtime = fakeRuntime(startedAt);
  assert.doesNotThrow(() => createBoundedVerificationMailboxPolling({
    clock: runtime.clock,
    authorizationExpiresAt: "2026-08-02T12:10:00.000Z",
    maxDurationMs: 5 * 60_000,
    baseDelayMs: 250,
    maxDelayMs: 1_000,
    createQueryId: queryIds(),
    createAttemptProvider: providerSequence([], []),
    scheduler: runtime.scheduler,
  }));
});

test("polls delayed mail without widening the journey lower bound", async () => {
  const runtime = fakeRuntime(startedAt);
  const requests: MailboxPollRequest[] = [];
  const traces: string[] = [];
  const results: MailboxResult[] = [
    { ok: true, value: reorderedEmpty },
    { ok: true, value: empty },
    { ok: true, value: liveFixtures.mailboxAvailable },
  ];
  const mailbox = createBoundedVerificationMailboxPolling({
    clock: runtime.clock,
    authorizationExpiresAt,
    maxDurationMs: 60_000,
    baseDelayMs: 250,
    maxDelayMs: 1_000,
    createQueryId: queryIds(),
    createAttemptProvider: providerSequence(results, requests),
    scheduler: runtime.scheduler,
    trace: (event) => traces.push(event),
  });

  assert.deepEqual(
    await mailbox.poll(baseRequest(), new AbortController().signal),
    { ok: true, value: liveFixtures.mailboxAvailable },
  );
  assert.deepEqual(runtime.waits, [250, 500]);
  assert.deepEqual(
    requests.map(({ queryId }) => queryId),
    [
      "mailbox_query_retry_0000000000000001",
      "mailbox_query_retry_0000000000000002",
      "mailbox_query_retry_0000000000000003",
    ],
  );
  assert.deepEqual(
    requests.map(({ notBefore }) => notBefore),
    Array(3).fill(baseRequest().notBefore),
  );
  assert.deepEqual(
    requests.map(({ notAfter }) => notAfter),
    [
      "2026-08-02T12:00:00.000Z",
      "2026-08-02T12:00:00.250Z",
      "2026-08-02T12:00:00.750Z",
    ],
  );
  assert.deepEqual(
    requests.map(({ journeyId, recipientBindingId, target }) => ({
      journeyId,
      recipientBindingId,
      target,
    })),
    Array(3).fill({
      journeyId: baseRequest().journeyId,
      recipientBindingId: baseRequest().recipientBindingId,
      target: baseRequest().target,
    }),
  );
  assert.deepEqual(traces, [
    "mailbox_poll_attempt",
    "mailbox_poll_backoff",
    "mailbox_poll_attempt",
    "mailbox_poll_backoff",
    "mailbox_poll_attempt",
  ]);
});

test("returns exact mailbox none only after the bounded deadline without a cached replay", async () => {
  const runtime = fakeRuntime(startedAt);
  const requests: MailboxPollRequest[] = [];
  const mailbox = createBoundedVerificationMailboxPolling({
    clock: runtime.clock,
    authorizationExpiresAt,
    maxDurationMs: 750,
    baseDelayMs: 250,
    maxDelayMs: 1_000,
    createQueryId: queryIds(),
    createAttemptProvider: providerSequence([
      { ok: true, value: empty },
      { ok: true, value: empty },
    ], requests),
    scheduler: runtime.scheduler,
  });

  assert.deepEqual(
    await mailbox.poll(baseRequest(), new AbortController().signal),
    { ok: true, value: empty },
  );
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]!.queryId, requests[1]!.queryId);
  assert.deepEqual(runtime.waits, [250, 500]);
});

test("authorization deadline preserves the last approved availability error", async () => {
  const runtime = fakeRuntime(startedAt);
  const requests: MailboxPollRequest[] = [];
  const mailbox = createBoundedVerificationMailboxPolling({
    clock: runtime.clock,
    authorizationExpiresAt: "2026-08-02T12:00:00.400Z",
    maxDurationMs: 60_000,
    baseDelayMs: 250,
    maxDelayMs: 1_000,
    createQueryId: queryIds(),
    createAttemptProvider: providerSequence([
      failure("gmail_network_unavailable"),
      failure("mailbox_timeout"),
    ], requests),
    scheduler: runtime.scheduler,
  });

  assert.deepEqual(
    await mailbox.poll(baseRequest(), new AbortController().signal),
    failure("mailbox_timeout"),
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(runtime.waits, [250, 150]);
});

test("non-availability facts and errors stop once, while cancellation starts nothing", async () => {
  for (const result of [
    { ok: true, value: { ...empty, candidateCount: 2 } } as MailboxResult,
    failure("gmail_auth_denied"),
    failure("mailbox_query_invalid"),
  ]) {
    const runtime = fakeRuntime(startedAt);
    const requests: MailboxPollRequest[] = [];
    const mailbox = createBoundedVerificationMailboxPolling({
      clock: runtime.clock,
      authorizationExpiresAt,
      maxDurationMs: 60_000,
      baseDelayMs: 250,
      maxDelayMs: 1_000,
      createQueryId: queryIds(),
      createAttemptProvider: providerSequence([result], requests),
      scheduler: runtime.scheduler,
    });
    assert.deepEqual(
      await mailbox.poll(baseRequest(), new AbortController().signal),
      result,
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(runtime.waits, []);
  }

  const runtime = fakeRuntime(startedAt);
  const requests: MailboxPollRequest[] = [];
  const mailbox = createBoundedVerificationMailboxPolling({
    clock: runtime.clock,
    authorizationExpiresAt,
    maxDurationMs: 60_000,
    baseDelayMs: 250,
    maxDelayMs: 1_000,
    createQueryId: queryIds(),
    createAttemptProvider: providerSequence([], requests),
    scheduler: runtime.scheduler,
  });
  assert.deepEqual(await mailbox.poll(baseRequest(), AbortSignal.abort()), {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.equal(requests.length, 0);
});

test("production composition rebuilds an exact Gmail provider for every F9 attempt", async () => {
  const source = await readFile(
    new URL("../../src/composition/s2-account-verified-runner.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /createBoundedVerificationMailboxPolling\(\{/u);
  assert.match(source, /maxDurationMs: 5 \* 60_000,/u);
  assert.match(source, /createAttemptProvider: \(attemptRequest\) =>/u);
  assert.match(source, /binding: attemptRequest,/u);
  assert.match(source, /notBefore: attemptRequest\.notBefore,/u);
  assert.match(source, /notAfter: attemptRequest\.notAfter,/u);
  assert.equal(source.includes("const mailbox = new GmailMailboxProvider({"), false);
});

function providerSequence(
  results: MailboxResult[],
  requests: MailboxPollRequest[],
): (binding: MailboxPollRequest) => MailboxProvider {
  return (binding) => ({
    async poll(request) {
      assert.deepEqual(request, binding);
      requests.push(request);
      const result = results.shift();
      if (result === undefined) throw new Error("unexpected mailbox attempt");
      return result;
    },
  });
}

function baseRequest(): MailboxPollRequest {
  return {
    ...liveFixtures.mailboxPollRequest,
    notBefore: "2026-08-01T11:00:00.000Z",
    notAfter: "2026-08-02T11:00:00.000Z",
  };
}

function queryIds() {
  let value = 0;
  return () => {
    value += 1;
    return `mailbox_query_retry_${value.toString().padStart(16, "0")}` as never;
  };
}

function failure(
  code:
    | "gmail_network_unavailable"
    | "mailbox_timeout"
    | "gmail_auth_denied"
    | "mailbox_query_invalid",
): MailboxResult {
  return {
    ok: false,
    error: {
      code,
      retryable: code === "gmail_network_unavailable" || code === "mailbox_timeout",
    },
  } as MailboxResult;
}

function fakeRuntime(initial: string) {
  let current = Date.parse(initial);
  const waits: number[] = [];
  const timers = new Set<{
    readonly at: number;
    readonly callback: () => void;
  }>();
  const runTimers = () => {
    for (const timer of [...timers]) {
      if (timer.at <= current) {
        timers.delete(timer);
        timer.callback();
      }
    }
  };
  const scheduler: MailboxPollingScheduler = {
    arm(delayMs, callback) {
      const timer = { at: current + delayMs, callback };
      timers.add(timer);
      return { cancel: () => timers.delete(timer) };
    },
    async wait(delayMs, signal) {
      if (signal.aborted) throw abortError();
      waits.push(delayMs);
      current += delayMs;
      runTimers();
      if (signal.aborted) throw abortError();
    },
  };
  return {
    clock: () => new Date(current).toISOString(),
    scheduler,
    waits,
  };
}

function abortError(): Error {
  return Object.assign(new Error("cancelled"), { name: "AbortError" });
}
