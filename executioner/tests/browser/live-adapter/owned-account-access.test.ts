import assert from "node:assert/strict";
import { test } from "node:test";

import { generatedOperationId } from "../../../src/contracts/index.ts";
import type { LiveSessionId } from "../../../src/contracts/live/index.ts";
import { liveFixtures } from "../../../src/testing/live/index.ts";
import { findLivePrivacyViolations } from "../../../src/testing/live/privacy.ts";
import { PlaywrightPersistentBrowserSession } from "../../../src/browser/playwright-live/index.ts";
import { authMonitorPhase } from
  "../../../src/browser/playwright-live/private/owned-account-page-coordinator.ts";
import type { Stage2ExternalMonitorRuntime } from
  "../../../src/live/evidence/external-monitor-runtime.ts";

test("external monitor ACK blocks account mutation and binds the same owned page through readback", async () => {
  const context = new FakeContext();
  const semantic = new FakeSemanticAccountPage();
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const records: Parameters<Stage2ExternalMonitorRuntime["auth"]>[] = [];
  const monitor = {
    async auth(...args: Parameters<Stage2ExternalMonitorRuntime["auth"]>) {
      records.push(args);
      if (args[2] === "before_mutation") {
        entered?.();
        await new Promise<void>((resolve) => { release = resolve; });
      }
    },
    async application(..._args: Parameters<Stage2ExternalMonitorRuntime["application"]>) {},
  };
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedAccountEntry(); } },
    profiles: new MemoryProfiles(),
    accountPage: semantic,
    externalMonitor: monitor,
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), AbortSignal.any([]));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const request = accessRequest(opened.value.session.sessionId);
  const pending = provider.withOwnedAccountPageAccess(
    request,
    AbortSignal.any([]),
    async (access) => {
      assert.deepEqual(await access.fill("email", Uint8Array.of(1, 2)), { ok: true, value: undefined });
      assert.deepEqual(await access.matches("email", Uint8Array.of(1, 2)), { ok: true, value: true });
    },
  );
  await waiting;
  assert.equal(semantic.fillCalls, 0);
  release?.();
  assert.deepEqual(await pending, { ok: true, value: undefined });
  assert.equal(semantic.fillCalls, 1);
  assert.deepEqual(records.map((args) => [args[1], args[2], args[4]]), [
    ["account_entry", "before_mutation", { operationId: request.operationId, attempt: 1 }],
    ["account_entry", "after_readback", { operationId: request.operationId, attempt: 1 }],
  ]);
  assert.equal(records[0]?.[0], context.page);
  assert.equal(records[1]?.[0], context.page);
});

test("external monitoring retries exact ownership through a bounded post-submit transition", async () => {
  const context = new FakeContext();
  const semantic = new FakeSemanticAccountPage();
  let inspections = 0;
  const records: Parameters<Stage2ExternalMonitorRuntime["auth"]>[] = [];
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        inspections += 1;
        return inspections === 3 ? { ownership: "foreign" as const } : ownedAccountEntry();
      },
    },
    profiles: new MemoryProfiles(),
    accountPage: semantic,
    externalMonitor: {
      async auth(...args) { records.push(args); },
      async application() {},
    },
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 250,
  });
  const opened = await provider.open(openRequest(), AbortSignal.any([]));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const result = await provider.withOwnedAccountPageAccess(
    accessRequest(opened.value.session.sessionId),
    AbortSignal.any([]),
    async (access) => {
      assert.deepEqual(await access.activate("submit_sign_in"), { ok: true, value: undefined });
    },
  );

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(inspections >= 5, true);
  assert.deepEqual(records.map((args) => args[2]), ["before_mutation", "after_readback"]);
});

test("auth monitoring reports a visible sign-in overlay before its backing application page", () => {
  assert.equal(authMonitorPhase({
    schemaVersion: 1,
    traitIds: [
      "structural_trait_page_candidate_home_v1",
      "structural_trait_page_account_entry_v1",
      "structural_trait_account_sign_in_v1",
    ],
    controlCount: 3,
    requiredControlCount: 2,
    optionCount: 0,
  }), "sign_in");
});

test("callback receives only closed semantic account controls after exact ownership admission", async () => {
  const context = new FakeContext();
  const semantic = new FakeSemanticAccountPage();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    accountPage: semantic,
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(openRequest(), AbortSignal.any([]));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const observations: unknown[] = [];

  const result = await provider.withOwnedAccountPageAccess(
    accessRequest(opened.value.session.sessionId),
    AbortSignal.any([]),
    async (access) => {
      observations.push(await access.inspectField("email"));
      observations.push(await access.inspectAction("show_sign_in"));
    },
  );

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(observations, [
    { ok: true, value: { cardinality: 1, actionable: true } },
    { ok: true, value: { cardinality: 1, actionable: true } },
  ]);
  const serialized = JSON.stringify(observations);
  assert.deepEqual(findLivePrivacyViolations(observations), []);
  assert.deepEqual(findLivePrivacyViolations(JSON.parse(serialized)), []);
  for (const forbidden of ["page", "locator", "selector", "url", "dom", "text"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test("field bytes are transient and independently matched before verified clear", async () => {
  const context = new FakeContext();
  const semantic = new FakeSemanticAccountPage();
  let ownershipChecks = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        ownershipChecks += 1;
        return ownedMatched();
      },
    },
    profiles: new MemoryProfiles(),
    accountPage: semantic,
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000002") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const expected = Uint8Array.from([97, 98, 99]);
  const mismatch = Uint8Array.from([120, 121, 122]);
  const facts: unknown[] = [];

  const result = await provider.withOwnedAccountPageAccess(
    {
      ...accessRequest(opened.value.session.sessionId),
      operationId: generatedOperationId("operation_8200000000000002"),
    },
    AbortSignal.any([]),
    async (access) => {
      facts.push(await access.fill("email", expected));
      facts.push(await access.matches("email", expected));
      facts.push(await access.matches("email", mismatch));
      facts.push(await access.clear("email"));
      facts.push(await access.isEmpty("email"));
    },
  );

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(facts, [
    { ok: true, value: undefined },
    { ok: true, value: true },
    { ok: true, value: false },
    { ok: true, value: undefined },
    { ok: true, value: true },
  ]);
  assert.deepEqual([...expected], [97, 98, 99]);
  assert.deepEqual([...mismatch], [120, 121, 122]);
  assert.equal(semantic.receivedBuffers.every((bytes) => bytes.every((value) => value === 0)), true);
  assert.equal(ownershipChecks, 7);
});

test("only exact unique actionable semantic intents can activate", async () => {
  const context = new FakeContext();
  const semantic = new FakeSemanticAccountPage();
  semantic.facts.set("show_create_account", { cardinality: 0, actionable: false });
  semantic.facts.set("submit_sign_in", { cardinality: 2, actionable: true });
  semantic.facts.set("submit_create_account", { cardinality: 1, actionable: false });
  let ownershipChecks = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        ownershipChecks += 1;
        return ownedMatched();
      },
    },
    profiles: new MemoryProfiles(),
    accountPage: semantic,
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000003") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const results: unknown[] = [];

  const result = await provider.withOwnedAccountPageAccess(
    {
      ...accessRequest(opened.value.session.sessionId),
      operationId: generatedOperationId("operation_8200000000000003"),
    },
    AbortSignal.any([]),
    async (access) => {
      results.push(await access.activate("show_sign_in"));
      results.push(await access.activate("show_create_account"));
      results.push(await access.activate("submit_sign_in"));
      results.push(await access.activate("submit_create_account"));
    },
  );

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(results, [
    { ok: true, value: undefined },
    { ok: false, error: { code: "browser_target_invalid", retryable: false } },
    { ok: false, error: { code: "browser_target_ambiguous", retryable: false } },
    { ok: false, error: { code: "browser_target_invalid", retryable: false } },
  ]);
  assert.deepEqual(semantic.activated, ["show_sign_in"]);
  assert.equal(ownershipChecks, 3);
});

test("redirect or popup ownership loss after an effect is uncertain and invalidates the session", async () => {
  const losses = [
    { kind: "target_mismatch", dimension: "posting" },
    { kind: "target_ambiguous" },
  ] as const;
  for (const [index, loss] of losses.entries()) {
    const context = new FakeContext();
    const semantic = new FakeSemanticAccountPage();
    let checks = 0;
    const provider = new PlaywrightPersistentBrowserSession({
      binding: binding(),
      launcher: { async launchPersistentContext() { return context; } },
      probe: {
        async inspect() {
          checks += 1;
          return checks < 3
            ? ownedMatched()
            : { ownership: "owned" as const, target: loss, snapshot: ownedMatched().snapshot };
        },
      },
      profiles: new MemoryProfiles(),
      accountPage: semantic,
      ids: () => liveFixtures.session.sessionId as LiveSessionId,
      timeoutMs: 100,
    });
    const opened = await provider.open(
      {
        ...openRequest(),
        operationId: generatedOperationId(
          `operation_${String(8100000000000004 + index)}`,
        ),
      },
      AbortSignal.any([]),
    );
    assert.equal(opened.ok, true);
    if (!opened.ok) continue;
    const effects: unknown[] = [];

    const result = await provider.withOwnedAccountPageAccess(
      {
        ...accessRequest(opened.value.session.sessionId),
        operationId: generatedOperationId(
          `operation_${String(8200000000000004 + index)}`,
        ),
      },
      AbortSignal.any([]),
      async (access) => {
        effects.push(await access.fill("password", Uint8Array.from([65, 66])));
        effects.push(await access.inspectField("password"));
      },
    );

    assert.deepEqual(result, {
      ok: false,
      error: { code: "browser_effect_uncertain", retryable: false },
    });
    assert.deepEqual(effects, [
      { ok: false, error: { code: "browser_effect_uncertain", retryable: false } },
      { ok: false, error: { code: "browser_session_invalidated", retryable: false } },
    ]);
    assert.equal(context.closeCount, 1);
  }
});

test("cancellation before a semantic effect is exact and leaves the owned session intact", async () => {
  const context = new FakeContext();
  const semantic = new FakeSemanticAccountPage();
  const controller = new AbortController();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    accountPage: semantic,
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000006") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  let fieldResult: unknown;

  const result = await provider.withOwnedAccountPageAccess(
    {
      ...accessRequest(opened.value.session.sessionId),
      operationId: generatedOperationId("operation_8200000000000006"),
    },
    controller.signal,
    async (access) => {
      controller.abort();
      fieldResult = await access.fill("email", Uint8Array.from([1, 2]));
    },
  );

  assert.deepEqual(fieldResult, {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.deepEqual(result, fieldResult);
  assert.equal(semantic.fillCalls, 0);
  assert.equal(context.closeCount, 0);
});

test("cancellation after a fill may begin is uncertain and clears the transient buffer", async () => {
  const context = new FakeContext();
  const semantic = new FakeSemanticAccountPage();
  let release!: () => void;
  let markStarted!: () => void;
  semantic.fillGate = {
    started: new Promise<void>((resolve) => { markStarted = resolve; }),
    wait: new Promise<void>((resolve) => { release = resolve; }),
    markStarted: () => markStarted(),
  };
  const controller = new AbortController();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    accountPage: semantic,
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000007") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  let fieldResult: unknown;

  const pending = provider.withOwnedAccountPageAccess(
    {
      ...accessRequest(opened.value.session.sessionId),
      operationId: generatedOperationId("operation_8200000000000007"),
    },
    controller.signal,
    async (access) => {
      fieldResult = await access.fill("email", Uint8Array.from([3, 4]));
    },
  );
  await semantic.fillGate.started;
  controller.abort();
  const result = await pending;
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(fieldResult, {
    ok: false,
    error: { code: "browser_effect_uncertain", retryable: false },
  });
  assert.deepEqual(result, fieldResult);
  assert.equal(context.closeCount, 1);
  assert.equal(semantic.receivedBuffers.every((bytes) => bytes.every((value) => value === 0)), true);
});

test("callback scope is one-shot, non-concurrent, and invalid after return", async () => {
  const context = new FakeContext();
  const semantic = new FakeSemanticAccountPage();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    accountPage: semantic,
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000008") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let retained: { inspectField(field: "email"): Promise<unknown> } | undefined;
  const request = {
    ...accessRequest(opened.value.session.sessionId),
    operationId: generatedOperationId("operation_8200000000000008"),
  };

  const first = provider.withOwnedAccountPageAccess(
    request,
    AbortSignal.any([]),
    async (access) => {
      retained = access;
      markStarted();
      await wait;
    },
  );
  await started;
  const concurrent = await provider.withOwnedAccountPageAccess(
    { ...request, operationId: generatedOperationId("operation_8200000000000009") },
    AbortSignal.any([]),
    async () => {},
  );
  release();
  const completed = await first;
  const replay = await provider.withOwnedAccountPageAccess(
    request,
    AbortSignal.any([]),
    async () => {},
  );
  const afterReturn = await retained!.inspectField("email");

  const rejected = {
    ok: false,
    error: { code: "browser_operation_replayed", retryable: false },
  } as const;
  assert.deepEqual(completed, { ok: true, value: undefined });
  assert.deepEqual(concurrent, rejected);
  assert.deepEqual(replay, rejected);
  assert.deepEqual(afterReturn, {
    ok: false,
    error: { code: "browser_session_invalidated", retryable: false },
  });
});

test("a callback throw returns uncertainty and invalidates the owned browser", async () => {
  const context = new FakeContext();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    accountPage: new FakeSemanticAccountPage(),
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000010") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const result = await provider.withOwnedAccountPageAccess(
    {
      ...accessRequest(opened.value.session.sessionId),
      operationId: generatedOperationId("operation_8200000000000010"),
    },
    AbortSignal.any([]),
    async () => { throw new TypeError("synthetic callback failure"); },
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_effect_uncertain", retryable: false },
  });
  assert.equal(context.closeCount, 1);
});

test("account access rejects mismatched identity, lease time, or initial pin before callback", async () => {
  const invalidRequests = [
    { schemaVersion: 2 as never },
    { journeyId: liveFixtures.otherJourneyId },
    { sessionId: "live_session_ffffffffffffffffffffffffffffffff" as LiveSessionId },
    { target: liveFixtures.otherTarget },
    { now: liveFixtures.pastAt },
    { now: liveFixtures.expiresAt },
  ] as const;
  for (const [index, invalid] of invalidRequests.entries()) {
    const context = new FakeContext();
    const provider = new PlaywrightPersistentBrowserSession({
      binding: binding(),
      launcher: { async launchPersistentContext() { return context; } },
      probe: { async inspect() { return ownedMatched(); } },
      profiles: new MemoryProfiles(),
      accountPage: new FakeSemanticAccountPage(),
      ids: () => liveFixtures.session.sessionId as LiveSessionId,
      timeoutMs: 100,
    });
    const opened = await provider.open(
      {
        ...openRequest(),
        operationId: generatedOperationId(`operation_${String(8100000000000040 + index)}`),
      },
      AbortSignal.any([]),
    );
    assert.equal(opened.ok, true);
    if (!opened.ok) continue;
    let called = false;

    const result = await provider.withOwnedAccountPageAccess(
      {
        ...accessRequest(opened.value.session.sessionId),
        operationId: generatedOperationId(`operation_${String(8200000000000040 + index)}`),
        ...invalid,
      },
      AbortSignal.any([]),
      async () => { called = true; },
    );

    assert.deepEqual(result, {
      ok: false,
      error: { code: "browser_session_missing", retryable: false },
    });
    assert.equal(called, false);
    assert.equal(context.closeCount, 0);
  }

  const context = new FakeContext();
  let checks = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        checks += 1;
        return checks === 1
          ? ownedMatched()
          : { ownership: "foreign" as const };
      },
    },
    profiles: new MemoryProfiles(),
    accountPage: new FakeSemanticAccountPage(),
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000025") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  let called = false;
  const result = await provider.withOwnedAccountPageAccess(
    {
      ...accessRequest(opened.value.session.sessionId),
      operationId: generatedOperationId("operation_8200000000000025"),
    },
    AbortSignal.any([]),
    async () => { called = true; },
  );
  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_session_missing", retryable: false },
  });
  assert.equal(called, false);
});

test("missing, ambiguous, hidden, or disabled fields cannot be mutated", async () => {
  const context = new FakeContext();
  const semantic = new FakeSemanticAccountPage();
  semantic.facts.set("email", { cardinality: 0, actionable: false });
  semantic.facts.set("password", { cardinality: 2, actionable: true });
  semantic.facts.set("password_confirmation", { cardinality: 1, actionable: false });
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    accountPage: semantic,
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000030") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const outcomes: unknown[] = [];

  const result = await provider.withOwnedAccountPageAccess(
    {
      ...accessRequest(opened.value.session.sessionId),
      operationId: generatedOperationId("operation_8200000000000030"),
    },
    AbortSignal.any([]),
    async (access) => {
      outcomes.push(await access.fill("email", Uint8Array.of(1)));
      outcomes.push(await access.fill("password", Uint8Array.of(2)));
      outcomes.push(await access.fill("password_confirmation", Uint8Array.of(3)));
    },
  );

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(outcomes, [
    { ok: false, error: { code: "browser_target_invalid", retryable: false } },
    { ok: false, error: { code: "browser_target_ambiguous", retryable: false } },
    { ok: false, error: { code: "browser_target_invalid", retryable: false } },
  ]);
  assert.equal(semantic.fillCalls, 0);
});

test("returning with an unverified field effect is uncertain and invalidates the session", async () => {
  const context = new FakeContext();
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    accountPage: new FakeSemanticAccountPage(),
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000031") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const result = await provider.withOwnedAccountPageAccess(
    {
      ...accessRequest(opened.value.session.sessionId),
      operationId: generatedOperationId("operation_8200000000000031"),
    },
    AbortSignal.any([]),
    async (access) => { await access.fill("email", Uint8Array.of(1, 2, 3)); },
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_effect_uncertain", retryable: false },
  });
  assert.equal(context.closeCount, 1);
});

test("timeout after a fill begins is uncertain and invalidates the session", async () => {
  const context = new FakeContext();
  const semantic = new FakeSemanticAccountPage();
  let release!: () => void;
  let markStarted!: () => void;
  semantic.fillGate = {
    started: new Promise<void>((resolve) => { markStarted = resolve; }),
    wait: new Promise<void>((resolve) => { release = resolve; }),
    markStarted: () => markStarted(),
  };
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    accountPage: semantic,
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 5,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000032") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  let fieldResult: unknown;

  const pending = provider.withOwnedAccountPageAccess(
    {
      ...accessRequest(opened.value.session.sessionId),
      operationId: generatedOperationId("operation_8200000000000032"),
    },
    AbortSignal.any([]),
    async (access) => { fieldResult = await access.fill("password", Uint8Array.of(7, 8)); },
  );
  await semantic.fillGate.started;
  const result = await pending;
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(fieldResult, {
    ok: false,
    error: { code: "browser_effect_uncertain", retryable: false },
  });
  assert.deepEqual(result, fieldResult);
  assert.equal(context.closeCount, 1);
  assert.equal(semantic.receivedBuffers.every((bytes) => bytes.every((value) => value === 0)), true);
});

test("an unsettled submit effect is uncertain and invalidates the session", async () => {
  const context = new FakeContext();
  const semantic = new FakeSemanticAccountPage();
  semantic.activateError = new Error("submit effect did not settle");
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: { async inspect() { return ownedMatched(); } },
    profiles: new MemoryProfiles(),
    accountPage: semantic,
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000034") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  let activation: unknown;

  const result = await provider.withOwnedAccountPageAccess(
    {
      ...accessRequest(opened.value.session.sessionId),
      operationId: generatedOperationId("operation_8200000000000034"),
    },
    AbortSignal.any([]),
    async (access) => { activation = await access.activate("submit_sign_in"); },
  );

  assert.deepEqual(activation, {
    ok: false,
    error: { code: "browser_effect_uncertain", retryable: false },
  });
  assert.deepEqual(result, activation);
  assert.equal(context.closeCount, 1);
});

test("ownership loss during independent field verification preserves effect uncertainty", async () => {
  const context = new FakeContext();
  let checks = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: binding(),
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        checks += 1;
        return checks < 4 ? ownedMatched() : { ownership: "foreign" as const };
      },
    },
    profiles: new MemoryProfiles(),
    accountPage: new FakeSemanticAccountPage(),
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open(
    { ...openRequest(), operationId: generatedOperationId("operation_8100000000000033") },
    AbortSignal.any([]),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const outcomes: unknown[] = [];

  const result = await provider.withOwnedAccountPageAccess(
    {
      ...accessRequest(opened.value.session.sessionId),
      operationId: generatedOperationId("operation_8200000000000033"),
    },
    AbortSignal.any([]),
    async (access) => {
      outcomes.push(await access.fill("email", Uint8Array.of(4, 5)));
      outcomes.push(await access.matches("email", Uint8Array.of(4, 5)));
    },
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_effect_uncertain", retryable: false },
  });
  assert.deepEqual(outcomes, [
    { ok: true, value: undefined },
    { ok: false, error: { code: "browser_effect_uncertain", retryable: false } },
  ]);
  assert.equal(context.closeCount, 1);
});

function openRequest() {
  return {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_8100000000000001"),
    profileLeaseId: liveFixtures.session.profileLeaseId,
    target: liveFixtures.target,
  };
}

function accessRequest(sessionId: LiveSessionId) {
  return {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_8200000000000001"),
    sessionId,
    target: liveFixtures.target,
    now: "2026-08-01T18:00:00.000Z",
  };
}

function binding() {
  return {
    forPersistentBrowser: () => ({
      targetUrl: "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
      profilePath: "C:\\outside\\runtime\\browser-profile",
      admittedAt: liveFixtures.issuedAt,
      leaseExpiresAt: liveFixtures.expiresAt,
    }),
  };
}

function ownedMatched() {
  return {
    ownership: "owned" as const,
    target: { kind: "matched" as const },
    snapshot: {
      schemaVersion: 1 as const,
      traitIds: ["structural_trait_1111111111111111"],
      controlCount: 2,
      requiredControlCount: 2,
      optionCount: 0,
    },
  };
}

function ownedAccountEntry() {
  const value = ownedMatched();
  return {
    ...value,
    snapshot: {
      ...value.snapshot,
      traitIds: [
        "structural_trait_page_account_entry_v1",
        "structural_trait_account_create_v1",
      ],
    },
  };
}

class FakePage {
  async goto(): Promise<void> {}
  isClosed(): boolean { return false; }
  async close(): Promise<void> {}
}

class FakeContext {
  readonly page = new FakePage();
  closeCount = 0;
  pages(): FakePage[] { return [this.page]; }
  async newPage(): Promise<FakePage> { return this.page; }
  async close(): Promise<void> { this.closeCount += 1; }
}

class MemoryProfiles {
  marker: unknown;
  async read(): Promise<unknown> { return this.marker; }
  async write(_path: string, marker: unknown): Promise<void> { this.marker = marker; }
  async cleanup(): Promise<void> { this.marker = undefined; }
  async cleanupPartial(): Promise<void> { this.marker = undefined; }
}

class FakeSemanticAccountPage {
  readonly values = new Map<string, Uint8Array>();
  readonly receivedBuffers: Uint8Array[] = [];
  readonly facts = new Map<string, { cardinality: number; actionable: boolean }>();
  readonly activated: string[] = [];
  fillCalls = 0;
  activateError?: Error;
  fillGate?: {
    readonly started: Promise<void>;
    readonly wait: Promise<void>;
    readonly markStarted: () => void;
  };
  async inspect(_page: unknown, control: string): Promise<{ cardinality: number; actionable: boolean }> {
    return this.facts.get(control) ?? { cardinality: 1, actionable: true };
  }
  async fill(_page: unknown, field: string, bytes: Uint8Array): Promise<void> {
    this.fillCalls += 1;
    this.receivedBuffers.push(bytes);
    this.fillGate?.markStarted();
    await this.fillGate?.wait;
    this.values.set(field, bytes.slice());
  }
  async matches(_page: unknown, field: string, bytes: Uint8Array): Promise<boolean> {
    this.receivedBuffers.push(bytes);
    const value = this.values.get(field) ?? new Uint8Array();
    return value.length === bytes.length && value.every((byte, index) => byte === bytes[index]);
  }
  async clear(_page: unknown, field: string): Promise<void> {
    this.values.set(field, new Uint8Array());
  }
  async isEmpty(_page: unknown, field: string): Promise<boolean> {
    return (this.values.get(field)?.length ?? 0) === 0;
  }
  async activate(_page: unknown, action: string): Promise<void> {
    this.activated.push(action);
    if (this.activateError !== undefined) throw this.activateError;
  }
}
