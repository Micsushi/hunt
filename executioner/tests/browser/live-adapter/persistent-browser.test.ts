import assert from "node:assert/strict";
import { test } from "node:test";

import { generatedOperationId } from "../../../src/contracts/index.ts";
import type {
  LiveSessionId,
  PersistentBrowserOpenRequest,
} from "../../../src/contracts/live/index.ts";
import { liveFixtures } from "../../../src/testing/live/index.ts";
import { findLivePrivacyViolations } from "../../../src/testing/live/privacy.ts";
import { PlaywrightPersistentBrowserSession } from "../../../src/browser/playwright-live/index.ts";
import type { OwnedTargetObservation } from "../../../src/browser/playwright-live/private/types.ts";

test("opens one exact page through an isolated persistent context", async () => {
  const pages: FakePage[] = [];
  const context = new FakeContext(pages);
  const launched: string[] = [];
  let approvedBinding: unknown;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: {
      async launchPersistentContext(profilePath) {
        launched.push(profilePath);
        return context;
      },
    },
    probe: {
      async inspect(page, expected) {
        approvedBinding = expected;
        return page === pages.at(-1)
          ? ownedMatched()
          : { ownership: "foreign" };
      },
    },
    profiles: new MemoryProfiles(),
    ids: () => "live_session_1111111111111111" as LiveSessionId,
    timeoutMs: 100,
  });

  const result = await provider.open(openRequest(), new AbortController().signal);

  assert.equal(result.ok, true);
  assert.deepEqual(launched, ["C:\\outside\\runtime\\browser-profile"]);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0]?.navigations, [
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
  ]);
  assert.equal(result.ok && result.value.kind, "opened");
  assert.equal(
    result.ok && result.value.session.sessionId,
    "live_session_1111111111111111",
  );
  assert.deepEqual(approvedBinding, {
    identity: liveFixtures.target,
    approved: {
      host: "approved.wd5.myworkdayjobs.invalid",
      tenant: "approved",
      posting: "R12345",
    },
  });
  assert.deepEqual(findLivePrivacyViolations(result), []);
});

test("private owned-session inspection returns only a value-free structural snapshot", async () => {
  const context = new FakeContext([]);
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const inspected = await provider.inspectOwnedTarget(
    opened.value.session.sessionId,
    liveFixtures.target,
    new AbortController().signal,
  );

  assert.deepEqual(inspected, {
    ok: true,
    value: {
      target: { kind: "matched" },
      snapshot: structuralSnapshot,
    },
  });
  assert.deepEqual(findLivePrivacyViolations(inspected), []);
  const serialized = JSON.stringify(inspected);
  for (const forbidden of ["page", "url", "origin", "path", "text", "html"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test("restart re-identifies the exact owned page without adopting foreign tabs", async () => {
  const owned = new FakePage();
  const foreign = new FakePage();
  const context = new FakeContext([foreign, owned]);
  const profiles = new MemoryProfiles();
  profiles.marker = {
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    profileLeaseId: liveFixtures.session.profileLeaseId,
    sessionId: liveFixtures.session.sessionId,
    target: liveFixtures.target,
    admittedAt: liveFixtures.issuedAt,
    leaseExpiresAt: liveFixtures.expiresAt,
  };
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(
      "2026-08-01T18:00:00.000Z",
      "2026-08-02T18:00:00.000Z",
    ),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect(page) {
        return page === owned
          ? ownedMatched()
          : { ownership: "foreign" };
      },
    },
    profiles,
    ids: () => "live_session_2222222222222222" as LiveSessionId,
    timeoutMs: 100,
  });

  const result = await provider.open(openRequest(), new AbortController().signal);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.kind, "reattached");
  assert.equal(result.ok && result.value.session.sessionId, liveFixtures.session.sessionId);
  assert.equal(context.newPageCount, 0);
  assert.equal(foreign.closed, false);
});

test("restart probe timeout is bounded and independently cleans context and profile", async () => {
  const page = new FakePage();
  const context = new FakeContext([page]);
  const profiles = new MemoryProfiles();
  profiles.marker = {
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    profileLeaseId: liveFixtures.session.profileLeaseId,
    sessionId: liveFixtures.session.sessionId,
    target: liveFixtures.target,
    admittedAt: liveFixtures.issuedAt,
    leaseExpiresAt: liveFixtures.expiresAt,
  };
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return new Promise(() => undefined); } },
    profiles,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 5,
  });

  const result = await completesWithin(
    provider.open(openRequest(), new AbortController().signal),
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_timeout", retryable: true },
  });
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.cleanupCount, 1);
});

test("reconcile follows the sole owned matching popup and ignores foreign pages", async () => {
  const context = new FakeContext([]);
  const observations = new Map<FakePage, OwnedTargetObservation>();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect(page) {
        return observations.get(page as FakePage) ?? {
          ...ownedMatched(),
        };
      },
    },
    profiles: new MemoryProfiles(),
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const original = context.ownedPages[0]!;
  const popup = new FakePage();
  const foreign = new FakePage();
  context.ownedPages.push(popup, foreign);
  observations.set(original, {
    ownership: "owned",
    target: { kind: "target_mismatch", dimension: "posting" },
    snapshot: structuralSnapshot,
  });
  observations.set(popup, ownedMatched());
  observations.set(foreign, { ownership: "foreign" });

  const result = await provider.reconcile(
    {
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      operationId: generatedOperationId("operation_2222222222222222"),
      session: opened.value.session,
      expectedTarget: liveFixtures.target,
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "matched", session: opened.value.session },
  });
  assert.equal(foreign.closed, false);
});

test("open replays the exact operation and rejects a changed reuse", async () => {
  let launches = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: {
      async launchPersistentContext() {
        launches += 1;
        return new FakeContext([]);
      },
    },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const request = openRequest();

  const first = await provider.open(request, new AbortController().signal);
  const replay = await provider.open(request, new AbortController().signal);
  const reattach = await provider.open(
    {
      ...request,
      operationId: generatedOperationId("operation_1111111111111112"),
    },
    new AbortController().signal,
  );
  const conflict = await provider.open(
    { ...request, target: liveFixtures.otherTarget },
    new AbortController().signal,
  );

  assert.deepEqual(replay, first);
  assert.equal(reattach.ok && reattach.value.kind, "reattached");
  assert.equal(
    reattach.ok && reattach.value.session.sessionId,
    first.ok && first.value.session.sessionId,
  );
  assert.deepEqual(conflict, {
    ok: false,
    error: { code: "browser_operation_replayed", retryable: false },
  });
  assert.equal(launches, 1);
});

test("close releases only the launched context and exact profile once", async () => {
  const context = new FakeContext([]);
  const unrelated = new FakeContext([]);
  const profiles = new MemoryProfiles();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const request = {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_3333333333333333"),
    sessionId: opened.value.session.sessionId,
  };

  const first = await provider.close(request, new AbortController().signal);
  const replay = await provider.close(request, new AbortController().signal);

  assert.deepEqual(first, { ok: true, value: undefined });
  assert.deepEqual(replay, first);
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.cleanupCount, 1);
  assert.equal(unrelated.closeCount, 0);
});

test("cleanup attempts context and profile independently and reports either failure", async () => {
  const context = new FakeContext([]);
  context.failClose = true;
  const profiles = new MemoryProfiles();
  profiles.failCleanup = true;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const result = await provider.close(
    {
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      operationId: generatedOperationId("operation_4444444444444444"),
      sessionId: opened.value.session.sessionId,
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_profile_cleanup_failed", retryable: false },
  });
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.cleanupCount, 1);
});

test("close bounds never-settling cleanup and starts every independent attempt", async () => {
  const context = new FakeContext([]);
  const profiles = new MemoryProfiles();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 5,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  context.hangClose = true;
  profiles.hangCleanup = true;

  const result = await completesWithin(provider.close(
    {
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      operationId: generatedOperationId("operation_4444444444444445"),
      sessionId: opened.value.session.sessionId,
    },
    new AbortController().signal,
  ));

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_profile_cleanup_failed", retryable: false },
  });
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.cleanupCount, 1);
});

test("failed target admission closes the launched context and removes only its partial profile", async () => {
  const context = new FakeContext([]);
  const profiles = new MemoryProfiles();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        return {
          ownership: "owned",
          target: { kind: "target_mismatch", dimension: "posting" },
          snapshot: structuralSnapshot,
        } as const;
      },
    },
    profiles,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });

  const result = await provider.open(openRequest(), new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_target_invalid", retryable: false },
  });
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.partialCleanupCount, 1);
});

test("an initially unavailable posting opens only long enough to report the exact fact", async () => {
  const context = new FakeContext([]);
  const profiles = new MemoryProfiles();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        return {
          ownership: "owned",
          target: { kind: "posting_unavailable", reason: "not_found" },
          snapshot: structuralSnapshot,
        } as const;
      },
    },
    profiles,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });

  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(await provider.reconcile({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_initial_unavailable_1"),
    session: opened.value.session,
    expectedTarget: liveFixtures.target,
  }, new AbortController().signal), {
    ok: true,
    value: { kind: "posting_unavailable", reason: "not_found" },
  });
  assert.deepEqual(await provider.close({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_initial_unavailable_2"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal), { ok: true, value: undefined });
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.cleanupCount, 1);
});

test("crash recovery reattaches the sole owned unavailable posting for factual reporting", async () => {
  const page = new FakePage();
  const context = new FakeContext([page]);
  const profiles = new MemoryProfiles();
  profiles.marker = {
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    profileLeaseId: liveFixtures.session.profileLeaseId,
    sessionId: liveFixtures.session.sessionId,
    target: liveFixtures.target,
    admittedAt: liveFixtures.issuedAt,
    leaseExpiresAt: liveFixtures.expiresAt,
  };
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        return {
          ownership: "owned",
          target: { kind: "posting_unavailable", reason: "unavailable" },
          snapshot: structuralSnapshot,
        } as const;
      },
    },
    profiles,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });

  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok && opened.value.kind, "reattached");
  assert.equal(context.newPageCount, 0);
});

test("diagnostic hold runs before failed-open browser cleanup", async () => {
  const context = new FakeContext([]);
  let holdCount = 0;
  let closedDuringHold: boolean | undefined;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        return {
          ownership: "owned",
          target: { kind: "target_mismatch", dimension: "posting" },
          snapshot: structuralSnapshot,
        } as const;
      },
    },
    profiles: new MemoryProfiles(),
    inspectionHoldBeforeCleanup: async () => {
      holdCount += 1;
      closedDuringHold = context.closed;
    },
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });

  const result = await provider.open(openRequest(), new AbortController().signal);

  assert.equal(result.ok, false);
  assert.equal(holdCount, 1);
  assert.equal(closedDuringHold, false);
  assert.equal(context.closed, true);
});

test("diagnostic hold runs before successful browser close", async () => {
  const context = new FakeContext([]);
  let holdCount = 0;
  let closedDuringHold: boolean | undefined;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    inspectionHoldBeforeCleanup: async () => {
      holdCount += 1;
      closedDuringHold = context.closed;
    },
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const result = await provider.close({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_diagnostic_hold_close_1"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal);

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(holdCount, 1);
  assert.equal(closedDuringHold, false);
  assert.equal(context.closed, true);
});

test("close succeeds after account ownership invalidation cleaned the exact session", async () => {
  const { provider, opened } = await openedProviderThatInvalidatesAfterFill();
  if (!opened.ok) return;

  const invalidated = await invalidateWithOneFill(provider, opened.value.session.sessionId);
  assert.deepEqual(invalidated, {
    ok: false,
    error: { code: "browser_effect_uncertain", retryable: false },
  });
  assert.deepEqual(
    await provider.close({
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      operationId: generatedOperationId("operation_close_invalidated_ok_1"),
      sessionId: opened.value.session.sessionId,
    }, new AbortController().signal),
    { ok: true, value: undefined },
  );
});

test("close preserves account invalidation cleanup failure for the exact session", async () => {
  const profiles = new MemoryProfiles();
  profiles.failCleanup = true;
  const { provider, opened } = await openedProviderThatInvalidatesAfterFill(profiles);
  if (!opened.ok) return;

  await invalidateWithOneFill(provider, opened.value.session.sessionId);
  assert.deepEqual(
    await provider.close({
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      operationId: generatedOperationId("operation_close_invalidated_fail_1"),
      sessionId: opened.value.session.sessionId,
    }, new AbortController().signal),
    {
      ok: false,
      error: { code: "browser_profile_cleanup_failed", retryable: false },
    },
  );
});

test("failed-open cleanup releases Chromium before deleting its locked profile", async () => {
  const context = new FakeContext([]);
  context.delayCloseMs = 5;
  const profiles = new MemoryProfiles();
  profiles.requireClosed = context;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        return {
          ownership: "owned",
          target: { kind: "target_mismatch", dimension: "posting" },
          snapshot: structuralSnapshot,
        } as const;
      },
    },
    profiles,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });

  const result = await provider.open(openRequest(), new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_target_invalid", retryable: false },
  });
  assert.equal(context.closed, true);
  assert.equal(profiles.partialCleanupCount, 1);
});

test("failed-open cleanup is bounded and starts context and profile removal", async () => {
  const context = new FakeContext([]);
  const profiles = new MemoryProfiles();
  context.hangClose = true;
  profiles.hangPartialCleanup = true;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        return {
          ownership: "owned",
          target: { kind: "target_mismatch", dimension: "posting" },
          snapshot: structuralSnapshot,
        } as const;
      },
    },
    profiles,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 5,
  });

  const result = await completesWithin(
    provider.open(openRequest(), new AbortController().signal),
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_profile_cleanup_failed", retryable: false },
  });
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.partialCleanupCount, 1);
});

test("cancellation after persistent launch begins returns uncertain and cleans late ownership", async () => {
  const context = new FakeContext([]);
  let release!: (context: FakeContext) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const launched = new Promise<FakeContext>((resolve) => { release = resolve; });
  const profiles = new MemoryProfiles();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: {
      async launchPersistentContext() {
        markStarted();
        return launched;
      },
    },
    probe: { async inspect() { return ownedMatched(); } },
    profiles,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const controller = new AbortController();

  const pending = provider.open(openRequest(), controller.signal);
  await started;
  controller.abort();
  release(context);
  const result = await pending;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_effect_uncertain", retryable: false },
  });
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.partialCleanupCount, 1);
});

test("read-only reconciliation timeout is retryable only as browser timeout", async () => {
  const context = new FakeContext([]);
  let slow = false;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        if (slow) await new Promise((resolve) => setTimeout(resolve, 20));
        return ownedMatched();
      },
    },
    profiles: new MemoryProfiles(),
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 2,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  slow = true;

  const result = await provider.reconcile(
    {
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      operationId: generatedOperationId("operation_5555555555555555"),
      session: opened.value.session,
      expectedTarget: liveFixtures.target,
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_timeout", retryable: true },
  });
});

test("stale or mismatched profile state is removed before a fresh launch", async () => {
  const profiles = new MemoryProfiles();
  profiles.marker = {
    schemaVersion: 1,
    journeyId: liveFixtures.otherJourneyId,
    profileLeaseId: liveFixtures.session.profileLeaseId,
    sessionId: liveFixtures.session.sessionId,
    target: liveFixtures.target,
    admittedAt: liveFixtures.issuedAt,
    leaseExpiresAt: liveFixtures.expiresAt,
  };
  let launches = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: {
      async launchPersistentContext() {
        launches += 1;
        return new FakeContext([]);
      },
    },
    probe: { async inspect() { return ownedMatched(); } },
    profiles,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });

  const result = await provider.open(openRequest(), new AbortController().signal);

  assert.equal(result.ok, true);
  assert.equal(profiles.partialCleanupCount, 1);
  assert.equal(launches, 1);
  assert.equal((profiles.marker as { journeyId?: unknown }).journeyId, liveFixtures.journeyId);
});

test("reconcile replays exact results and rejects changed operation reuse", async () => {
  const context = new FakeContext([]);
  let observation: OwnedTargetObservation = ownedMatched();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return observation; } },
    profiles: new MemoryProfiles(),
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const request = {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_6666666666666666"),
    session: opened.value.session,
    expectedTarget: liveFixtures.target,
  };
  const first = await provider.reconcile(request, new AbortController().signal);
  observation = {
    ownership: "owned",
    target: { kind: "posting_unavailable", reason: "closed" },
    snapshot: structuralSnapshot,
  };

  const replay = await provider.reconcile(request, new AbortController().signal);
  const conflict = await provider.reconcile(
    { ...request, expectedTarget: liveFixtures.otherTarget },
    new AbortController().signal,
  );

  assert.deepEqual(replay, first);
  assert.deepEqual(conflict, {
    ok: false,
    error: { code: "browser_operation_replayed", retryable: false },
  });
});

test("reconcile preserves each exact target fact without normalization", async () => {
  const facts = [
    { kind: "target_mismatch", dimension: "host" },
    { kind: "target_mismatch", dimension: "tenant" },
    { kind: "target_mismatch", dimension: "posting" },
    { kind: "target_ambiguous" },
    { kind: "posting_unavailable", reason: "not_found" },
    { kind: "posting_unavailable", reason: "closed" },
    { kind: "posting_unavailable", reason: "removed" },
    { kind: "posting_unavailable", reason: "unavailable" },
  ] as const;
  for (const [index, fact] of facts.entries()) {
    const context = new FakeContext([]);
    let current: OwnedTargetObservation = ownedMatched();
    const provider = new PlaywrightPersistentBrowserSession({
      binding: binding(),
      launcher: { async launchPersistentContext() { return context; } },
      probe: { async inspect() { return current; } },
      profiles: new MemoryProfiles(),
      ids: () => liveFixtures.session.sessionId,
      timeoutMs: 100,
    });
    const opened = await provider.open(openRequest(), new AbortController().signal);
    assert.equal(opened.ok, true);
    if (!opened.ok) continue;
    current = { ownership: "owned", target: fact, snapshot: structuralSnapshot };
    const result = await provider.reconcile(
      {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: generatedOperationId(
          `operation_${String(7000 + index).padStart(16, "0")}`,
        ),
        session: opened.value.session,
        expectedTarget: liveFixtures.target,
      },
      new AbortController().signal,
    );
    assert.deepEqual(result, { ok: true, value: fact });
  }
});

async function openedProviderThatInvalidatesAfterFill(
  profiles = new MemoryProfiles(),
) {
  let inspections = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: {
      async launchPersistentContext() {
        return new FakeContext([]);
      },
    },
    probe: {
      async inspect() {
        inspections += 1;
        return inspections < 3 ? ownedMatched() : { ownership: "foreign" };
      },
    },
    profiles,
    accountPage: {
      async inspect() { return { cardinality: 1, actionable: true }; },
      async fill() {},
      async matches() { return true; },
      async clear() {},
      async isEmpty() { return true; },
      async activate() {},
    },
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  return {
    provider,
    opened: await provider.open(openRequest(), new AbortController().signal),
  };
}

async function invalidateWithOneFill(
  provider: PlaywrightPersistentBrowserSession,
  sessionId: LiveSessionId,
) {
  return provider.withOwnedAccountPageAccess({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_account_invalidate_1"),
    sessionId,
    target: liveFixtures.target,
    now: liveFixtures.issuedAt,
  }, new AbortController().signal, async (access) => {
    await access.fill("email", new Uint8Array([1]));
  });
}

function openRequest(): PersistentBrowserOpenRequest {
  return {
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_1111111111111111"),
    profileLeaseId: liveFixtures.session.profileLeaseId,
    target: liveFixtures.target,
  };
}

function binding(
  admittedAt: string = liveFixtures.issuedAt,
  leaseExpiresAt: string = liveFixtures.expiresAt,
) {
  return {
    forPersistentBrowser: () => ({
      targetUrl: "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
      profilePath: "C:\\outside\\runtime\\browser-profile",
      admittedAt,
      leaseExpiresAt,
    }),
  };
}

class FakePage {
  readonly navigations: string[] = [];
  closed = false;

  async goto(target: string): Promise<void> {
    this.navigations.push(target);
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeContext {
  closed = false;
  newPageCount = 0;
  closeCount = 0;
  failClose = false;
  hangClose = false;
  delayCloseMs = 0;
  readonly ownedPages: FakePage[];

  constructor(ownedPages: FakePage[]) {
    this.ownedPages = ownedPages;
  }

  pages(): FakePage[] {
    return this.ownedPages;
  }

  async newPage(): Promise<FakePage> {
    this.newPageCount += 1;
    const page = new FakePage();
    this.ownedPages.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.hangClose) return new Promise(() => undefined);
    if (this.failClose) throw new Error("synthetic close failure");
    if (this.delayCloseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayCloseMs));
    }
    this.closed = true;
  }
}

class MemoryProfiles {
  marker: unknown;
  cleanupCount = 0;
  failCleanup = false;
  hangCleanup = false;
  hangPartialCleanup = false;
  partialCleanupCount = 0;
  requireClosed?: FakeContext;

  async read(): Promise<unknown> {
    return this.marker;
  }

  async write(_profilePath: string, marker: unknown): Promise<void> {
    this.marker = marker;
  }

  async cleanup(): Promise<void> {
    this.cleanupCount += 1;
    if (this.requireClosed !== undefined && !this.requireClosed.closed) {
      throw new Error("profile is still locked");
    }
    if (this.hangCleanup) return new Promise(() => undefined);
    if (this.failCleanup) throw new Error("synthetic cleanup failure");
    this.marker = undefined;
  }

  async cleanupPartial(): Promise<void> {
    this.partialCleanupCount += 1;
    if (this.requireClosed !== undefined && !this.requireClosed.closed) {
      throw new Error("profile is still locked");
    }
    if (this.hangPartialCleanup) return new Promise(() => undefined);
    this.marker = undefined;
  }
}

async function completesWithin<T>(action: Promise<T>): Promise<T> {
  return Promise.race([
    action,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("operation did not terminate")), 100);
    }),
  ]);
}

const structuralSnapshot = {
  schemaVersion: 1 as const,
  traitIds: ["structural_trait_1111111111111111"],
  controlCount: 2,
  requiredControlCount: 1,
  optionCount: 0,
};

function ownedMatched() {
  return {
    ownership: "owned" as const,
    target: { kind: "matched" as const },
    snapshot: structuralSnapshot,
  };
}
