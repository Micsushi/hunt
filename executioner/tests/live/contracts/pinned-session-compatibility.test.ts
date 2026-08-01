import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  generatedOperationId,
  guardRevision,
  providerError,
  stableErrorPolicy,
  type BrowserObservation,
} from "../../../src/contracts/index.ts";
import {
  livePortNames,
  pinnedPageLoopBindingPolicy,
  type PinnedPageLoopBindingRequestV1,
} from "../../../src/contracts/live/index.ts";
import { runPageLoop } from "../../../src/control/orchestrator/loop/index.ts";
import {
  contractFixtures,
  createAnswerResolverFake,
  createBrowserSessionFake,
  createCompletionNavigationFake,
  createFieldDriverFake,
  createFieldVerifierFake,
  createPageUnderstandingFake,
} from "../../../src/testing/contracts/index.ts";
import {
  createPinnedPageLoopBrowserBinderFake,
  liveFixtures,
} from "../../../src/testing/live/index.ts";

const coordinates = {
  sessionId: contractFixtures.browserObservation.sessionId,
  pageId: contractFixtures.browserObservation.pageId,
};
const startTarget = contractFixtures.job.applyUrl;

function request(
  overrides: Partial<PinnedPageLoopBindingRequestV1> = {},
): PinnedPageLoopBindingRequestV1 {
  return {
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_0000000000000091"),
    session: liveFixtures.session,
    expectedSessionId: liveFixtures.session.sessionId,
    expectedTarget: liveFixtures.target,
    ...overrides,
  };
}

test("the pinned binder remains an additive F3 seam, not a tenth live port", () => {
  assert.deepEqual(livePortNames, [
    "PersistentBrowserSession",
    "SecretStore",
    "CredentialMutationAdapter",
    "PrivilegedGmailAuthExecutor",
    "MailboxProvider",
    "VerificationArtifact",
    "PrivilegedVerificationNavigator",
    "LiveCheckpointStore",
    "LiveEvidenceSink",
  ]);
  assert.deepEqual(pinnedPageLoopBindingPolicy, {
    owner: "F3",
    schemaVersion: 1,
    opensPage: false,
    navigatesOnStart: false,
    retainsStartTarget: false,
    scheduler: "F9",
  });
  for (const code of [
    "browser_target_invalid",
    "browser_session_missing",
    "browser_target_stale",
    "browser_operation_replayed",
  ] as const) {
    assert.equal(stableErrorPolicy[code].owner, "F3");
  }
});

test("start adopts pinned coordinates without opening or retaining the raw target, then forwards", async () => {
  const base = createBrowserSessionFake({
    start: async () => {
      throw new Error("a pinned facade must not start the adapter again");
    },
  });
  const binder = createPinnedPageLoopBrowserBinderFake({
    browser: base.port,
    coordinates,
    now: () => liveFixtures.issuedAt,
    validateStartTarget: (target) => target === startTarget,
  });
  const bound = await binder.binder.bind(
    request(),
    new AbortController().signal,
  );
  assert.equal(bound.ok, true);
  if (!bound.ok) return;

  assert.deepEqual(
    await bound.value.start(
      { journeyId: liveFixtures.journeyId, target: startTarget },
      new AbortController().signal,
    ),
    { ok: true, value: coordinates },
  );
  await bound.value.observe(coordinates, new AbortController().signal);
  await bound.value.mutate(
    { synthetic: "mutation-request" } as never,
    new AbortController().signal,
  );
  await bound.value.navigate(
    { synthetic: "navigation-request" } as never,
    new AbortController().signal,
  );
  await bound.value.close(
    { sessionId: coordinates.sessionId },
    new AbortController().signal,
  );

  assert.deepEqual(base.calls.map(({ operation }) => operation), [
    "observe",
    "mutate",
    "navigate",
    "close",
  ]);
  assert.deepEqual(binder.calls, [
    "bind",
    "start",
    "observe",
    "mutate",
    "navigate",
    "close",
  ]);
  assert.doesNotMatch(JSON.stringify(binder.calls), /fixture\.invalid|\/apply/u);
  assert.equal(
    JSON.stringify({ calls: binder.calls, request: binder.lastSafeBinding }),
    JSON.stringify({ calls: binder.calls, request: binder.lastSafeBinding })
      .replaceAll(startTarget, ""),
  );
});

test("bind and start fail closed for scope, target, session, stale lease, replay, and cancellation", async () => {
  const cases = [
    [
      "journey",
      request({ journeyId: liveFixtures.otherJourneyId }),
      "browser_target_invalid",
    ],
    [
      "target",
      request({ expectedTarget: liveFixtures.otherTarget }),
      "browser_target_invalid",
    ],
    [
      "session",
      request({ expectedSessionId: "live_session_fedcba9876543210" as never }),
      "browser_session_missing",
    ],
  ] as const;
  for (const [label, binding, code] of cases) {
    const fake = createPinnedPageLoopBrowserBinderFake({
      browser: createBrowserSessionFake().port,
      coordinates,
      now: () => liveFixtures.issuedAt,
      validateStartTarget: () => true,
    });
    const result = await fake.binder.bind(
      binding,
      new AbortController().signal,
    );
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.error.code, code, label);
  }

  const stale = createPinnedPageLoopBrowserBinderFake({
    browser: createBrowserSessionFake().port,
    coordinates,
    now: () => liveFixtures.expiresAt,
    validateStartTarget: () => true,
  });
  const staleResult = await stale.binder.bind(
    request(),
    new AbortController().signal,
  );
  assert.deepEqual(staleResult, {
    ok: false,
    error: providerError("browser_target_stale"),
  });
  for (const now of [
    () => "invalid-time",
    () => {
      throw new Error("synthetic clock failure");
    },
  ]) {
    const invalidClock = createPinnedPageLoopBrowserBinderFake({
      browser: createBrowserSessionFake().port,
      coordinates,
      now,
      validateStartTarget: () => true,
    });
    assert.deepEqual(
      await invalidClock.binder.bind(request(), new AbortController().signal),
      { ok: false, error: providerError("browser_target_stale") },
    );
  }

  const replay = createPinnedPageLoopBrowserBinderFake({
    browser: createBrowserSessionFake().port,
    coordinates,
    now: () => liveFixtures.issuedAt,
    validateStartTarget: () => true,
  });
  assert.equal(
    (await replay.binder.bind(request(), new AbortController().signal)).ok,
    true,
  );
  assert.deepEqual(
    await replay.binder.bind(request(), new AbortController().signal),
    { ok: false, error: providerError("browser_operation_replayed") },
  );

  const cancelled = new AbortController();
  cancelled.abort();
  assert.deepEqual(await replay.binder.bind(request(), cancelled.signal), {
    ok: false,
    error: providerError("operation_cancelled"),
  });

  const valid = createPinnedPageLoopBrowserBinderFake({
    browser: createBrowserSessionFake().port,
    coordinates,
    now: () => liveFixtures.issuedAt,
    validateStartTarget: (target) => target === startTarget,
  });
  const bound = await valid.binder.bind(
    request(),
    new AbortController().signal,
  );
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  assert.deepEqual(
    await bound.value.start(
      { journeyId: liveFixtures.otherJourneyId, target: startTarget },
      new AbortController().signal,
    ),
    { ok: false, error: providerError("browser_target_invalid") },
  );
  assert.deepEqual(
    await bound.value.start(
      { journeyId: liveFixtures.journeyId, target: "synthetic-wrong-target" },
      new AbortController().signal,
    ),
    { ok: false, error: providerError("browser_target_invalid") },
  );
  const throwingValidator = createPinnedPageLoopBrowserBinderFake({
    browser: createBrowserSessionFake().port,
    coordinates,
    now: () => liveFixtures.issuedAt,
    validateStartTarget: () => {
      throw new Error("synthetic target validator failure");
    },
  });
  const throwingBound = await throwingValidator.binder.bind(
    request({ operationId: generatedOperationId("operation_0000000000000093") }),
    new AbortController().signal,
  );
  assert.equal(throwingBound.ok, true);
  if (throwingBound.ok) {
    assert.deepEqual(
      await throwingBound.value.start(
        { journeyId: liveFixtures.journeyId, target: startTarget },
        new AbortController().signal,
      ),
      { ok: false, error: providerError("browser_target_invalid") },
    );
  }
  const startCancelled = new AbortController();
  startCancelled.abort();
  assert.deepEqual(
    await bound.value.start(
      { journeyId: liveFixtures.journeyId, target: startTarget },
      startCancelled.signal,
    ),
    { ok: false, error: providerError("operation_cancelled") },
  );
  assert.deepEqual(
    await bound.value.observe(coordinates, startCancelled.signal),
    { ok: false, error: providerError("operation_cancelled") },
  );
});

test("the unchanged Stage 1 page loop consumes the pinned coordinates", async () => {
  const observation: BrowserObservation = {
    ...contractFixtures.browserObservation,
    sessionId: coordinates.sessionId,
    pageId: coordinates.pageId,
    targets: [],
  };
  const base = createBrowserSessionFake({
    start: async () => {
      throw new Error("runPageLoop must adopt rather than open");
    },
    observe: async (observed) => {
      assert.deepEqual(observed, coordinates);
      return { ok: true, value: observation };
    },
  });
  const binder = createPinnedPageLoopBrowserBinderFake({
    browser: base.port,
    coordinates,
    now: () => liveFixtures.issuedAt,
    validateStartTarget: (target) => target === startTarget,
  });
  const bound = await binder.binder.bind(
    request(),
    new AbortController().signal,
  );
  assert.equal(bound.ok, true);
  if (!bound.ok) return;

  let next = 0;
  const result = await runPageLoop(
    {
      browser: bound.value,
      understanding: createPageUnderstandingFake({
        understand: {
          ok: true,
          value: {
            kind: "understood",
            snapshot: {
              pageIdentity: { kind: "workday", page: "review" },
              fields: [],
            },
          },
        },
      }).port,
      answers: createAnswerResolverFake().port,
      driver: createFieldDriverFake().port,
      verifier: createFieldVerifierFake().port,
      completion: createCompletionNavigationFake({
        complete: {
          ok: true,
          value: { kind: "complete", decision: { kind: "stop_review" } },
        },
      }).port,
      safety: {
        async admit() {
          throw new Error("Review must stop before safety admission");
        },
      },
      nextOperationId: () => ({
        ok: true,
        value: generatedOperationId(
          `operation_${(++next).toString(16).padStart(16, "0")}`,
        ),
      }),
      guardRevision: guardRevision("policy-s1"),
    },
    {
      journeyId: liveFixtures.journeyId,
      inputs: contractFixtures.journeyInputs,
      sourceId: generatedOperationId("operation_0000000000000092"),
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "review_candidate",
      pageId: coordinates.pageId,
      completedPages: 1,
      sessionId: coordinates.sessionId,
    },
  });
  assert.deepEqual(base.calls.map(({ operation }) => operation), ["observe"]);
});

test("the seam cannot import test code or introduce a scheduler", () => {
  const contract = readFileSync(
    new URL("../../../src/contracts/live/page-loop-binding.ts", import.meta.url),
    "utf8",
  );
  const fake = readFileSync(
    new URL("../../../src/testing/live/pinned-page-loop.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(contract, /src\/testing|testing\/live/u);
  assert.doesNotMatch(
    `${contract}\n${fake}`,
    /\b(?:setTimeout|setInterval|queueMicrotask|scheduleRetry|retryLoop|backoff)\b/u,
  );
});
