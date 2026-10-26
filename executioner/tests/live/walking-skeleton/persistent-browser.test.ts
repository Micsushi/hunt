import assert from "node:assert/strict";
import { test } from "node:test";

import {
  generatedOperationId,
  guardRevision,
} from "../../../src/contracts/index.ts";
import type {
  LiveBrowserSessionV1,
  LiveCheckpointV1,
} from "../../../src/contracts/live/index.ts";
import { runPersistentBrowserSkeleton } from "../../../src/control/orchestrator/live/index.ts";
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
  createLiveCheckpointStoreFake,
  createLiveEvidenceSinkFake,
  createPersistentBrowserSessionFake,
  createPinnedPageLoopBrowserBinderFake,
  liveFixtures,
} from "../../../src/testing/live/index.ts";

const op = (suffix: string) =>
  generatedOperationId(`operation_${suffix.padStart(16, "0")}`);
const persistentCheckpoint: LiveCheckpointV1 = {
  ...liveFixtures.checkpoint,
  phase: "live_application",
};

function setup(options: {
  readonly checkpoint?: LiveCheckpointV1 | null;
  readonly reconcile?: "matched" | "mismatch";
  readonly openKind?: "opened" | "reattached";
  readonly openedSession?: LiveBrowserSessionV1;
  readonly reconciledSession?: LiveBrowserSessionV1;
  readonly closeError?: boolean;
  readonly sealError?: boolean;
  readonly removeError?: boolean;
  readonly initialCleanupError?: boolean;
  readonly cleanupError?: boolean;
} = {}) {
  const order: string[] = [];
  const base = createBrowserSessionFake({
    start: async () => {
      throw new Error("pinned page must not be opened twice");
    },
    observe: async () => {
      order.push("page.observe");
      return { ok: true as const, value: contractFixtures.browserObservation };
    },
    navigate: async () => {
      throw new Error("review page must not navigate");
    },
  });
  const binder = createPinnedPageLoopBrowserBinderFake({
    browser: base.port,
    coordinates: {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
    },
    now: () => liveFixtures.issuedAt,
    validateStartTarget: (target) => target === contractFixtures.job.applyUrl,
  });
  const browser = createPersistentBrowserSessionFake({
    open: async (request) => {
      order.push("browser.open");
      return {
        ok: true as const,
        value: {
          kind: options.openKind ?? (
            request.profileLeaseId === liveFixtures.session.profileLeaseId
              ? "reattached"
              : "opened"
          ),
          session: options.openedSession ?? {
            ...liveFixtures.session,
            profileLeaseId: request.profileLeaseId,
          },
        },
      };
    },
    reconcile: async (request) => {
      order.push("browser.reconcile");
      return options.reconcile === "mismatch"
        ? { ok: true as const, value: { kind: "target_mismatch" as const, dimension: "posting" as const } }
        : {
            ok: true as const,
            value: {
              kind: "matched" as const,
              session: options.reconciledSession ?? request.session,
            },
          };
    },
    close: async () => {
      order.push("browser.close");
      return options.closeError
        ? { ok: false as const, error: { code: "browser_profile_cleanup_failed" as const, retryable: false as const } }
        : { ok: true as const, value: undefined };
    },
  });
  const checkpoint = createLiveCheckpointStoreFake({
    load: async () => {
      order.push("checkpoint.load");
      return { ok: true as const, value: options.checkpoint ?? null };
    },
    save: async (request) => {
      order.push("checkpoint.save");
      return { ok: true as const, value: request.checkpoint };
    },
    remove: async () => {
      order.push("checkpoint.remove");
      return options.removeError
        ? { ok: false as const, error: { code: "recovery_checkpoint_cleanup_failed" as const, retryable: false as const } }
        : { ok: true as const, value: undefined };
    },
  });
  const evidence = createLiveEvidenceSinkFake({
    cleanupPartials: async (_request, _signal, callIndex) => {
      order.push("evidence.cleanup");
      return options.initialCleanupError || (options.cleanupError && callIndex > 0)
        ? { ok: false as const, error: { code: "acceptance_evidence_cleanup_failed" as const, retryable: false as const } }
        : { ok: true as const, value: undefined };
    },
    seal: async () => {
      order.push("evidence.seal");
      return options.sealError
        ? { ok: false as const, error: { code: "evidence_denied" as const, retryable: false as const } }
        : { ok: true as const, value: liveFixtures.evidenceSeal };
    },
  });
  let next = 100;
  return {
    order,
    base,
    binder,
    browser,
    checkpoint,
    evidence,
    dependencies: {
      browser: browser.port,
      binder: binder.binder,
      checkpoints: checkpoint.port,
      evidence: evidence.port,
      pageLoop: {
        understanding: createPageUnderstandingFake({
          understand: { ok: true, value: { kind: "understood", snapshot: { pageIdentity: { kind: "workday", page: "review" }, fields: [] } } },
        }).port,
        answers: createAnswerResolverFake().port,
        driver: createFieldDriverFake().port,
        verifier: createFieldVerifierFake().port,
        completion: createCompletionNavigationFake({
          complete: { ok: true, value: { kind: "complete", decision: { kind: "stop_review" } } },
        }).port,
        safety: { async admit() { throw new Error("review stops before admission"); } },
        nextOperationId: () => ({ ok: true as const, value: op(String(++next)) }),
        guardRevision: guardRevision("policy-s1"),
      },
    },
  };
}

function input() {
  return {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    target: liveFixtures.target,
    recoveryProfileLeaseId: liveFixtures.session.profileLeaseId,
    freshProfileLeaseId: "profile_lease_fresh000000000001" as never,
    revisionId: liveFixtures.checkpoint.revisionId,
    checkpointId: liveFixtures.checkpoint.checkpointId,
    manifestId: liveFixtures.evidenceSeal.manifestId,
    leaseExpiresAt: liveFixtures.expiresAt,
    now: liveFixtures.issuedAt,
    operations: {
      open: op("21"), reconcile: op("22"), bind: op("23"), save: op("24"),
      close: op("25"), seal: op("26"), remove: op("27"), cleanup: op("28"),
    },
    pageLoopInput: {
      journeyId: liveFixtures.journeyId,
      inputs: contractFixtures.journeyInputs,
      sourceId: op("29"),
    },
  };
}

test("fresh persistent session enters the unchanged page loop once and cleans up in order", async () => {
  const fixture = setup();
  const result = await runPersistentBrowserSkeleton(fixture.dependencies, input(), new AbortController().signal);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.kind, "review_candidate");
  assert.deepEqual(fixture.browser.calls.map(({ operation }) => operation), ["open", "reconcile", "close"]);
  assert.deepEqual(fixture.base.calls.map(({ operation }) => operation), ["observe"]);
  assert.deepEqual(fixture.binder.calls, ["bind", "start", "observe"]);
  assert.deepEqual(fixture.order, [
    "evidence.cleanup", "checkpoint.load", "browser.open", "browser.reconcile",
    "checkpoint.save", "page.observe", "browser.close", "evidence.seal",
    "checkpoint.remove", "evidence.cleanup",
  ]);
});

test("restart reconciles safe state while target mismatch remains factual", async () => {
  const fixture = setup({ checkpoint: persistentCheckpoint, reconcile: "mismatch" });
  const result = await runPersistentBrowserSkeleton(fixture.dependencies, input(), new AbortController().signal);
  assert.deepEqual(result, {
    ok: true,
    value: { kind: "blocked", factualOutcome: { source: "target_identity", result: { kind: "target_mismatch", dimension: "posting" } } },
  });
  assert.deepEqual(fixture.binder.calls, []);
  assert.equal(fixture.browser.calls.filter(({ operation }) => operation === "open").length, 1);
});

test("valid restart reuses its recovery lease while invalid recovery is removed before a distinct fresh lease", async () => {
  const valid = setup({ checkpoint: persistentCheckpoint });
  assert.equal((await runPersistentBrowserSkeleton(valid.dependencies, input(), new AbortController().signal)).ok, true);
  const validOpen = valid.browser.calls.find(({ operation }) => operation === "open")?.request as { profileLeaseId: unknown };
  assert.equal(validOpen.profileLeaseId, liveFixtures.session.profileLeaseId);

  const invalid = setup({ checkpoint: { ...persistentCheckpoint, target: liveFixtures.otherTarget } });
  assert.equal((await runPersistentBrowserSkeleton(invalid.dependencies, input(), new AbortController().signal)).ok, true);
  const invalidOpen = invalid.browser.calls.find(({ operation }) => operation === "open")?.request as { profileLeaseId: unknown };
  assert.equal(invalidOpen.profileLeaseId, input().freshProfileLeaseId);
  assert.ok(invalid.order.indexOf("checkpoint.remove") < invalid.order.indexOf("browser.open"));
});

test("restart adopts only the exact checkpoint and exact reattached reconciled session", async () => {
  const invalidCheckpoints: readonly (readonly [string, LiveCheckpointV1])[] = [
    ["checkpoint", { ...persistentCheckpoint, checkpointId: "checkpoint_fedcba9876543210" as never }],
    ["revision", { ...persistentCheckpoint, revisionId: "revision_fedcba9876543210" as never }],
    ["phase", { ...persistentCheckpoint, phase: "mailbox_verification" }],
    ["journey", { ...persistentCheckpoint, journeyId: liveFixtures.otherJourneyId }],
    ["profile", { ...persistentCheckpoint, profileLeaseId: "profile_lease_fedcba9876543210" as never }],
    ["lease", { ...persistentCheckpoint, leaseExpiresAt: liveFixtures.pastAt }],
    ["target", { ...persistentCheckpoint, target: liveFixtures.otherTarget }],
  ];
  for (const [label, checkpoint] of invalidCheckpoints) {
    const fixture = setup({ checkpoint });
    const result = await runPersistentBrowserSkeleton(
      fixture.dependencies,
      input(),
      new AbortController().signal,
    );
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
    const opened = fixture.browser.calls.find(({ operation }) => operation === "open")?.request as {
      profileLeaseId: unknown;
    };
    assert.equal(opened.profileLeaseId, input().freshProfileLeaseId, label);
    assert.ok(fixture.order.indexOf("checkpoint.remove") < fixture.order.indexOf("browser.open"), label);
  }

  for (const fixture of [
    setup({ checkpoint: persistentCheckpoint, openKind: "opened" }),
    setup({
      checkpoint: {
        ...persistentCheckpoint,
        sessionId: "live_session_fedcba9876543210" as never,
      },
    }),
    setup({
      checkpoint: persistentCheckpoint,
      openedSession: {
        ...liveFixtures.session,
        profileLeaseId: "profile_lease_fedcba9876543210" as never,
      },
    }),
    setup({
      checkpoint: persistentCheckpoint,
      reconciledSession: {
        ...liveFixtures.session,
        sessionId: "live_session_fedcba9876543210" as never,
      },
    }),
  ]) {
    const result = await runPersistentBrowserSkeleton(
      fixture.dependencies,
      input(),
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      ok: false,
      error: { code: "recovery_state_ambiguous", retryable: false },
    });
    assert.deepEqual(fixture.binder.calls, []);
  }
});

test("fresh open validates journey, requested profile, target, and lease before reconcile", async () => {
  for (const openedSession of [
    { ...liveFixtures.session, journeyId: liveFixtures.otherJourneyId },
    { ...liveFixtures.session, profileLeaseId: liveFixtures.session.profileLeaseId },
    { ...liveFixtures.session, target: liveFixtures.otherTarget },
    { ...liveFixtures.session, leaseExpiresAt: liveFixtures.pastAt },
  ]) {
    const fixture = setup({ openedSession });
    assert.deepEqual(
      await runPersistentBrowserSkeleton(
        fixture.dependencies,
        input(),
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "browser_session_invalidated", retryable: false },
      },
    );
    assert.equal(
      fixture.browser.calls.filter(({ operation }) => operation === "reconcile").length,
      0,
    );
  }
});

test("pre-effect cancellation and cleanup failure stop without browser effects", async () => {
  const cancelledFixture = setup();
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runPersistentBrowserSkeleton(cancelledFixture.dependencies, input(), controller.signal);
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.error.code, "operation_cancelled");
  assert.equal(cancelledFixture.browser.calls.length, 0);

  const dirty = setup({ initialCleanupError: true });
  const failed = await runPersistentBrowserSkeleton(dirty.dependencies, input(), new AbortController().signal);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "acceptance_evidence_cleanup_failed");
  assert.equal(dirty.browser.calls.length, 0);
});

test("terminal cleanup attempts every independent step and returns deterministic first failure", async () => {
  const fixture = setup({
    closeError: true,
    sealError: true,
    removeError: true,
    cleanupError: true,
  });
  const result = await runPersistentBrowserSkeleton(
    fixture.dependencies,
    input(),
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_profile_cleanup_failed", retryable: false },
  });
  assert.deepEqual(fixture.order.slice(-4), [
    "browser.close",
    "evidence.seal",
    "checkpoint.remove",
    "evidence.cleanup",
  ]);

  for (const [options, code] of [
    [{ sealError: true, removeError: true, cleanupError: true }, "evidence_denied"],
    [{ removeError: true, cleanupError: true }, "recovery_checkpoint_cleanup_failed"],
    [{ cleanupError: true }, "acceptance_evidence_cleanup_failed"],
  ] as const) {
    const single = setup(options);
    const outcome = await runPersistentBrowserSkeleton(
      single.dependencies,
      input(),
      new AbortController().signal,
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, code);
    assert.deepEqual(single.order.slice(-4), [
      "browser.close",
      "evidence.seal",
      "checkpoint.remove",
      "evidence.cleanup",
    ]);
  }
});

test("unparsed invalid checkpoint and session successes cannot satisfy persistent recovery", async () => {
  const checkpoint = setup({ checkpoint: persistentCheckpoint });
  checkpoint.dependencies.checkpoints = createLiveCheckpointStoreFake({
    load: {
      ok: true,
      value: { ...persistentCheckpoint, raw: "forbidden" },
    } as never,
  }).port;
  assert.deepEqual(
    await runPersistentBrowserSkeleton(
      checkpoint.dependencies,
      input(),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "recovery_checkpoint_invalid", retryable: false },
    },
  );

  const session = setup({ checkpoint: persistentCheckpoint });
  session.dependencies.browser = createPersistentBrowserSessionFake({
    open: {
      ok: true,
      value: {
        kind: "reattached",
        session: { ...liveFixtures.session, raw: "forbidden" },
      },
    } as never,
  }).port;
  assert.deepEqual(
    await runPersistentBrowserSkeleton(
      session.dependencies,
      input(),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "recovery_state_ambiguous", retryable: false },
    },
  );
  assert.deepEqual(session.binder.calls, []);

  const openWrapper = setup();
  openWrapper.dependencies.browser = createPersistentBrowserSessionFake({
    open: {
      ok: true,
      value: { kind: "unknown", session: liveFixtures.session },
    } as never,
  }).port;
  assert.deepEqual(
    await runPersistentBrowserSkeleton(
      openWrapper.dependencies,
      input(),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "browser_session_invalidated", retryable: false },
    },
  );

  const reconcileWrapper = setup();
  reconcileWrapper.dependencies.browser = createPersistentBrowserSessionFake({
    reconcile: {
      ok: true,
      value: { kind: "matched", session: liveFixtures.session, raw: "forbidden" },
    } as never,
  }).port;
  assert.deepEqual(
    await runPersistentBrowserSkeleton(
      reconcileWrapper.dependencies,
      input(),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "browser_session_invalidated", retryable: false },
    },
  );
});
