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
import { OwnedWorkdayApplicationRuntime } from "../../../src/browser/playwright-live/private/workday-application-runtime.ts";
import type { OwnedTargetObservation } from "../../../src/browser/playwright-live/private/types.ts";
import {
  ownedApplicationPageAccess,
  releaseOwnedApplicationSession,
  retainOwnedApplicationSession,
  suspendOwnedApplicationSession,
} from "../../../src/browser/playwright-live/private/application-page-types.ts";

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

test("private test mode discards an exact persisted login profile before launch", async () => {
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
  const context = new FakeContext([]);
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    browserMode: "private_test",
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles,
    ids: () => "live_session_private_test_1" as LiveSessionId,
    timeoutMs: 100,
  });

  const result = await provider.open(openRequest(), new AbortController().signal);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.kind, "opened");
  assert.equal(profiles.partialCleanupCount, 1);
  assert.equal(context.newPageCount, 1);
});

test("test logout control stays bound to the exact owned browser session", async () => {
  const context = new FakeContext([]);
  let logoutCalls = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    sessionControl: {
      async logout() {
        logoutCalls += 1;
        return { kind: "signed_out" };
      },
    },
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const result = await provider.logoutForTesting({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_logout_test_0001"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal);

  assert.deepEqual(result, { ok: true, value: { kind: "signed_out" } });
  assert.equal(logoutCalls, 1);
});

test("logout-after-test runs before close and never prevents exact cleanup", async () => {
  const context = new FakeContext([]);
  const profiles = new MemoryProfiles();
  profiles.requireClosed = context;
  let logoutCalls = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles,
    sessionControl: {
      async logout() {
        logoutCalls += 1;
        return { kind: "signed_out" };
      },
    },
    logoutOnCloseForTesting: true,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const closed = await provider.close({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_logout_close_0001"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal);

  assert.deepEqual(closed, { ok: true, value: undefined });
  assert.equal(logoutCalls, 1);
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.cleanupCount, 1);
});

test("logout verification is not cut off by the ordinary browser-operation timeout", async () => {
  const context = new FakeContext([]);
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    sessionControl: {
      async logout() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { kind: "signed_out" };
      },
    },
    logoutOnCloseForTesting: true,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 20,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const closed = await provider.close({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_logout_budget_0001"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal);

  assert.deepEqual(closed, { ok: true, value: undefined });
});

test("a fresh persistent context reuses its sole launch page instead of retaining about:blank", async () => {
  const launchPage = new FakePage();
  const context = new FakeContext([launchPage]);
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect(page) {
      return page === launchPage ? ownedMatched() : { ownership: "foreign" };
    } },
    profiles: new MemoryProfiles(),
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });

  const result = await provider.open(openRequest(), new AbortController().signal);

  assert.equal(result.ok, true);
  assert.equal(context.newPageCount, 0);
  assert.equal(context.pages().length, 1);
  assert.deepEqual(launchPage.navigations, [
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
  ]);
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

test("application access denies callers when the fixed owned runtime is absent", async () => {
  const pages: FakePage[] = [];
  const context = new FakeContext(pages);
  let inspections = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        inspections += 1;
        return ownedMatched();
      },
    },
    profiles: new MemoryProfiles(),
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const result = await provider[ownedApplicationPageAccess]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_application_read_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: liveFixtures.issuedAt,
  }, { kind: "observe" }, new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_session_missing", retryable: false },
  });
  assert.equal(inspections, 1);
});

test("application mutation is unavailable without the fixed owned runtime", async () => {
  let inspections = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return new FakeContext([]); } },
    probe: {
      async inspect() {
        inspections += 1;
        return inspections < 3 ? ownedMatched() : { ownership: "foreign" };
      },
    },
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
    operationId: generatedOperationId("operation_application_write1"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: liveFixtures.issuedAt,
  };
  assert.deepEqual(await provider[ownedApplicationPageAccess](
    request,
    { kind: "reload" },
    new AbortController().signal,
  ), {
    ok: false,
    error: { code: "browser_session_missing", retryable: false },
  });
  assert.deepEqual(await provider[ownedApplicationPageAccess](
    { ...request, operationId: generatedOperationId("operation_application_write2") },
    { kind: "reload" },
    new AbortController().signal,
  ), {
    ok: false,
    error: { code: "browser_session_missing", retryable: false },
  });
});

test("rejected retention leaves one fallback cleanup owner and exposes explicit release", async () => {
  const context = new FakeContext([]);
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
  const retention = await provider[retainOwnedApplicationSession]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_retention_reject_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: liveFixtures.issuedAt,
    ownerApprovalExpiresAt: liveFixtures.expiresAt,
  }, new AbortController().signal);
  assert.deepEqual(retention, {
    ok: false,
    error: { code: "browser_session_missing", retryable: false },
  });
  const released = await provider[releaseOwnedApplicationSession]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_release_without_retention_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: liveFixtures.issuedAt,
  }, new AbortController().signal);
  assert.deepEqual(released, {
    ok: false,
    error: { code: "browser_session_missing", retryable: false },
  });
  const closed = await provider.close({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_retention_fallback_close_01"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal);
  assert.deepEqual(closed, { ok: true, value: undefined });
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.cleanupCount, 1);
});

test("successful retention releases the live session exactly once", async () => {
  const now = Date.now();
  const context = new FakeContext([]);
  const profiles = new MemoryProfiles();
  let probeCalls = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(new Date(now - 1_000).toISOString(), new Date(now + 60_000).toISOString()),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { probeCalls += 1; return { ownership: "owned", target: { kind: "matched" }, snapshot: structuralSnapshot }; } },
    profiles,
    applicationRuntime: candidateApplicationRuntime(new Date(now + 30_000).toISOString()),
    now: () => new Date().toISOString(),
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 1_500,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const direct = new OwnedWorkdayApplicationRuntime(candidateApplicationRuntime(new Date(now + 30_000).toISOString()));
  direct.bindSession(opened.value.session);
  await assert.doesNotReject(() => direct.run(context.ownedPages[0]! as never, {
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_profile_candidate_direct_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: new Date().toISOString(),
  }, { kind: "observe" }, new AbortController().signal));
  const observed = await provider[ownedApplicationPageAccess]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_profile_candidate_observe_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: new Date().toISOString(),
  }, { kind: "observe" }, new AbortController().signal);
  assert.ok(observed.ok, `${JSON.stringify(observed)} probes=${probeCalls}`);
  const unavailable = await provider[ownedApplicationPageAccess]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_profile_candidate_access_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: new Date().toISOString(),
  }, { kind: "reconcile_profile", input: { pageId: "page-profile" } }, new AbortController().signal);
  assert.deepEqual(unavailable, {
    ok: true,
    value: {
      ok: false,
      error: { code: "page_incomplete", classifier: "profile_page", primitive: "profile_control", unknownLayer: "ui_behavior" },
    },
  });
  const retained = await provider[retainOwnedApplicationSession]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_retention_release_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: new Date().toISOString(),
    ownerApprovalExpiresAt: new Date(now + 30_000).toISOString(),
  }, new AbortController().signal);
  assert.deepEqual(retained, { ok: true, value: undefined });
  const closed = await provider.close({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_retention_release_close_01"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal);
  assert.deepEqual(closed, { ok: true, value: undefined });
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.cleanupCount, 1);
});

test("retention rejects a pinned-target drift and leaves fallback cleanup as owner", async () => {
  const now = Date.now();
  const context = new FakeContext([]);
  const profiles = new MemoryProfiles();
  let targetMatched = true;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(new Date(now - 1_000).toISOString(), new Date(now + 60_000).toISOString()),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() {
      return targetMatched
        ? ownedMatched()
        : {
          ownership: "owned" as const,
          target: { kind: "target_mismatch" as const, dimension: "posting" as const },
          snapshot: structuralSnapshot,
        };
    } },
    profiles,
    applicationRuntime: candidateApplicationRuntime(new Date(now + 30_000).toISOString()),
    now: () => new Date().toISOString(),
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 1_500,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const unavailable = await provider[ownedApplicationPageAccess]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_profile_candidate_drift_access_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: new Date().toISOString(),
  }, { kind: "reconcile_profile", input: { pageId: "page-profile" } }, new AbortController().signal);
  assert.equal(unavailable.ok, true);
  targetMatched = false;
  const rejected = await provider[retainOwnedApplicationSession]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_retention_drift_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: new Date().toISOString(),
    ownerApprovalExpiresAt: new Date(now + 30_000).toISOString(),
  }, new AbortController().signal);
  assert.deepEqual(rejected, {
    ok: false,
    error: { code: "browser_session_invalidated", retryable: false },
  });
  assert.equal(context.closeCount, 0);
  assert.deepEqual(await provider.close({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_retention_drift_close_01"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal), { ok: true, value: undefined });
  assert.equal(context.closeCount, 1);
  assert.equal(profiles.cleanupCount, 1);
});

test("retained session expiry timer releases context and profile", async () => {
  const now = Date.now();
  const context = new FakeContext([]);
  const profiles = new MemoryProfiles();
  let probeCalls = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(new Date(now - 1_000).toISOString(), new Date(now + 1_250).toISOString()),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { probeCalls += 1; return { ownership: "owned", target: { kind: "matched" }, snapshot: structuralSnapshot }; } },
    profiles,
    applicationRuntime: candidateApplicationRuntime(new Date(now + 30_000).toISOString()),
    now: () => new Date().toISOString(),
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 1_500,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const observed = await provider[ownedApplicationPageAccess]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_profile_candidate_expiry_observe_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: new Date().toISOString(),
  }, { kind: "observe" }, new AbortController().signal);
  assert.ok(observed.ok, `${JSON.stringify(observed)} probes=${probeCalls}`);
  const unavailable = await provider[ownedApplicationPageAccess]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_profile_candidate_expiry_access_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: new Date().toISOString(),
  }, { kind: "reconcile_profile", input: { pageId: "page-profile" } }, new AbortController().signal);
  assert.deepEqual(unavailable, {
    ok: true,
    value: {
      ok: false,
      error: { code: "page_incomplete", classifier: "profile_page", primitive: "profile_control", unknownLayer: "ui_behavior" },
    },
  });
  const retained = await provider[retainOwnedApplicationSession]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_retention_expiry_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: new Date().toISOString(),
    ownerApprovalExpiresAt: new Date(now + 30_000).toISOString(),
  }, new AbortController().signal);
  assert.deepEqual(retained, { ok: true, value: undefined });
  await waitFor(() => context.closeCount === 1 && profiles.cleanupCount === 1, 3_000);
  assert.equal(context.closed, true);
  assert.equal(profiles.marker, undefined);
});

test("expired and closed retained-state requests fail closed without teardown masking", async () => {
  const context = new FakeContext([]);
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(liveFixtures.issuedAt, "2026-08-05T12:00:01.000Z"),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    ids: () => liveFixtures.session.sessionId,
    now: () => "2026-08-05T12:00:02.000Z",
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  context.ownedPages[0]!.closed = true;
  const rejected = await provider[retainOwnedApplicationSession]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_retention_expired_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: "2026-08-05T12:00:02.000Z",
    ownerApprovalExpiresAt: "2026-08-05T12:00:03.000Z",
  }, new AbortController().signal);
  assert.deepEqual(rejected, {
    ok: false,
    error: { code: "browser_session_missing", retryable: false },
  });
  const closed = await provider.close({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_retention_expired_close_01"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal);
  assert.deepEqual(closed, { ok: true, value: undefined });
  assert.equal(context.closeCount, 1);
});

test("application owner sources are deterministically revoked after close", async () => {
  const context = new FakeContext([]);
  let sourceReads = 0;
  const ownerSources = new Proxy({}, {
    get() {
      sourceReads += 1;
      throw new Error("revoked owner source was read");
    },
  });
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    applicationRuntime: {
      request: { ownerSources } as never,
      acceptances: { record() { throw new Error("acceptance must not run"); } },
      nextOperationId: () => generatedOperationId("operation_revoked_source_01"),
      timeoutMs: 100,
    initialReviewExpected: [],
    authorizationExpiresAt: "2026-08-01T18:30:00.000Z",
    now: () => "2026-08-01T18:00:00.000Z",
    },
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const closed = await provider.close({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_revoked_close_01"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal);
  assert.deepEqual(closed, { ok: true, value: undefined });
  const denied = await provider[ownedApplicationPageAccess]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_revoked_access_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: liveFixtures.issuedAt,
  }, { kind: "review_expectations" }, new AbortController().signal);
  assert.deepEqual(denied, {
    ok: false,
    error: { code: "browser_session_missing", retryable: false },
  });
  assert.equal(sourceReads, 0);
});

test("application owner sources are revoked when open fails before launch", async () => {
  const context = new FakeContext([]);
  let sourceReads = 0;
  const ownerSources = new Proxy({}, {
    get() {
      sourceReads += 1;
      throw new Error("revoked owner source was read");
    },
  });
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    applicationRuntime: {
      request: { ownerSources } as never,
      acceptances: { record() { throw new Error("acceptance must not run"); } },
      nextOperationId: () => generatedOperationId("operation_failed_open_revoke_01"),
      timeoutMs: 100,
    initialReviewExpected: [],
    authorizationExpiresAt: "2026-08-01T18:30:00.000Z",
    now: () => "2026-08-01T18:00:00.000Z",
    },
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const cancelled = new AbortController();
  cancelled.abort();
  assert.deepEqual(await provider.open(openRequest(), cancelled.signal), {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });

  const opened = await provider.open({
    ...openRequest(),
    operationId: generatedOperationId("operation_after_failed_open_01"),
  }, new AbortController().signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const denied = await provider[ownedApplicationPageAccess]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_after_failed_access_01"),
    sessionId: opened.value.session.sessionId,
    target: liveFixtures.target,
    now: liveFixtures.issuedAt,
  }, { kind: "review_expectations" }, new AbortController().signal);
  assert.deepEqual(denied, {
    ok: false,
    error: { code: "browser_session_missing", retryable: false },
  });
  assert.equal(sourceReads, 0);
});

test("application suspension closes the context but retains the exact restart marker", async () => {
  const context = new FakeContext([]);
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
  const retainedMarker = profiles.marker;
  const result = await provider[suspendOwnedApplicationSession]({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_suspend_app_0001"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal);
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(context.closed, true);
  assert.equal(profiles.cleanupCount, 0);
  assert.equal(profiles.marker, retainedMarker);
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

test("close reconciles a Playwright rejection only when its owned open page closed", async () => {
  const context = new FakeContext([]);
  context.failCloseAfterClosing = true;
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

  const result = await provider.close({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_close_reconciled_1"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal);

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(context.closed, true);
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
  let captureCount = 0;
  let closedDuringHold: boolean | undefined;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    inspectionCaptureBeforeCleanup: async (page) => {
      captureCount += 1;
      assert.equal(page.isClosed(), false);
    },
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
  assert.equal(captureCount, 1);
  assert.equal(closedDuringHold, false);
  assert.equal(context.closed, true);
});

test("diagnostic hold rejection fails closed after guaranteed browser cleanup", async () => {
  const context = new FakeContext([]);
  const profiles = new MemoryProfiles();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles,
    inspectionHoldBeforeCleanup: async () => {
      throw new Error("monitor acknowledgement unavailable");
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
    operationId: generatedOperationId("operation_diagnostic_hold_close_2"),
    sessionId: opened.value.session.sessionId,
  }, new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_effect_uncertain", retryable: false },
  });
  assert.equal(context.closed, true);
  assert.equal(profiles.marker, undefined);
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

function candidateApplicationRuntime(authorizationExpiresAt: string) {
  return {
    request: {
      owner: { roots: { evidence: { path: "C:\\outside\\evidence" } } },
      ownerSources: {
        profilePlan: {
          mode: "synthetic_test_non_submittable",
          pageType: "profile",
          fields: [],
          repeatables: [],
        },
        sensitiveValues: [],
      },
    } as never,
    acceptances: { record() {} },
    nextOperationId: () => generatedOperationId("operation_profile_candidate_01"),
    timeoutMs: 100,
    initialReviewExpected: [],
    authorizationExpiresAt,
    now: () => new Date().toISOString(),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, "condition did not become true");
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

  frames(): FakePage[] {
    return [this];
  }

  locator(): FakeLocator {
    return new FakeLocator();
  }

  getByRole(): FakeLocator {
    return new FakeLocator();
  }

  async evaluate(): Promise<unknown> {
    return {
      page: "profile",
      lanes: ["profile"],
      rootSelector: '[data-automation-id="applyFlowMyInfoPage"]',
      pageId: "page-profile",
      requiredFields: [],
      c3OwnedDuplicateRows: 0,
      submitActivated: false,
      signature: "profile-fixture",
      transitionKey: "profile-fixture",
      validationKeys: [],
      validationOwners: [],
    };
  }

  async waitForTimeout(): Promise<void> {}

  async reload(): Promise<void> {}
}

class FakeLocator {
  async count(): Promise<number> { return 0; }
  nth(): FakeLocator { return this; }
  async isVisible(): Promise<boolean> { return false; }
  async getAttribute(): Promise<string | null> { return null; }
  locator(): FakeLocator { return this; }
  async evaluateAll(): Promise<never[]> { return []; }
}

class FakeContext {
  closed = false;
  newPageCount = 0;
  closeCount = 0;
  failClose = false;
  failCloseAfterClosing = false;
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
    for (const page of this.ownedPages) page.closed = true;
    if (this.failCloseAfterClosing) throw new Error("synthetic post-close failure");
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
