import assert from "node:assert/strict";
import { test } from "node:test";

import { generatedOperationId } from "../../../src/contracts/index.ts";
import type { LiveSessionId } from "../../../src/contracts/live/index.ts";
import { liveFixtures } from "../../../src/testing/live/index.ts";
import { PlaywrightPersistentBrowserSession } from "../../../src/browser/playwright-live/index.ts";
import { PlaywrightVerificationNavigationAdapter } from "../../../src/browser/playwright-live/private/playwright-verification-navigation.ts";
import type {
  OwnedTargetObservation,
  PersistentPage,
} from "../../../src/browser/playwright-live/private/types.ts";
import type { SemanticVerificationNavigationAdapter } from "../../../src/browser/playwright-live/private/verification-navigation-types.ts";
import type { Stage2ExternalMonitorRuntime } from
  "../../../src/live/evidence/external-monitor-runtime.ts";

test("external monitor ACK blocks verification navigation and binds its actual destination", async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const records: Parameters<Stage2ExternalMonitorRuntime["auth"]>[] = [];
  const monitor = {
    async auth(...args: Parameters<Stage2ExternalMonitorRuntime["auth"]>) {
      records.push(args);
      if (args[2] === "before_navigation") {
        entered?.();
        await new Promise<void>((resolve) => { release = resolve; });
      }
    },
    async application(..._args: Parameters<Stage2ExternalMonitorRuntime["application"]>) {},
  };
  const harness = await openedHarness({
    externalMonitor: monitor,
    observation: (check) => ownedMatched(check <= 3
      ? ["structural_trait_page_account_entry_v1", "structural_trait_account_create_v1"]
      : ["structural_trait_page_candidate_home_v1"]),
  });
  const request = accessRequest(harness.sessionId);
  const pending = harness.provider.withOwnedVerificationNavigationAccess(
    request,
    AbortSignal.any([]),
    async (access) => {
      assert.deepEqual(
        await access.navigateVerificationTarget(validValues(), AbortSignal.any([])),
        { ok: true, value: { kind: "navigated" } },
      );
    },
  );
  await waiting;
  assert.equal(harness.page.gotoCount, harness.gotoCountAfterOpen);
  release?.();
  assert.deepEqual(await pending, { ok: true, value: { kind: "navigated" } });
  assert.equal(harness.page.gotoCount, harness.gotoCountAfterOpen + 1);
  assert.deepEqual(records.map((args) => [args[1], args[2], args[4]]), [
    ["account_entry", "before_navigation", { operationId: request.operationId, attempt: 1 }],
    ["application_ready", "transition", { operationId: request.operationId, attempt: 1 }],
  ]);
  assert.notEqual(records[0]?.[0], harness.page);
  assert.notEqual(records[1]?.[0], harness.page);
  assert.equal(typeof (records[0]?.[0] as { screenshot?: unknown })?.screenshot, "function");
  assert.equal(typeof (records[1]?.[0] as { screenshot?: unknown })?.screenshot, "function");
});

test("owned verification navigation admits one byte-only Workday target", async () => {
  const harness = await openedHarness();
  let operation: unknown;

  const result = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async (access) => {
      operation = await access.navigateVerificationTarget({
        verificationTarget: encoded(
          "https://approved.wd5.myworkdayjobs.invalid/verify?token=private",
        ),
        approvedHost: encoded("approved.wd5.myworkdayjobs.invalid"),
        approvedTenant: encoded("approved"),
      }, AbortSignal.any([]));
    },
  );

  assert.deepEqual(result, { ok: true, value: { kind: "navigated" } });
  assert.deepEqual(operation, { ok: true, value: { kind: "navigated" } });
  assert.equal(harness.page.gotoCount, harness.gotoCountAfterOpen + 1);
});

test("three-digit Workday shards stay bound through verification navigation", async () => {
  const harness = await openedHarness({
    targetUrl:
      "https://approved.wd108.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
  });
  let operation: unknown;

  const result = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async (access) => {
      operation = await access.navigateVerificationTarget({
        verificationTarget: encoded(
          "https://approved.wd108.myworkdayjobs.invalid/verify?token=private",
        ),
        approvedHost: encoded("approved.wd108.myworkdayjobs.invalid"),
        approvedTenant: encoded("approved"),
      }, AbortSignal.any([]));
    },
  );

  assert.deepEqual(result, { ok: true, value: { kind: "navigated" } });
  assert.deepEqual(operation, { ok: true, value: { kind: "navigated" } });
});

test("a mailbox-admitted Workday target stays navigable up to the whole-link bound", async () => {
  const harness = await openedHarness();
  let operation: unknown;
  const workdayToken = "x".repeat(3_000);

  const result = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async (access) => {
      operation = await access.navigateVerificationTarget({
        verificationTarget: encoded(
          `https://approved.wd5.myworkdayjobs.invalid/account?resetPassword=${workdayToken}`,
        ),
        approvedHost: encoded("approved.wd5.myworkdayjobs.invalid"),
        approvedTenant: encoded("approved"),
      }, AbortSignal.any([]));
    },
  );

  assert.deepEqual(operation, { ok: true, value: { kind: "navigated" } });
  assert.deepEqual(result, operation);
  assert.equal(harness.page.gotoCount, harness.gotoCountAfterOpen + 1);
});

test("verification navigation rejects a target beyond the whole-link bound", async () => {
  const harness = await openedHarness();
  let operation: unknown;
  const oversized = "x".repeat(4_097);

  const result = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async (access) => {
      operation = await access.navigateVerificationTarget({
        verificationTarget: encoded(
          `https://approved.wd5.myworkdayjobs.invalid/verify?token=${oversized}`,
        ),
        approvedHost: encoded("approved.wd5.myworkdayjobs.invalid"),
        approvedTenant: encoded("approved"),
      }, AbortSignal.any([]));
    },
  );

  assert.deepEqual(operation, invalidTarget());
  assert.deepEqual(result, invalidTarget());
  assert.equal(harness.page.gotoCount, harness.gotoCountAfterOpen);
});

test("a challenged destination is effect-uncertain, not verified navigation", async () => {
  const harness = await openedHarness({ traits: [
    "structural_trait_page_candidate_home_v1",
    "structural_trait_challenge_access_control_v1",
  ] });
  let operation: unknown;

  const result = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async (access) => {
      operation = await access.navigateVerificationTarget(validValues(), AbortSignal.any([]));
    },
  );

  assert.deepEqual(operation, uncertain());
  assert.deepEqual(result, uncertain());
  assert.equal(harness.context.closeCount, 1);
});

test("post-navigation observation admits only exact verified lifecycle states", async () => {
  const admitted = [
    ["structural_trait_page_candidate_home_v1"],
    ["structural_trait_page_profile_step_v1"],
    ["structural_trait_page_questionnaire_v1"],
    ["structural_trait_page_review_step_v1"],
    ["structural_trait_page_account_entry_v1", "structural_trait_account_sign_in_v1"],
    ["structural_trait_page_account_entry_v1", "structural_trait_account_create_v1"],
  ] as const;
  for (const traits of admitted) {
    const harness = await openedHarness({ traits });
    let operation: unknown;
    const result = await harness.provider.withOwnedVerificationNavigationAccess(
      accessRequest(harness.sessionId),
      AbortSignal.any([]),
      async (access) => {
        operation = await access.navigateVerificationTarget(validValues(), AbortSignal.any([]));
      },
    );
    assert.deepEqual(operation, { ok: true, value: { kind: "navigated" } });
    assert.deepEqual(result, operation);
  }

  const rejected = [
    ["structural_trait_page_email_verification_v1"],
    ["structural_trait_page_job_posting_v1"],
    ["structural_trait_page_candidate_home_v1", "structural_trait_page_review_step_v1"],
  ] as const;
  for (const traits of rejected) {
    const harness = await openedHarness({ traits });
    const result = await harness.provider.withOwnedVerificationNavigationAccess(
      accessRequest(harness.sessionId),
      AbortSignal.any([]),
      async (access) => {
        await access.navigateVerificationTarget(validValues(), AbortSignal.any([]));
      },
    );
    assert.deepEqual(result, uncertain());
    assert.equal(harness.context.closeCount, 1);
  }
});

test("an owned unavailable destination remains an exact factual result", async () => {
  const harness = await openedHarness({
    observation: (check) => check < 4
      ? ownedMatched(["structural_trait_page_candidate_home_v1"])
      : ownedUnavailable(),
  });
  let operation: unknown;

  const result = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async (access) => {
      operation = await access.navigateVerificationTarget(validValues(), AbortSignal.any([]));
    },
  );

  const unavailable = { ok: true, value: { kind: "target_unavailable" } };
  assert.deepEqual(operation, unavailable);
  assert.deepEqual(result, unavailable);
  assert.equal(harness.context.closeCount, 0);
  assert.equal(harness.ownershipChecks(), 4);
});

test("route ownership rejects unsafe or mismatched values before navigation", async () => {
  const cases = [
    { verificationTarget: encoded("http://approved.wd5.myworkdayjobs.invalid/verify?token=x") },
    { verificationTarget: encoded("https://other.wd5.myworkdayjobs.invalid/verify?token=x") },
    { verificationTarget: encoded("https://user@approved.wd5.myworkdayjobs.invalid/verify?token=x") },
    { verificationTarget: encoded("https://approved.wd5.myworkdayjobs.invalid:444/verify?token=x") },
    { verificationTarget: encoded("https://approved.wd5.myworkdayjobs.invalid/verify?token=x#fragment") },
    { verificationTarget: encoded("https://approved.wd5.myworkdayjobs.invalid/verify") },
    { approvedHost: encoded("other.wd5.myworkdayjobs.invalid") },
    { approvedTenant: encoded("other") },
    { verificationTarget: Uint8Array.of(0xff, 0xfe) },
  ] as const;
  for (const current of cases) {
    const harness = await openedHarness();
    let operation: unknown;
    const result = await harness.provider.withOwnedVerificationNavigationAccess(
      accessRequest(harness.sessionId),
      AbortSignal.any([]),
      async (access) => {
        operation = await access.navigateVerificationTarget({
          ...validValues(),
          ...current,
        }, AbortSignal.any([]));
      },
    );
    assert.deepEqual(operation, invalidTarget());
    assert.deepEqual(result, invalidTarget());
    assert.equal(harness.page.gotoCount, harness.gotoCountAfterOpen);
  }
});

test("pre-effect cancellation is exact and leaves the owned session intact", async () => {
  const harness = await openedHarness();
  const controller = new AbortController();
  controller.abort();
  let operation: unknown;
  const result = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async (access) => {
      operation = await access.navigateVerificationTarget(validValues(), controller.signal);
    },
  );
  assert.deepEqual(operation, cancelled());
  assert.deepEqual(result, cancelled());
  assert.equal(harness.page.gotoCount, harness.gotoCountAfterOpen);
  assert.equal(harness.context.closeCount, 0);
});

test("pre-effect pin timeout is retryable and does not invalidate ownership", async () => {
  const never = new Promise<OwnedTargetObservation>(() => undefined);
  const harness = await openedHarness({
    timeoutMs: 5,
    observation: (check) => check === 2
      ? never
      : ownedMatched(["structural_trait_page_candidate_home_v1"]),
  });
  let called = false;
  const result = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async () => { called = true; },
  );
  assert.deepEqual(result, timeout());
  assert.equal(called, false);
  assert.equal(harness.context.closeCount, 0);
});

test("post-effect ownership loss is uncertain and invalidates the session", async () => {
  const harness = await openedHarness({
    observation: (check) => check < 4
      ? ownedMatched(["structural_trait_page_candidate_home_v1"])
      : { ownership: "foreign" },
  });
  const result = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async (access) => {
      await access.navigateVerificationTarget(validValues(), AbortSignal.any([]));
    },
  );
  assert.deepEqual(result, uncertain());
  assert.equal(harness.context.closeCount, 1);
});

test("cancel or timeout after navigation begins is effect-uncertain", async () => {
  for (const mode of ["cancel", "timeout"] as const) {
    const harness = await openedHarness({ timeoutMs: mode === "timeout" ? 5 : 100 });
    harness.page.gate();
    const controller = new AbortController();
    let operation: unknown;
    const pending = harness.provider.withOwnedVerificationNavigationAccess(
      accessRequest(harness.sessionId),
      AbortSignal.any([]),
      async (access) => {
        operation = await access.navigateVerificationTarget(validValues(), controller.signal);
      },
    );
    await harness.page.started;
    if (mode === "cancel") controller.abort();
    const result = await pending;
    harness.page.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(operation, uncertain());
    assert.deepEqual(result, uncertain());
    assert.equal(harness.context.closeCount, 1);
  }
});

test("the byte capability is one-shot, non-concurrent, and callback-scoped", async () => {
  const harness = await openedHarness();
  harness.page.gate();
  let retained: { navigateVerificationTarget: Function } | undefined;
  let secondOperation: unknown;
  const first = harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async (access) => {
      retained = access;
      const pending = access.navigateVerificationTarget(validValues(), AbortSignal.any([]));
      await harness.page.started;
      secondOperation = await access.navigateVerificationTarget(validValues(), AbortSignal.any([]));
      harness.page.release();
      await pending;
    },
  );
  await harness.page.started;
  const concurrent = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async () => undefined,
  );
  const firstResult = await first;
  assert.deepEqual(firstResult, { ok: true, value: { kind: "navigated" } });
  assert.deepEqual(secondOperation, replayed());
  assert.deepEqual(concurrent, replayed());
  const afterReturn = await retained!.navigateVerificationTarget(
    validValues(), AbortSignal.any([]),
  );
  assert.deepEqual(afterReturn, invalidated());
});

test("the browser clears its transient target copy without mutating caller-owned bytes", async () => {
  const navigation = new RecordingNavigation();
  const harness = await openedHarness({ navigation });
  const values = validValues();
  const original = [...values.verificationTarget];
  let operation: unknown;

  const result = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async (access) => {
      operation = await access.navigateVerificationTarget(values, AbortSignal.any([]));
    },
  );

  assert.deepEqual(operation, { ok: true, value: { kind: "navigated" } });
  assert.deepEqual(result, operation);
  assert.deepEqual([...values.verificationTarget], original);
  assert.equal(navigation.received.length, 1);
  assert.equal(navigation.received[0]!.every((byte) => byte === 0), true);
});

test("a synchronous adapter failure still clears transient bytes and invalidates ownership", async () => {
  const navigation = new ThrowingNavigation();
  const harness = await openedHarness({ navigation });

  const result = await harness.provider.withOwnedVerificationNavigationAccess(
    accessRequest(harness.sessionId),
    AbortSignal.any([]),
    async (access) => {
      await access.navigateVerificationTarget(validValues(), AbortSignal.any([]));
    },
  );

  assert.deepEqual(result, uncertain());
  assert.equal(navigation.received.length, 1);
  assert.equal(navigation.received[0]!.every((byte) => byte === 0), true);
  assert.equal(harness.context.closeCount, 1);
});

function accessRequest(sessionId: LiveSessionId) {
  return {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_verification_nav_01"),
    sessionId,
    target: liveFixtures.target,
    now: "2026-08-01T18:00:00.000Z",
  };
}

interface HarnessOptions {
  readonly targetUrl?: string;
  readonly traits?: readonly string[];
  readonly observation?: (
    check: number,
  ) => OwnedTargetObservation | Promise<OwnedTargetObservation>;
  readonly timeoutMs?: number;
  readonly navigation?: SemanticVerificationNavigationAdapter;
  readonly externalMonitor?: Pick<Stage2ExternalMonitorRuntime, "auth" | "application">;
}

async function openedHarness(options: HarnessOptions = {}) {
  const page = new FakePage();
  const context = new FakeContext(page);
  let checks = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: {
      forPersistentBrowser: () => ({
        targetUrl: options.targetUrl ??
          "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
        profilePath: "C:\\outside\\runtime\\browser-profile",
        admittedAt: liveFixtures.issuedAt,
        leaseExpiresAt: liveFixtures.expiresAt,
      }),
    },
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        checks += 1;
        return await (options.observation?.(checks) ?? ownedMatched(
          options.traits ?? ["structural_trait_page_candidate_home_v1"],
        ));
      },
    },
    profiles: new MemoryProfiles(),
    verificationNavigation: options.navigation ?? new PlaywrightVerificationNavigationAdapter(),
    externalMonitor: options.externalMonitor,
    ids: () => liveFixtures.session.sessionId as LiveSessionId,
    timeoutMs: options.timeoutMs ?? 100,
  });
  const opened = await provider.open({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: liveFixtures.operationIds.browserOpen,
    profileLeaseId: liveFixtures.session.profileLeaseId,
    target: liveFixtures.target,
  }, AbortSignal.any([]));
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new TypeError("synthetic open failed");
  return {
    provider,
    page,
    context,
    sessionId: opened.value.session.sessionId,
    gotoCountAfterOpen: page.gotoCount,
    ownershipChecks: () => checks,
  };
}

function ownedMatched(traitIds: readonly string[]) {
  return {
    ownership: "owned" as const,
    target: { kind: "matched" as const },
    snapshot: {
      schemaVersion: 1 as const,
      traitIds,
      controlCount: 1,
      requiredControlCount: 0,
      optionCount: 0,
    },
  };
}

function ownedUnavailable(): OwnedTargetObservation {
  return {
    ownership: "owned",
    target: { kind: "posting_unavailable", reason: "unavailable" },
    snapshot: {
      schemaVersion: 1,
      traitIds: ["structural_trait_page_candidate_home_v1"],
      controlCount: 1,
      requiredControlCount: 0,
      optionCount: 0,
    },
  };
}

class FakePage {
  gotoCount = 0;
  started: Promise<void> = Promise.resolve();
  #markStarted: () => void = () => undefined;
  #wait: Promise<void> | undefined;
  #release: () => void = () => undefined;
  gate(): void {
    this.started = new Promise<void>((resolve) => { this.#markStarted = resolve; });
    this.#wait = new Promise<void>((resolve) => { this.#release = resolve; });
  }
  release(): void { this.#release(); }
  async goto(): Promise<void> {
    this.gotoCount += 1;
    this.#markStarted();
    await this.#wait;
  }
  isClosed(): boolean { return false; }
  async close(): Promise<void> {}
}

class FakeContext {
  readonly page: FakePage;
  closeCount = 0;
  constructor(page: FakePage) { this.page = page; }
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

class RecordingNavigation implements SemanticVerificationNavigationAdapter {
  readonly received: Uint8Array[] = [];
  async navigate(_page: PersistentPage, bytes: Uint8Array): Promise<void> {
    this.received.push(bytes);
  }
}

class ThrowingNavigation implements SemanticVerificationNavigationAdapter {
  readonly received: Uint8Array[] = [];
  navigate(_page: PersistentPage, bytes: Uint8Array): Promise<void> {
    this.received.push(bytes);
    throw new TypeError("synthetic adapter failure");
  }
}

function encoded(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function validValues() {
  return {
    verificationTarget: encoded(
      "https://approved.wd5.myworkdayjobs.invalid/verify?token=private",
    ),
    approvedHost: encoded("approved.wd5.myworkdayjobs.invalid"),
    approvedTenant: encoded("approved"),
  };
}

const invalidTarget = () => ({
  ok: false,
  error: { code: "browser_target_invalid", retryable: false },
});
const uncertain = () => ({
  ok: false,
  error: { code: "browser_effect_uncertain", retryable: false },
});
const cancelled = () => ({
  ok: false,
  error: { code: "operation_cancelled", retryable: false },
});
const replayed = () => ({
  ok: false,
  error: { code: "browser_operation_replayed", retryable: false },
});
const invalidated = () => ({
  ok: false,
  error: { code: "browser_session_invalidated", retryable: false },
});
const timeout = () => ({
  ok: false,
  error: { code: "browser_timeout", retryable: true },
});
