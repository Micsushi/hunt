import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RECOVERY_RETRY_LIMITS,
  RecoveryRetryBudget,
  classifyRecoveryInterruption,
  recoverBrowserInterruption,
  type RecoveryBrowserPageTruth,
  type RecoveryCheckpoint,
  type RecoveryDependencies,
  type RecoveryInterruption,
} from "../../../src/journey/recovery/index.ts";

const journeyId = "journey_0123456789abcdef" as never;
const sourceRevision = "revision_0123456789abcdef" as never;
const operationId = "operation_0123456789abcdef" as never;
const page = (suffix: string) => `page-${suffix}` as never;
const target = {
  schemaVersion: 1 as const,
  atsFamily: "workday" as const,
  hostId: "host_0123456789abcdef" as never,
  tenantId: "tenant_0123456789abcdef" as never,
  postingId: "posting_0123456789abcdef" as never,
};
const otherTarget = {
  ...target,
  postingId: "posting_fedcba9876543210" as never,
};

function checkpoint(
  overrides: Partial<RecoveryCheckpoint> = {},
): RecoveryCheckpoint {
  return {
    schemaVersion: 1,
    journeyId,
    sourceRevision,
    revision: 3,
    target,
    page: { id: page("profile"), kind: "profile" },
    verification: "verified",
    terminal: null,
    ...overrides,
  };
}

function truth(
  overrides: Partial<RecoveryBrowserPageTruth> = {},
): RecoveryBrowserPageTruth {
  return {
    page: { id: page("profile"), kind: "profile" },
    target,
    verification: "verified",
    surface: "primary",
    ...overrides,
  };
}

type BrowserStep =
  | { readonly ok: true; readonly pages: readonly RecoveryBrowserPageTruth[] }
  | {
      readonly ok: false;
      readonly code:
        | "browser_timeout"
        | "browser_target_stale"
        | "browser_session_invalidated"
        | "browser_effect_uncertain";
    };

function setup(options: {
  readonly loaded?: RecoveryCheckpoint | null | unknown;
  readonly browser?: readonly BrowserStep[];
  readonly reloadErrors?: readonly BrowserStep[];
  readonly reattachErrors?: readonly BrowserStep[];
  readonly saved?: RecoveryCheckpoint | unknown;
  readonly terminal?: RecoveryCheckpoint["terminal"];
} = {}) {
  const calls: string[] = [];
  const saved: RecoveryCheckpoint[] = [];
  const records: unknown[] = [];
  const terminals: NonNullable<RecoveryCheckpoint["terminal"]>[] = [];
  let browserIndex = 0;
  let reloadIndex = 0;
  let reattachIndex = 0;
  const browser = options.browser ?? [{ ok: true, pages: [truth()] }];
  const action = (name: "reload" | "reattach", steps: readonly BrowserStep[] | undefined, index: number) => {
    calls.push(name);
    const step = steps?.[index];
    return step?.ok === false
      ? { ok: false as const, error: { code: step.code } }
      : { ok: true as const, value: undefined };
  };
  const dependencies: RecoveryDependencies = {
    state: {
      async load() {
        calls.push("state.load");
        return { ok: true, value: (options.loaded ?? checkpoint()) as never };
      },
      async save(request) {
        calls.push("state.save");
        saved.push(request.state);
        return {
          ok: true,
          value: (options.saved ?? request.state) as RecoveryCheckpoint,
        };
      },
    },
    browser: {
      async inspect() {
        calls.push("browser.inspect");
        const step = browser[Math.min(browserIndex++, browser.length - 1)];
        if (step === undefined) throw new Error("browser fixture is empty");
        return step.ok
          ? { ok: true, value: { pages: step.pages } }
          : { ok: false, error: { code: step.code } };
      },
      async reload() {
        return action("reload", options.reloadErrors, reloadIndex++);
      },
      async reattach() {
        return action("reattach", options.reattachErrors, reattachIndex++);
      },
    },
    reconciliation: {
      async record(request) {
        calls.push("reconciliation.record");
        records.push(request.record);
        return { ok: true, value: undefined };
      },
    },
    terminal: {
      async commit(request) {
        calls.push("terminal.commit");
        terminals.push(request.terminal);
        return {
          ok: true,
          value: options.terminal ?? request.terminal,
        };
      },
    },
  };
  return { calls, dependencies, records, saved, terminals };
}

function input(
  interruption: RecoveryInterruption,
  overrides: Partial<Parameters<typeof recoverBrowserInterruption>[1]> = {},
) {
  return {
    schemaVersion: 1 as const,
    journeyId,
    sourceRevision,
    expectedTarget: target,
    operationId,
    interruption,
    ...overrides,
  };
}

test("classifier permits only bounded pre-effect browser interruptions", () => {
  const matrix = [
    ["reload_required", "reload", "reload"],
    ["browser_target_stale", "stale_handle", "reattach"],
    ["browser_timeout", "transient_network", "reload"],
    ["popup_observed", "popup", "inspect"],
    ["process_interrupted", "interrupted_process", "reattach"],
    ["browser_session_missing", "interrupted_process", "reattach"],
  ] as const;
  for (const [code, kind, action] of matrix) {
    assert.deepEqual(
      classifyRecoveryInterruption({ code, effect: "none" }),
      { recoverable: true, kind, action },
      code,
    );
  }
  for (const interruption of [
    { code: "browser_effect_uncertain", effect: "possible" },
    { code: "browser_timeout", effect: "possible" },
    { code: "browser_target_invalid", effect: "none" },
  ] as const) {
    assert.deepEqual(classifyRecoveryInterruption(interruption), {
      recoverable: false,
      code: "recovery_state_ambiguous",
    });
  }
});

test("retry budgets enforce per-kind and total limits", () => {
  assert.deepEqual(DEFAULT_RECOVERY_RETRY_LIMITS, {
    reload: 2,
    stale_handle: 1,
    transient_network: 2,
    popup: 1,
    interrupted_process: 1,
    total: 4,
  });
  const budget = new RecoveryRetryBudget({
    ...DEFAULT_RECOVERY_RETRY_LIMITS,
    transient_network: 2,
    total: 2,
  });
  assert.equal(budget.consume("transient_network"), true);
  assert.equal(budget.consume("transient_network"), true);
  assert.equal(budget.consume("transient_network"), false);
  assert.equal(budget.consume("reload"), false);
  assert.deepEqual(budget.snapshot(), {
    reload: 0,
    stale_handle: 0,
    transient_network: 2,
    popup: 0,
    interrupted_process: 0,
    total: 2,
  });
  assert.throws(
    () => new RecoveryRetryBudget({ ...DEFAULT_RECOVERY_RETRY_LIMITS, reload: -1 }),
    /reload/u,
  );
});

test("fault matrix recovers each supported interruption and records browser truth", async () => {
  const matrix: readonly {
    readonly interruption: RecoveryInterruption;
    readonly browser: readonly BrowserStep[];
    readonly action?: "reload" | "reattach";
    readonly pages?: readonly RecoveryBrowserPageTruth[];
  }[] = [
    {
      interruption: { code: "reload_required", effect: "none" },
      browser: [
        { ok: false, code: "browser_timeout" },
        { ok: true, pages: [truth()] },
      ],
      action: "reload",
    },
    {
      interruption: { code: "browser_target_stale", effect: "none" },
      browser: [
        { ok: false, code: "browser_target_stale" },
        { ok: true, pages: [truth()] },
      ],
      action: "reattach",
    },
    {
      interruption: { code: "browser_timeout", effect: "none" },
      browser: [
        { ok: false, code: "browser_timeout" },
        { ok: true, pages: [truth()] },
      ],
      action: "reload",
    },
    {
      interruption: { code: "popup_observed", effect: "none" },
      browser: [{
        ok: true,
        pages: [
          truth({ target: otherTarget, surface: "primary" }),
          truth({ page: { id: page("popup"), kind: "profile" }, surface: "popup" }),
        ],
      }],
    },
    {
      interruption: { code: "process_interrupted", effect: "none" },
      browser: [
        { ok: false, code: "browser_session_invalidated" },
        { ok: true, pages: [truth()] },
      ],
      action: "reattach",
    },
  ];
  for (const scenario of matrix) {
    const fixture = setup({ browser: scenario.browser });
    const result = await recoverBrowserInterruption(
      fixture.dependencies,
      input(scenario.interruption),
      new AbortController().signal,
    );
    assert.equal(result.ok, true, scenario.interruption.code);
    if (!result.ok) continue;
    assert.equal(result.value.kind, "resumed", scenario.interruption.code);
    assert.equal(fixture.records.length, 1, scenario.interruption.code);
    assert.equal(fixture.saved.length, 1, scenario.interruption.code);
    assert.equal(
      fixture.calls.filter((call) => call === scenario.action).length,
      scenario.action === undefined ? 0 : 1,
      scenario.interruption.code,
    );
  }
});

test("browser truth replaces a stale page projection but never skips verification", async () => {
  const advanced = setup({
    browser: [{
      ok: true,
      pages: [truth({
        page: { id: page("questionnaire"), kind: "questionnaire" },
      })],
    }],
  });
  const result = await recoverBrowserInterruption(
    advanced.dependencies,
    input({ code: "reload_required", effect: "none" }),
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (result.ok && result.value.kind === "resumed") {
    assert.deepEqual(result.value.state.page, {
      id: page("questionnaire"),
      kind: "questionnaire",
    });
    assert.equal(result.value.reconciliation.page, "browser_advanced");
  }

  const pending = checkpoint({
    page: { id: page("verification"), kind: "verification" },
    verification: "required",
  });
  const skipped = setup({
    loaded: pending,
    browser: [{
      ok: true,
      pages: [truth({
        page: { id: page("questionnaire"), kind: "questionnaire" },
        verification: "not_required",
      })],
    }],
  });
  const stopped = await recoverBrowserInterruption(
    skipped.dependencies,
    input({ code: "reload_required", effect: "none" }),
    new AbortController().signal,
  );
  assert.equal(stopped.ok, true);
  if (stopped.ok) {
    assert.deepEqual(stopped.value, {
      kind: "terminal",
      terminal: skipped.terminals[0],
    });
    assert.equal(stopped.value.terminal.code, "recovery_state_ambiguous");
  }
  assert.equal(skipped.saved.length, 0);

  for (const observed of [
    truth({
      page: { id: page("verification"), kind: "verification" },
      verification: "required",
    }),
    truth({
      page: { id: page("questionnaire"), kind: "questionnaire" },
      verification: "verified",
    }),
  ]) {
    const safe = setup({ loaded: pending, browser: [{ ok: true, pages: [observed] }] });
    const resumed = await recoverBrowserInterruption(
      safe.dependencies,
      input({ code: "reload_required", effect: "none" }),
      new AbortController().signal,
    );
    assert.equal(resumed.ok, true);
    if (resumed.ok) assert.equal(resumed.value.kind, "resumed");
  }
});

test("wrong, duplicate, and ambiguous browser pages stop without adoption", async () => {
  const cases: readonly (readonly [string, readonly RecoveryBrowserPageTruth[]])[] = [
    ["wrong target", [truth({ target: otherTarget })]],
    ["two exact targets", [truth(), truth({ page: { id: page("second"), kind: "profile" } })]],
    ["duplicate page", [truth(), truth()]],
    ["unknown page", [truth({ page: { id: page("unknown"), kind: "unknown" } })]],
    ["unknown verification", [truth({ verification: "unknown" })]],
  ];
  for (const [label, pages] of cases) {
    const fixture = setup({ browser: [{ ok: true, pages }] });
    const result = await recoverBrowserInterruption(
      fixture.dependencies,
      input({ code: "popup_observed", effect: "none" }),
      new AbortController().signal,
    );
    assert.equal(result.ok, true, label);
    if (result.ok) {
      assert.equal(result.value.kind, "terminal", label);
      if (result.value.kind === "terminal") {
        assert.equal(
          result.value.terminal.code,
          label === "wrong target"
            ? "recovery_target_mismatch"
            : "recovery_state_ambiguous",
          label,
        );
      }
    }
    assert.equal(fixture.saved.length, 0, label);
    assert.equal(fixture.records.length, 1, label);
  }
});

test("recovery retries are bounded and end in one idempotent terminal", async () => {
  const fixture = setup({
    browser: [{ ok: false, code: "browser_timeout" }],
  });
  const result = await recoverBrowserInterruption(
    fixture.dependencies,
    input(
      { code: "browser_timeout", effect: "none" },
      {
        retryLimits: {
          ...DEFAULT_RECOVERY_RETRY_LIMITS,
          transient_network: 2,
          total: 2,
        },
      },
    ),
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (result.ok && result.value.kind === "terminal") {
    assert.equal(result.value.terminal.code, "journey_retry_exhausted");
    assert.equal(result.value.terminal.attempts.transient_network, 2);
    assert.equal(result.value.terminal.attempts.total, 2);
  }
  assert.equal(fixture.calls.filter((call) => call === "reload").length, 2);
  assert.equal(fixture.calls.filter((call) => call === "terminal.commit").length, 1);
  assert.equal(fixture.records.length, 1);
});

test("checkpoint rehydration requires exact journey, revision, target, and shape", async () => {
  const cases: readonly (readonly [string, unknown, string])[] = [
    ["journey", checkpoint({ journeyId: "journey_fedcba9876543210" as never }), "recovery_state_ambiguous"],
    ["revision", checkpoint({ sourceRevision: "revision_fedcba9876543210" as never }), "recovery_state_ambiguous"],
    ["target", checkpoint({ target: otherTarget }), "recovery_target_mismatch"],
    ["shape", { ...checkpoint(), extra: true }, "recovery_checkpoint_invalid"],
  ];
  for (const [label, loaded, code] of cases) {
    const fixture = setup({ loaded });
    const result = await recoverBrowserInterruption(
      fixture.dependencies,
      input({ code: "process_interrupted", effect: "none" }),
      new AbortController().signal,
    );
    if (code === "recovery_checkpoint_invalid") {
      assert.deepEqual(result, {
        ok: false,
        error: { code: "recovery_checkpoint_invalid", retryable: false },
      }, label);
    } else {
      assert.equal(result.ok, true, label);
      if (result.ok && result.value.kind === "terminal") {
        assert.equal(result.value.terminal.code, code, label);
      }
    }
    assert.equal(
      fixture.calls.filter((call) => call === "browser.inspect").length,
      0,
      label,
    );
  }
});

test("terminal checkpoints replay without browser work and reject contradictory commits", async () => {
  const terminal = {
    schemaVersion: 1 as const,
    journeyId,
    operationId,
    code: "recovery_state_ambiguous" as const,
    retryable: false as const,
    attempts: {
      reload: 0,
      stale_handle: 0,
      transient_network: 0,
      popup: 0,
      interrupted_process: 0,
      total: 0,
    },
  };
  const replay = setup({ loaded: checkpoint({ terminal }), terminal });
  assert.deepEqual(
    await recoverBrowserInterruption(
      replay.dependencies,
      input({ code: "process_interrupted", effect: "none" }),
      new AbortController().signal,
    ),
    { ok: true, value: { kind: "terminal", terminal } },
  );
  assert.equal(replay.calls.includes("browser.inspect"), false);

  const contradiction = setup({
    loaded: checkpoint({ terminal }),
    terminal: { ...terminal, code: "recovery_target_mismatch" },
  });
  assert.deepEqual(
    await recoverBrowserInterruption(
      contradiction.dependencies,
      input({ code: "process_interrupted", effect: "none" }),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "recovery_state_ambiguous", retryable: false },
    },
  );
});

test("terminal replay never bypasses checkpoint journey or target binding", async () => {
  const priorTerminal = {
    schemaVersion: 1 as const,
    journeyId,
    operationId,
    code: "recovery_state_ambiguous" as const,
    retryable: false as const,
    attempts: {
      reload: 0,
      stale_handle: 0,
      transient_network: 0,
      popup: 0,
      interrupted_process: 0,
      total: 0,
    },
  };
  const wrongTarget = setup({
    loaded: checkpoint({ target: otherTarget, terminal: priorTerminal }),
  });
  const stopped = await recoverBrowserInterruption(
    wrongTarget.dependencies,
    input({ code: "process_interrupted", effect: "none" }),
    new AbortController().signal,
  );
  assert.equal(stopped.ok, true);
  if (stopped.ok && stopped.value.kind === "terminal") {
    assert.equal(stopped.value.terminal.code, "recovery_target_mismatch");
  }

  const innerJourneyMismatch = setup({
    loaded: checkpoint({
      terminal: {
        ...priorTerminal,
        journeyId: "journey_fedcba9876543210" as never,
      },
    }),
  });
  assert.deepEqual(
    await recoverBrowserInterruption(
      innerJourneyMismatch.dependencies,
      input({ code: "process_interrupted", effect: "none" }),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "recovery_checkpoint_invalid", retryable: false },
    },
  );
});

test("idempotent state and terminal replays ignore object key order", async () => {
  const original = checkpoint();
  const reorderedState = {
    terminal: null,
    verification: original.verification,
    page: { kind: original.page.kind, id: original.page.id },
    target: {
      postingId: original.target.postingId,
      tenantId: original.target.tenantId,
      hostId: original.target.hostId,
      atsFamily: original.target.atsFamily,
      schemaVersion: original.target.schemaVersion,
    },
    revision: original.revision + 1,
    sourceRevision: original.sourceRevision,
    journeyId: original.journeyId,
    schemaVersion: original.schemaVersion,
  } as RecoveryCheckpoint;
  const state = setup({ saved: reorderedState });
  const resumed = await recoverBrowserInterruption(
    state.dependencies,
    input({ code: "reload_required", effect: "none" }),
    new AbortController().signal,
  );
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.equal(resumed.value.kind, "resumed");

  const attempts = {
    reload: 0,
    stale_handle: 0,
    transient_network: 0,
    popup: 0,
    interrupted_process: 0,
    total: 0,
  };
  const terminal = {
    attempts,
    retryable: false as const,
    code: "recovery_state_ambiguous" as const,
    operationId,
    journeyId,
    schemaVersion: 1 as const,
  };
  const replay = setup({
    loaded: checkpoint({ terminal }),
    terminal: {
      schemaVersion: 1,
      journeyId,
      operationId,
      code: "recovery_state_ambiguous",
      retryable: false,
      attempts: { ...attempts },
    },
  });
  const terminalResult = await recoverBrowserInterruption(
    replay.dependencies,
    input({ code: "process_interrupted", effect: "none" }),
    new AbortController().signal,
  );
  assert.equal(terminalResult.ok, true);
  if (terminalResult.ok) assert.equal(terminalResult.value.kind, "terminal");
});

test("possible effects and cancellation never trigger blind repair", async () => {
  const uncertain = setup();
  const stopped = await recoverBrowserInterruption(
    uncertain.dependencies,
    input({ code: "browser_effect_uncertain", effect: "possible" }),
    new AbortController().signal,
  );
  assert.equal(stopped.ok, true);
  if (stopped.ok && stopped.value.kind === "terminal") {
    assert.equal(stopped.value.terminal.code, "recovery_state_ambiguous");
  }
  assert.equal(uncertain.calls.includes("browser.inspect"), false);
  assert.equal(uncertain.calls.includes("reload"), false);
  assert.equal(uncertain.calls.includes("reattach"), false);
  assert.equal(uncertain.records.length, 1);

  const cancelled = setup();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await recoverBrowserInterruption(
      cancelled.dependencies,
      input({ code: "reload_required", effect: "none" }),
      controller.signal,
    ),
    { ok: false, error: { code: "operation_cancelled", retryable: false } },
  );
  assert.deepEqual(cancelled.calls, []);
});

test("checkpoint validation rejects accessors without evaluating them", async () => {
  let evaluated = false;
  const poisoned = { ...checkpoint() } as Record<string, unknown>;
  Object.defineProperty(poisoned, "schemaVersion", {
    enumerable: true,
    get() {
      evaluated = true;
      return 1;
    },
  });
  const fixture = setup({ loaded: poisoned });
  assert.deepEqual(
    await recoverBrowserInterruption(
      fixture.dependencies,
      input({ code: "process_interrupted", effect: "none" }),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "recovery_checkpoint_invalid", retryable: false },
    },
  );
  assert.equal(evaluated, false);
});

test("malformed dependency errors collapse to a stable recovery code", async () => {
  const fixture = setup();
  fixture.dependencies.state.load = async () => ({
    ok: false,
    error: { code: "unstable_provider_detail" },
  }) as never;
  assert.deepEqual(
    await recoverBrowserInterruption(
      fixture.dependencies,
      input({ code: "process_interrupted", effect: "none" }),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "recovery_state_ambiguous", retryable: false },
    },
  );
});
