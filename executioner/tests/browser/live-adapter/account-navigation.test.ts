import assert from "node:assert/strict";
import { test } from "node:test";

import { generatedOperationId } from "../../../src/contracts/index.ts";
import { liveFixtures } from "../../../src/testing/live/index.ts";
import { PlaywrightPersistentBrowserSession } from "../../../src/browser/playwright-live/session.ts";

test("concrete session reaches an account boundary through exactly two reclassified effects", async () => {
  const harness = await openedHarness();

  const result = await harness.provider.advanceToAccountEntry(
    request(),
    new AbortController().signal,
  );

  assert.deepEqual(result, { ok: true, value: { kind: "account_boundary" } });
  assert.deepEqual(harness.adapter.actions, ["start_application", "apply_manually"]);
  assert.equal(harness.context.effects, 2);
  assert.equal(harness.probeChecks(), 6);
});

test("an already reached account, verification, or application boundary performs no effect", async () => {
  for (const traits of [
    ["structural_trait_page_account_entry_v1", "structural_trait_account_sign_in_v1"],
    ["structural_trait_page_account_entry_v1", "structural_trait_account_create_v1"],
    ["structural_trait_page_email_verification_v1"],
    ["structural_trait_page_profile_step_v1"],
  ]) {
    const harness = await openedHarness({ initialTraits: traits });
    const result = await harness.provider.advanceToAccountEntry(
      request(),
      new AbortController().signal,
    );
    assert.deepEqual(result, { ok: true, value: { kind: "account_boundary" } });
    assert.deepEqual(harness.adapter.actions, []);
  }
});

test("unknown, structural ambiguity, and access challenges stop before navigation", async () => {
  for (const [traits, expected] of [
    [[], invalid()],
    [
      ["structural_trait_page_profile_step_v1", "structural_trait_page_review_step_v1"],
      ambiguous(),
    ],
    [["structural_trait_challenge_captcha_v1"], invalid()],
    [["structural_trait_challenge_mfa_v1"], invalid()],
    [["structural_trait_challenge_access_control_v1"], invalid()],
    [
      ["structural_trait_page_account_entry_v1"],
      invalid(),
    ],
    [
      [
        "structural_trait_page_account_entry_v1",
        "structural_trait_account_sign_in_v1",
        "structural_trait_account_create_v1",
      ],
      ambiguous(),
    ],
  ] as const) {
    const harness = await openedHarness({ initialTraits: traits });
    const result = await harness.provider.advanceToAccountEntry(
      request(),
      new AbortController().signal,
    );
    assert.deepEqual(result, expected);
    assert.deepEqual(harness.adapter.actions, []);
  }
});

test("target mismatch, ambiguity, and unavailable facts are preserved exactly", async () => {
  for (const target of [
    { kind: "target_mismatch", dimension: "host" },
    { kind: "target_mismatch", dimension: "tenant" },
    { kind: "target_mismatch", dimension: "posting" },
    { kind: "target_ambiguous" },
    { kind: "posting_unavailable", reason: "not_found" },
    { kind: "posting_unavailable", reason: "closed" },
    { kind: "posting_unavailable", reason: "removed" },
    { kind: "posting_unavailable", reason: "unavailable" },
  ] as const) {
    const harness = await openedHarness({ targetAfterOpen: target });
    const result = await harness.provider.advanceToAccountEntry(
      request(),
      new AbortController().signal,
    );
    assert.deepEqual(result, { ok: true, value: target });
    assert.deepEqual(harness.adapter.actions, []);
  }
});

test("missing, duplicate, and non-actionable controls stop before an effect", async () => {
  for (const [fact, expected] of [
    [{ cardinality: 0, actionable: false }, invalid()],
    [
      { cardinality: 2, actionable: false },
      ambiguous(),
    ],
    [{ cardinality: 1, actionable: false }, invalid()],
  ] as const) {
    const harness = await openedHarness({ fact });
    const result = await harness.provider.advanceToAccountEntry(
      request(),
      new AbortController().signal,
    );
    assert.deepEqual(result, expected);
    assert.equal(harness.adapter.activations, 0);
    assert.equal(harness.context.closeCount, 0);
  }
});

test("redirect mismatch and popup ambiguity preserve exact facts then release ownership", async () => {
  const mismatch = await openedHarness({
    targetAfterEffect: {
      kind: "target_mismatch",
      dimension: "posting",
    },
  });
  assert.deepEqual(
    await mismatch.provider.advanceToAccountEntry(
      request(),
      new AbortController().signal,
    ),
    {
      ok: true,
      value: { kind: "target_mismatch", dimension: "posting" },
    },
  );
  assert.equal(mismatch.context.closeCount, 1);
  assert.equal(mismatch.profiles.cleanupCount, 1);

  const popup = await openedHarness({ popupAfterEffect: true });
  assert.deepEqual(
    await popup.provider.advanceToAccountEntry(
      request(),
      new AbortController().signal,
    ),
    { ok: true, value: { kind: "target_ambiguous" } },
  );
  assert.equal(popup.context.closeCount, 1);
  assert.equal(popup.profiles.cleanupCount, 1);
});

test("the transition ceiling prevents a third effect", async () => {
  const harness = await openedHarness({ remainApplyChoice: true });
  const result = await harness.provider.advanceToAccountEntry(
    request(),
    new AbortController().signal,
  );
  assert.deepEqual(result, invalid());
  assert.deepEqual(harness.adapter.actions, ["start_application", "apply_manually"]);
  assert.equal(harness.context.effects, 2);
});

test("admission and replay bind exact journey, session, target, operation, and time", async () => {
  const harness = await openedHarness({ initialTraits: [
    "structural_trait_page_account_entry_v1",
    "structural_trait_account_sign_in_v1",
  ] });
  const exact = request();
  const first = await harness.provider.advanceToAccountEntry(
    exact,
    new AbortController().signal,
  );
  assert.deepEqual(
    await harness.provider.advanceToAccountEntry(exact, new AbortController().signal),
    first,
  );
  for (const changed of [
    { ...exact, journeyId: "journey_other_00000001" as never },
    { ...exact, sessionId: "live_session_other_0001" as never },
    { ...exact, target: liveFixtures.otherTarget },
    { ...exact, now: "2026-08-03T00:00:00.000Z" },
  ]) {
    assert.deepEqual(
      await harness.provider.advanceToAccountEntry(
        changed,
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "browser_operation_replayed", retryable: false },
      },
    );
  }
});

function request() {
  return {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId("operation_8888888888888888"),
    sessionId: liveFixtures.session.sessionId,
    target: liveFixtures.target,
    now: "2026-08-01T20:00:00.000Z",
  };
}

async function openedHarness(options: {
  readonly initialTraits?: readonly string[];
  readonly fact?: { readonly cardinality: number; readonly actionable: boolean };
  readonly targetAfterOpen?: TargetFact;
  readonly targetAfterEffect?: TargetFact;
  readonly popupAfterEffect?: boolean;
  readonly remainApplyChoice?: boolean;
} = {}) {
  const context = new FakeContext();
  const profiles = new MemoryProfiles();
  const adapter = new NavigationAdapter(
    options.fact ?? { cardinality: 1, actionable: true },
    (action) => {
      context.effects += 1;
      if (options.popupAfterEffect) context.ownedPages.push(new FakePage());
      if (action === "start_application") context.phase = "apply_choice";
      else context.phase = options.remainApplyChoice ? "apply_choice" : "account";
    },
  );
  let checks = 0;
  const provider = new PlaywrightPersistentBrowserSession({
    binding: {
      forPersistentBrowser: () => ({
        targetUrl: "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
        profilePath: "C:\\outside\\runtime\\browser-profile",
        admittedAt: liveFixtures.issuedAt,
        leaseExpiresAt: liveFixtures.expiresAt,
      }),
    },
    launcher: { async launchPersistentContext() { return context; } },
    probe: {
      async inspect() {
        checks += 1;
        if (checks > 1 && options.targetAfterOpen !== undefined) {
          return targetObservation(options.targetAfterOpen);
        }
        if (context.effects > 0 && options.targetAfterEffect !== undefined) {
          return targetObservation(options.targetAfterEffect);
        }
        return matched(options.initialTraits ?? phaseTraits(context.phase));
      },
    },
    profiles,
    postingNavigation: adapter,
    ids: () => liveFixtures.session.sessionId,
    timeoutMs: 100,
  });
  const opened = await provider.open({
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: liveFixtures.operationIds.browserOpen,
    profileLeaseId: liveFixtures.session.profileLeaseId,
    target: liveFixtures.target,
  }, new AbortController().signal);
  assert.equal(opened.ok, true);
  return { provider, context, profiles, adapter, probeChecks: () => checks };
}

function phaseTraits(phase: FakeContext["phase"]): readonly string[] {
  if (phase === "posting") return ["structural_trait_page_job_posting_v1"];
  if (phase === "apply_choice") return ["structural_trait_navigation_apply_choice_v1"];
  return [
    "structural_trait_page_account_entry_v1",
    "structural_trait_account_create_v1",
  ];
}

function matched(traits: readonly string[]) {
  return {
    ownership: "owned" as const,
    target: { kind: "matched" as const },
    snapshot: {
      schemaVersion: 1 as const,
      traitIds: ["structural_trait_ats_workday_family_v1", ...traits],
      controlCount: 0,
      requiredControlCount: 0,
      optionCount: 0,
    },
  };
}

type TargetFact =
  | { readonly kind: "target_mismatch"; readonly dimension: "host" | "tenant" | "posting" }
  | { readonly kind: "target_ambiguous" }
  | { readonly kind: "posting_unavailable"; readonly reason: "not_found" | "closed" | "removed" | "unavailable" };

function targetObservation(target: TargetFact) {
  return { ownership: "owned" as const, target, snapshot: matched([]).snapshot };
}

class NavigationAdapter {
  activations = 0;
  readonly actions: string[] = [];
  readonly #fact: { readonly cardinality: number; readonly actionable: boolean };
  readonly #activate: (action: string) => void;
  constructor(
    fact: { readonly cardinality: number; readonly actionable: boolean },
    activate: (action: string) => void,
  ) {
    this.#fact = fact;
    this.#activate = activate;
  }
  async inspect() { return this.#fact; }
  async activate(_page: FakePage, action: string) {
    this.activations += 1;
    this.actions.push(action);
    this.#activate(action);
  }
}

class FakePage {
  async goto(): Promise<void> {}
  isClosed(): boolean { return false; }
  async close(): Promise<void> {}
}

class FakeContext {
  closeCount = 0;
  effects = 0;
  phase: "posting" | "apply_choice" | "account" = "posting";
  readonly ownedPages = [new FakePage()];
  pages(): FakePage[] { return this.ownedPages; }
  async newPage(): Promise<FakePage> { return this.ownedPages[0]!; }
  async close(): Promise<void> { this.closeCount += 1; }
}

class MemoryProfiles {
  marker: unknown;
  cleanupCount = 0;
  async read(): Promise<unknown> { return this.marker; }
  async write(_path: string, marker: unknown): Promise<void> { this.marker = marker; }
  async cleanup(): Promise<void> { this.cleanupCount += 1; this.marker = undefined; }
  async cleanupPartial(): Promise<void> { this.marker = undefined; }
}

function invalid() {
  return {
    ok: false as const,
    error: { code: "browser_target_invalid" as const, retryable: false as const },
  };
}

function ambiguous() {
  return {
    ok: false as const,
    error: { code: "browser_target_ambiguous" as const, retryable: false as const },
  };
}
