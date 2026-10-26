import assert from "node:assert/strict";
import { test } from "node:test";

import { generatedOperationId } from "../../../src/contracts/index.ts";
import { liveFixtures } from "../../../src/testing/live/index.ts";
import { PlaywrightPersistentBrowserSession } from "../../../src/browser/playwright-live/session.ts";

test("posting and apply-choice dispatch one reclassified effect per operation", async () => {
  const harness = await openedHarness();

  const posting = await harness.provider.advanceToAccountEntry(
    request(),
    new AbortController().signal,
  );
  assert.deepEqual(posting, {
    ok: true,
    value: { kind: "state_transitioned", state: "apply_choice" },
  });
  assert.deepEqual(harness.adapter.actions, ["start_application"]);
  assert.equal(harness.context.effects, 1);

  const applyChoice = await harness.provider.advanceToAccountEntry(
    request("9999999999999999"),
    new AbortController().signal,
  );
  assert.deepEqual(applyChoice, { ok: true, value: { kind: "account_boundary" } });
  assert.deepEqual(harness.adapter.actions, ["start_application", "apply_manually"]);
  assert.equal(harness.context.effects, 2);
});

test("two state transitions receive two independent monitor operation bindings", async () => {
  const monitor: { readonly moment: string; readonly operationId: string }[] = [];
  const harness = await openedHarness({
    externalMonitor: {
      async auth(_page, _pageName, moment, _taxonomy, event) {
        monitor.push({ moment, operationId: event.operationId });
      },
      async application() {},
    },
  });

  assert.equal((await harness.provider.advanceToAccountEntry(
    request(),
    new AbortController().signal,
  )).ok, true);
  assert.equal((await harness.provider.advanceToAccountEntry(
    request("9999999999999999"),
    new AbortController().signal,
  )).ok, true);

  assert.deepEqual(monitor.map(({ moment }) => moment), [
    "before_navigation",
    "transition",
    "before_navigation",
    "transition",
  ]);
  assert.equal(monitor[0]!.operationId, monitor[1]!.operationId);
  assert.equal(monitor[2]!.operationId, monitor[3]!.operationId);
  assert.notEqual(monitor[0]!.operationId, monitor[2]!.operationId);
});

test("a classified posting clicks Apply even when the header exposes Sign In", async () => {
  const harness = await openedHarness({
    initialTraits: [
      "structural_trait_page_job_posting_v1",
      "structural_trait_account_sign_in_v1",
    ],
  });

  const result = await harness.provider.advanceToAccountEntry(
    request(),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "state_transitioned", state: "apply_choice" },
  });
  assert.deepEqual(harness.adapter.actions, ["start_application"]);
  assert.equal(harness.context.effects, 1);
});

test("a classified posting ignores semantic header Sign In and follows the application route", async () => {
  const harness = await openedHarness({
    semanticAccountSignInFact: { cardinality: 1, actionable: true },
  });

  const result = await harness.provider.advanceToAccountEntry(
    request(),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "state_transitioned", state: "apply_choice" },
  });
  assert.deepEqual(harness.adapter.actions, ["start_application"]);
  assert.equal(harness.context.effects, 1);
});

test("an email-provider choice independently reaches the account boundary through one effect", async () => {
  const harness = await openedHarness({ initialTraits: [
    "structural_trait_page_account_entry_v1",
    "structural_trait_navigation_email_sign_in_choice_v1",
  ] });

  const result = await harness.provider.advanceToAccountEntry(
    request(),
    new AbortController().signal,
  );

  assert.deepEqual(result, { ok: true, value: { kind: "account_boundary" } });
  assert.deepEqual(harness.adapter.actions, ["sign_in_with_email"]);
  assert.equal(harness.context.effects, 1);
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

test("an activation error reconciles an exact application boundary without repeating the effect", async () => {
  const harness = await openedHarness({
    applicationAfterApply: true,
    activationFailureAfterEffect: "apply_manually",
  });

  assert.deepEqual(await harness.provider.advanceToAccountEntry(
    request(),
    new AbortController().signal,
  ), { ok: true, value: { kind: "state_transitioned", state: "apply_choice" } });
  const result = await harness.provider.advanceToAccountEntry(
    request("9999999999999999"),
    new AbortController().signal,
  );

  assert.deepEqual(result, { ok: true, value: { kind: "account_boundary" } });
  assert.deepEqual(harness.adapter.actions, ["start_application", "apply_manually"]);
  assert.equal(harness.context.effects, 2);
  assert.equal(harness.context.closeCount, 0);
});

test("unknown, structural ambiguity, and access challenges stop before navigation", async () => {
  for (const [traits, expected] of [
    [[], invalid()],
    [
      ["structural_trait_page_profile_step_v1", "structural_trait_page_review_step_v1"],
      ambiguous(),
    ],
    [
      [
        "structural_trait_page_job_posting_v1",
        "structural_trait_navigation_apply_choice_v1",
        "structural_trait_page_profile_step_v1",
      ],
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

test("a missing transition control reclassifies a late unavailable page before failing", async () => {
  const harness = await openedHarness({
    fact: { cardinality: 0, actionable: false },
    targetAfterControlInspect: {
      kind: "posting_unavailable",
      reason: "not_found",
    },
  });

  const result = await harness.provider.advanceToAccountEntry(
    request(),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "posting_unavailable", reason: "not_found" },
  });
  assert.equal(harness.adapter.activations, 0);
  assert.equal(harness.context.closeCount, 1);
  assert.equal(harness.profiles.cleanupCount, 1);
});

test("a missing control never turns a backward page reclassification into an effect", async () => {
  const harness = await openedHarness({
    initialTraits: [
      "structural_trait_page_job_posting_v1",
      "structural_trait_navigation_apply_choice_v1",
    ],
    fact: { cardinality: 0, actionable: false },
    factAfterFirstInspect: { cardinality: 1, actionable: true },
    traitsAfterControlInspect: ["structural_trait_page_job_posting_v1"],
  });

  assert.deepEqual(await harness.provider.advanceToAccountEntry(
    request(),
    new AbortController().signal,
  ), invalid());
  assert.equal(harness.adapter.activations, 0);
  assert.equal(harness.context.effects, 0);
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

test("post-activation reconciliation failure emits its exact value-free primitive", async () => {
  const trace: string[] = [];
  const harness = await openedHarness({
    probeFailureAfterEffect: true,
    accountNavigationTrace: (event) => trace.push(event),
  });

  assert.deepEqual(
    await harness.provider.advanceToAccountEntry(
      request(),
      new AbortController().signal,
    ),
    { ok: false, error: { code: "browser_effect_uncertain", retryable: false } },
  );
  assert.deepEqual(trace, [
    "posting_navigation_state_observed_job_posting",
    "posting_navigation_reconcile_failed_browser_target_stale",
  ]);
});

test("a repeated apply-choice cycle stops before repeating the same effect", async () => {
  const harness = await openedHarness({ remainApplyChoice: true });
  assert.deepEqual(await harness.provider.advanceToAccountEntry(
    request(),
    new AbortController().signal,
  ), { ok: true, value: { kind: "state_transitioned", state: "apply_choice" } });
  const result = await harness.provider.advanceToAccountEntry(
    request("9999999999999999"),
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

function request(operationSuffix = "8888888888888888") {
  return {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: generatedOperationId(`operation_${operationSuffix}`),
    sessionId: liveFixtures.session.sessionId,
    target: liveFixtures.target,
    now: "2026-08-01T20:00:00.000Z",
  };
}

async function openedHarness(options: {
  readonly initialTraits?: readonly string[];
  readonly fact?: { readonly cardinality: number; readonly actionable: boolean };
  readonly semanticAccountSignInFact?: { readonly cardinality: number; readonly actionable: boolean };
  readonly factAfterFirstInspect?: { readonly cardinality: number; readonly actionable: boolean };
  readonly targetAfterOpen?: TargetFact;
  readonly targetAfterEffect?: TargetFact;
  readonly targetAfterControlInspect?: TargetFact;
  readonly traitsAfterControlInspect?: readonly string[];
  readonly popupAfterEffect?: boolean;
  readonly remainApplyChoice?: boolean;
  readonly emailSignInChoice?: boolean;
  readonly applicationAfterApply?: boolean;
  readonly activationFailureAfterEffect?: "start_application" | "apply_manually" | "sign_in_with_email";
  readonly probeFailureAfterEffect?: boolean;
  readonly accountNavigationTrace?: (event: string) => void;
  readonly externalMonitor?: import("../../../src/browser/playwright-live/private/external-monitor-port.ts").ExternalMonitorPort;
} = {}) {
  const context = new FakeContext();
  const profiles = new MemoryProfiles();
  let controlInspected = false;
  const adapter = new NavigationAdapter(
    [
      options.fact ?? { cardinality: 1, actionable: true },
      ...(options.factAfterFirstInspect === undefined
        ? []
        : [options.factAfterFirstInspect]),
    ],
    options.semanticAccountSignInFact,
    options.initialTraits?.includes("structural_trait_account_sign_in_v1") ?? false,
    () => { controlInspected = true; },
    (action) => {
      context.effects += 1;
      if (options.popupAfterEffect) context.ownedPages.push(new FakePage());
      if (action === "start_application") context.phase = "apply_choice";
      else if (action === "apply_manually") {
        context.phase = options.remainApplyChoice
          ? "apply_choice"
          : options.emailSignInChoice
            ? "email_sign_in_choice"
            : options.applicationAfterApply ? "application" : "account";
      } else context.phase = "account";
      if (options.activationFailureAfterEffect === action) {
        throw new Error("activation result unavailable");
      }
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
        if (context.effects > 0 && options.probeFailureAfterEffect) {
          throw new Error("value-free probe failure");
        }
        if (controlInspected && options.targetAfterControlInspect !== undefined) {
          return targetObservation(options.targetAfterControlInspect);
        }
        if (controlInspected && options.traitsAfterControlInspect !== undefined) {
          return matched(options.traitsAfterControlInspect);
        }
        if (checks > 1 && options.targetAfterOpen !== undefined) {
          return targetObservation(options.targetAfterOpen);
        }
        if (context.effects > 0 && options.targetAfterEffect !== undefined) {
          return targetObservation(options.targetAfterEffect);
        }
        return matched(
          context.effects === 0 && options.initialTraits !== undefined
            ? options.initialTraits
            : phaseTraits(context.phase),
        );
      },
    },
    profiles,
    postingNavigation: adapter,
    externalMonitor: options.externalMonitor,
    accountNavigationTrace: options.accountNavigationTrace,
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
  if (phase === "apply_choice") {
    return [
      "structural_trait_page_job_posting_v1",
      "structural_trait_navigation_apply_choice_v1",
    ];
  }
  if (phase === "email_sign_in_choice") {
    return [
      "structural_trait_page_account_entry_v1",
      "structural_trait_navigation_email_sign_in_choice_v1",
    ];
  }
  if (phase === "application") return ["structural_trait_page_profile_step_v1"];
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
  | { readonly kind: "posting_unavailable"; readonly reason: "not_found" | "closed" | "removed" | "unavailable" | "maintenance" | "runtime_error" };

function targetObservation(target: TargetFact) {
  return { ownership: "owned" as const, target, snapshot: matched([]).snapshot };
}

class NavigationAdapter {
  activations = 0;
  readonly actions: string[] = [];
  #inspections = 0;
  readonly #facts: readonly {
    readonly cardinality: number;
    readonly actionable: boolean;
  }[];
  readonly #semanticAccountSignInFact?: {
    readonly cardinality: number;
    readonly actionable: boolean;
  };
  readonly #structuralAccountSignIn: boolean;
  readonly #inspect: () => void;
  readonly #activate: (action: string) => void;
  constructor(
    facts: readonly {
      readonly cardinality: number;
      readonly actionable: boolean;
    }[],
    semanticAccountSignInFact: {
      readonly cardinality: number;
      readonly actionable: boolean;
    } | undefined,
    structuralAccountSignIn: boolean,
    inspect: () => void,
    activate: (action: string) => void,
  ) {
    this.#facts = facts;
    this.#semanticAccountSignInFact = semanticAccountSignInFact;
    this.#structuralAccountSignIn = structuralAccountSignIn;
    this.#inspect = inspect;
    this.#activate = activate;
  }
  async inspect(
    _page: FakePage,
    action: string,
    options: { readonly waitForCandidate?: boolean } = {},
  ) {
    this.#inspect();
    if (action === "account_sign_in") {
      if (options.waitForCandidate === false) {
        return { cardinality: 0, actionable: false };
      }
      return this.#semanticAccountSignInFact ?? (this.#structuralAccountSignIn
        ? this.#facts[0]!
        : { cardinality: 0, actionable: false });
    }
    const fact = this.#facts[Math.min(this.#inspections, this.#facts.length - 1)]!;
    this.#inspections += 1;
    return fact;
  }
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
  phase: "posting" | "apply_choice" | "email_sign_in_choice" | "account" | "application" = "posting";
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
