import assert from "node:assert/strict";
import { test } from "node:test";

import { PlaywrightAccountPageAdapter } from "../../../src/browser/playwright-live/private/playwright-account-page.ts";
import {
  WORKDAY_ACCOUNT_FACT_SELECTORS,
  WORKDAY_INLINE_VERIFICATION_SELECTORS,
  WORKDAY_SIGN_IN_REJECTION_SELECTORS,
} from "../../../src/browser/playwright-live/private/workday-structural-catalog.ts";

const SIGN_IN_EXACT_FACT_SELECTORS = [
  WORKDAY_ACCOUNT_FACT_SELECTORS.absent,
  ...WORKDAY_INLINE_VERIFICATION_SELECTORS,
  WORKDAY_SIGN_IN_REJECTION_SELECTORS.credentialsOrLocked,
] as const;
const LIVE_VERIFICATION_REQUIRED_SELECTOR =
  ':text-is("Verify your account before you sign in or request a verification email.")';
const SIGN_IN_FAILURE_DIAGNOSTIC_SELECTORS = [
  '[data-automation-id="signInPage"]',
  '[data-automation-id="createAccountPage"]',
  ':text-is("You may have entered the wrong email address or password or your account might be locked.")',
  '[role="alert"]',
  '[data-automation-id="createAccountLink"]',
] as const;

test("inspects one exact semantic field without exposing its locator", async () => {
  const locator = new FakeLocator({ count: 1, visible: true, enabled: true, editable: true });
  const page = new FakePage(locator);
  const adapter = new PlaywrightAccountPageAdapter();

  const fact = await adapter.inspect(page, "email");

  assert.deepEqual(fact, { cardinality: 1, actionable: true });
  assert.deepEqual(page.calls, [
    { method: "locator", selector: '[data-automation-id="email"]' },
  ]);
  assert.equal(JSON.stringify(fact).includes("locator"), false);
});

test("maps every closed control to its exact Workday semantic locator", async () => {
  const cases = [
    ["password", { method: "locator", selector: '[data-automation-id="password"]' }],
    ["password_confirmation", { method: "locator", selector: '[data-automation-id="verifyPassword"]' }],
    ["show_sign_in", { method: "locator", selector: '[data-automation-id="signInLink"]' }],
    ["show_create_account", { method: "locator", selector: '[data-automation-id="createAccountLink"]' }],
    ["submit_sign_in", { method: "locator", selector: '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]' }],
    ["submit_create_account", { method: "locator", selector: '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="createAccountSubmitButton"]) [data-automation-id="click_filter"][role="button"]' }],
    ["accept_terms", { method: "locator", selector: '[data-automation-id="createAccountCheckbox"]' }],
  ] as const;
  const adapter = new PlaywrightAccountPageAdapter();

  for (const [control, expectedCall] of cases) {
    const locator = new FakeLocator({ count: 1, visible: true, enabled: true, editable: true });
    const page = new FakePage(locator);

    assert.deepEqual(await adapter.inspect(page, control), {
      cardinality: 1,
      actionable: true,
    });
    assert.deepEqual(page.calls, [expectedCall]);
  }
});

test("reports exact cardinality and rejects non-actionable field states", async () => {
  const cases = [
    [
      { count: 0, visible: true, enabled: true, editable: true },
      { cardinality: 0, actionable: false },
    ],
    [
      { count: 2, visible: true, enabled: true, editable: true },
      { cardinality: 2, actionable: false },
    ],
    [
      { count: 1, visible: false, enabled: true, editable: true },
      { cardinality: 1, actionable: false },
    ],
    [
      { count: 1, visible: true, enabled: false, editable: true },
      { cardinality: 1, actionable: false },
    ],
    [
      { count: 1, visible: true, enabled: true, editable: false },
      { cardinality: 1, actionable: false },
    ],
  ] as const;
  const adapter = new PlaywrightAccountPageAdapter();

  for (const [locatorState, expected] of cases) {
    const page = new FakePage(new FakeLocator(locatorState));
    assert.deepEqual(await adapter.inspect(page, "email"), expected);
  }
});

test("fills field bytes through the exact locator without retaining value material", async () => {
  const locator = new FakeLocator({ count: 1, visible: true, enabled: true, editable: true });
  const page = new FakePage(locator);
  const adapter = new PlaywrightAccountPageAdapter();
  const bytes = Uint8Array.from([65, 0, 66]);

  const result = await adapter.fill(page, "password_confirmation", bytes);

  assert.equal(result, undefined);
  assert.deepEqual(page.calls, [
    { method: "locator", selector: '[data-automation-id="verifyPassword"]' },
  ]);
  assert.deepEqual(locator.fillArguments, ["A\u0000B"]);
  assert.deepEqual([...bytes], [65, 0, 66]);
  assert.deepEqual(Object.keys(adapter), []);
});

test("matches field bytes exactly without returning or retaining plaintext", async () => {
  const locator = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: true,
    inputValue: "\u00c5",
  });
  const page = new FakePage(locator);
  const adapter = new PlaywrightAccountPageAdapter();
  const expected = Uint8Array.from([0xc3, 0x85]);
  const mismatch = Uint8Array.from([0xc3, 0x84]);

  assert.equal(await adapter.matches(page, "email", expected), true);
  assert.equal(await adapter.matches(page, "email", mismatch), false);
  assert.deepEqual([...expected], [0xc3, 0x85]);
  assert.deepEqual([...mismatch], [0xc3, 0x84]);
  assert.equal(locator.inputValueCalls, 2);
  assert.deepEqual(Object.keys(adapter), []);
});

test("clears only the exact semantic field without focus-moving locator clear", async () => {
  const locator = new FakeLocator({ count: 1, visible: true, enabled: true, editable: true });
  const page = new FakePage(locator);
  const adapter = new PlaywrightAccountPageAdapter();

  assert.equal(await adapter.clear(page, "password"), undefined);
  assert.deepEqual(page.calls, [
    { method: "locator", selector: '[data-automation-id="password"]' },
  ]);
  assert.equal(locator.clearCalls, 0);
  assert.equal(locator.evaluateCalls, 1);
});

test("reports only whether the exact semantic field is empty", async () => {
  const adapter = new PlaywrightAccountPageAdapter();
  const empty = new FakePage(new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: true,
    inputValue: "",
  }));
  const occupied = new FakePage(new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: true,
    inputValue: "synthetic",
  }));

  assert.equal(await adapter.isEmpty(empty, "email"), true);
  assert.equal(await adapter.isEmpty(occupied, "email"), false);
  assert.deepEqual(Object.keys(adapter), []);
});

test("activates each exact semantic link or button without returning page state", async () => {
  const cases = [
    ["show_sign_in", { method: "locator", selector: '[data-automation-id="signInLink"]' }],
    ["show_create_account", { method: "locator", selector: '[data-automation-id="createAccountLink"]' }],
    ["submit_sign_in", { method: "locator", selector: '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]' }],
    ["submit_create_account", { method: "locator", selector: '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="createAccountSubmitButton"]) [data-automation-id="click_filter"][role="button"]' }],
  ] as const;
  const adapter = new PlaywrightAccountPageAdapter();

  for (const [action, expectedCall] of cases) {
    const locator = new FakeLocator({ count: 1, visible: true, enabled: true, editable: false });
    const destination = new FakeLocator({ count: 1, visible: true, enabled: true, editable: false });
    const page = new FakePage(locator, destination);

    assert.equal(await adapter.activate(page, action), undefined);
    assert.deepEqual(page.calls, action.startsWith("submit_")
      ? [
          expectedCall,
          ...(action === "submit_sign_in"
            ? SIGN_IN_EXACT_FACT_SELECTORS.map((selector) => ({ method: "locator", selector }))
            : [{ method: "locator", selector: WORKDAY_ACCOUNT_FACT_SELECTORS.exists }]),
          {
            method: "locator",
            selector: action === "submit_sign_in"
              ? '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="createAccountSubmitButton"]) [data-automation-id="click_filter"][role="button"]'
              : '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]',
          },
          ...(action === "submit_create_account"
            ? [{
                method: "locator",
                selector: '[data-automation-id="signInContent"]:has([data-automation-id="signInSubmitButton"]):has([data-automation-id="createAccountLink"])',
              }]
            : []),
          {
            method: "locator",
            selector: [
              action === "submit_sign_in"
                ? '[data-automation-id="createAccountPage"]'
                : '[data-automation-id="signInPage"]',
              '[data-automation-id="emailVerificationPage"]',
              '[data-automation-id="verifyEmailPage"]',
              '[data-automation-id="candidateHomePage"]',
              '[data-automation-id="applyFlowMyInfoPage"]',
              '[data-automation-id="applyFlowApplicationQuestionsPage"]',
              '[data-automation-id="applyFlowReviewPage"]',
              '[data-automation-id="captchaChallenge"]',
              'iframe[title="reCAPTCHA"]',
              'iframe[title="hCaptcha"]',
              '[data-automation-id="mfaChallenge"]',
              '[data-automation-id="accessDeniedPage"]',
              '[data-automation-id="securityChallenge"]',
            ].join(", "),
          },
        ]
      : [expectedCall]);
    assert.equal(locator.clickCalls, 1);
    assert.deepEqual(
      locator.waitForArguments,
      action.startsWith("submit_")
        ? [
            { state: "hidden", timeout: 10_000 },
            { state: "visible", timeout: 10_000 },
          ]
        : [],
    );
    assert.deepEqual(
      destination.waitForArguments,
      action.startsWith("submit_")
        ? [{ state: "attached", timeout: 10_000 }]
        : [],
    );
  }
});

test("accepting terms uses idempotent checkbox semantics", async () => {
  const locator = new FakeLocator({ count: 1, visible: true, enabled: true, editable: false });
  const page = new FakePage(locator);
  const adapter = new PlaywrightAccountPageAdapter();

  assert.equal(await adapter.activate(page, "accept_terms"), undefined);
  assert.equal(locator.checkCalls, 1);
  assert.equal(locator.clickCalls, 0);
});

test("a submit that remains visible never claims a settled effect", async () => {
  const events: string[] = [];
  const locator = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    hiddenWaitFails: true,
  });
  const page = new FakePage(locator);

  await assert.rejects(
    new PlaywrightAccountPageAdapter({
      trace: (event) => events.push(event),
    }).activate(page, "submit_sign_in"),
    /submit effect did not settle/u,
  );

  assert.deepEqual(page.calls, [
    { method: "locator", selector: '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]' },
    ...SIGN_IN_EXACT_FACT_SELECTORS.map((selector) => ({ method: "locator", selector })),
    { method: "locator", selector: '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="createAccountSubmitButton"]) [data-automation-id="click_filter"][role="button"]' },
    ...SIGN_IN_FAILURE_DIAGNOSTIC_SELECTORS.map((selector) => ({ method: "locator", selector })),
  ]);
  assert.deepEqual(locator.waitForArguments, [
    { state: "hidden", timeout: 10_000 },
  ]);
  assert.deepEqual(events, [
    "submit_hit_target_clear",
    "submit_click_started",
    "submit_click_succeeded",
    "submit_control_remained_visible",
    "submit_diagnostic_page_unknown",
    "submit_diagnostic_action_sign_in",
    "submit_diagnostic_alert_none",
    "submit_diagnostic_create_account_available",
    "submit_diagnostic_submit_visible",
  ]);
});

test("an unsettled sign-in reports only allowlisted page facts", async () => {
  const events: string[] = [];
  const visible = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
  });
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    hiddenWaitFails: true,
  });
  const page = new FakePage(submit, submit, new Map([
    ['[data-automation-id="signInPage"]', visible],
    ['[data-automation-id="createAccountLink"]', visible],
    [':text-is("You may have entered the wrong email address or password or your account might be locked.")', visible],
  ]));

  visible.values.visibleResults = [false];
  await new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(page, "submit_sign_in");

  assert.deepEqual(events, [
    "submit_hit_target_clear",
    "submit_click_started",
    "submit_click_succeeded",
    "submit_diagnostic_alert_credentials_or_locked",
    "submit_exact_fact_observed",
  ]);
  assert.equal(JSON.stringify(events).includes("@"), false);
});

test("a stale credentials-or-locked alert is reported but cannot settle a new click", async () => {
  const events: string[] = [];
  const visible = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
  });
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    hiddenWaitFails: true,
  });
  const page = new FakePage(submit, submit, new Map([
    ['[data-automation-id="signInPage"]', visible],
    ['[data-automation-id="createAccountLink"]', visible],
    [WORKDAY_SIGN_IN_REJECTION_SELECTORS.credentialsOrLocked, visible],
  ]));

  await assert.rejects(
    new PlaywrightAccountPageAdapter({
      trace: (event) => events.push(event),
    }).activate(page, "submit_sign_in"),
    /submit effect did not settle/u,
  );

  assert.equal(events.includes("submit_exact_fact_observed"), false);
  assert.deepEqual(events.slice(-5), [
    "submit_diagnostic_page_sign_in",
    "submit_diagnostic_action_sign_in",
    "submit_diagnostic_alert_credentials_or_locked",
    "submit_diagnostic_create_account_available",
    "submit_diagnostic_submit_visible",
  ]);
});

test("an unknown visible alert is reduced to one fixed category without reading text", async () => {
  const events: string[] = [];
  const visible = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
  });
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    hiddenWaitFails: true,
  });
  const page = new FakePage(submit, submit, new Map([
    ['[data-automation-id="signInPage"]', visible],
    ['[role="alert"]', visible],
  ]));

  await assert.rejects(
    new PlaywrightAccountPageAdapter({
      trace: (event) => events.push(event),
    }).activate(page, "submit_sign_in"),
    /submit effect did not settle/u,
  );

  assert.equal(events.includes("submit_diagnostic_alert_unknown"), true);
  assert.equal(page.calls.some((call) => Object.hasOwn(call as object, "textContent")), false);
});

test("an opted-in unsettled submit holds without another browser read or action", async () => {
  const events: string[] = [];
  let releaseHold!: () => void;
  let markHoldStarted!: () => void;
  const holdStarted = new Promise<void>((resolve) => { markHoldStarted = resolve; });
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    hiddenWaitFails: true,
  });
  const page = new FakePage(submit);
  const adapter = new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
    unsettledInspectionHold: async () => {
      markHoldStarted();
      await hold;
    },
  });

  let settled = false;
  const pending = adapter.activate(page, "submit_sign_in")
    .then(() => { settled = true; }, (error: unknown) => {
      settled = true;
      throw error;
    });
  await holdStarted;
  const callsAtHold = structuredClone(page.calls);
  const clickCallsAtHold = submit.clickCalls;
  const waitsAtHold = structuredClone(submit.waitForArguments);
  const exactFactReadsAtHold = page.absentExactFactLocator.isVisibleCalls;
  const exactFactWaitsAtHold = structuredClone(
    page.absentExactFactLocator.waitForArguments,
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(page.calls, callsAtHold);
  assert.equal(submit.clickCalls, clickCallsAtHold);
  assert.deepEqual(submit.waitForArguments, waitsAtHold);
  assert.equal(page.absentExactFactLocator.isVisibleCalls, exactFactReadsAtHold);
  assert.deepEqual(page.absentExactFactLocator.waitForArguments, exactFactWaitsAtHold);
  assert.deepEqual(events, [
    "submit_hit_target_clear",
    "submit_click_started",
    "submit_click_succeeded",
    "submit_control_remained_visible",
    "submit_diagnostic_page_unknown",
    "submit_diagnostic_action_sign_in",
    "submit_diagnostic_alert_none",
    "submit_diagnostic_create_account_available",
    "submit_diagnostic_submit_visible",
    "submit_inspection_hold_started",
  ]);

  releaseHold();
  await assert.rejects(pending, /submit effect did not settle/u);
  assert.equal(submit.clickCalls, 1);
  assert.deepEqual(page.calls, callsAtHold);
  assert.deepEqual(submit.waitForArguments, waitsAtHold);
  assert.equal(page.absentExactFactLocator.isVisibleCalls, exactFactReadsAtHold);
  assert.deepEqual(page.absentExactFactLocator.waitForArguments, exactFactWaitsAtHold);
  assert.deepEqual(events, [
    "submit_hit_target_clear",
    "submit_click_started",
    "submit_click_succeeded",
    "submit_control_remained_visible",
    "submit_diagnostic_page_unknown",
    "submit_diagnostic_action_sign_in",
    "submit_diagnostic_alert_none",
    "submit_diagnostic_create_account_available",
    "submit_diagnostic_submit_visible",
    "submit_inspection_hold_started",
    "submit_inspection_hold_ended",
  ]);
});

test("only the action-specific exact account fact settles a visible submit", async () => {
  const cases = [
    ["submit_sign_in", WORKDAY_ACCOUNT_FACT_SELECTORS.absent, WORKDAY_ACCOUNT_FACT_SELECTORS.exists],
    ["submit_create_account", WORKDAY_ACCOUNT_FACT_SELECTORS.exists, WORKDAY_ACCOUNT_FACT_SELECTORS.absent],
  ] as const;
  for (const [action, exactSelector, opposingSelector] of cases) {
    const events: string[] = [];
    const submit = new FakeLocator({
      count: 1,
      visible: true,
      enabled: true,
      editable: false,
      hiddenWaitFails: true,
    });
    const fact = new FakeLocator({
      count: 1,
      visible: true,
      visibleResults: [false],
      enabled: false,
      editable: false,
    });
    const absent = new FakeLocator({
      count: 0,
      visible: false,
      enabled: false,
      editable: false,
      attachedWaitFails: true,
      visibleWaitFails: true,
    });
    const page = new FakePage(submit, absent, new Map([
      [exactSelector, fact],
      [opposingSelector, absent],
    ]));

    await new PlaywrightAccountPageAdapter({
      trace: (event) => events.push(event),
    }).activate(page, action);

    assert.deepEqual(fact.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
    assert.deepEqual(absent.waitForArguments, []);
    assert.equal(events.at(-1), "submit_exact_fact_observed");
  }
});

test("an exact inline verification marker settles sign-in while its submit remains visible", async () => {
  const events: string[] = [];
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    hiddenWaitFails: true,
  });
  const verification = new FakeLocator({ count: 1, visible: true, enabled: false, editable: false });
  const page = new FakePage(submit, undefined, new Map([[
    WORKDAY_INLINE_VERIFICATION_SELECTORS[0]!,
    verification,
  ]]));
  verification.values.visibleResults = [false];

  await new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(page, "submit_sign_in");

  assert.deepEqual(verification.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
  assert.equal(events.at(-1), "submit_exact_fact_observed");
});

test("the observed live verification-required alert settles sign-in without a page transition", async () => {
  const events: string[] = [];
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    hiddenWaitFails: true,
  });
  const verification = new FakeLocator({
    count: 1,
    visible: true,
    enabled: false,
    editable: false,
    visibleResults: [false],
  });
  const page = new FakePage(submit, undefined, new Map([
    [LIVE_VERIFICATION_REQUIRED_SELECTOR, verification],
  ]));

  await new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(page, "submit_sign_in");

  assert.deepEqual(verification.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
  assert.equal(events.at(-1), "submit_exact_fact_observed");
});

test("the exact account fact remains recognized after submit hide and reappearance", async () => {
  const events: string[] = [];
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const submit = new FakeLocator({ count: 1, visible: true, enabled: true, editable: false });
  const absentDestination = new FakeLocator({
    count: 0,
    visible: false,
    enabled: false,
    editable: false,
    attachedWaitFails: true,
  });
  const fact = new FakeLocator({
    count: 1,
    visible: true,
    enabled: false,
    editable: false,
    visibleResults: [false],
    visibleWaitGate: { started, wait, markStarted: () => markStarted() },
  });
  const page = new FakePage(submit, absentDestination, new Map([
    [WORKDAY_ACCOUNT_FACT_SELECTORS.absent, fact],
    [SIGN_IN_EXACT_FACT_SELECTORS.join(", "), fact],
  ]));

  let settled = false;
  const pending = new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(page, "submit_sign_in").then(() => { settled = true; });
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await pending;

  assert.deepEqual(fact.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
  assert.equal(events.at(-1), "submit_exact_fact_observed");
});

test("a hidden earlier marker cannot starve a later visible exact marker", async () => {
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    hiddenWaitFails: true,
  });
  const hidden = new FakeLocator({
    count: 1,
    visible: false,
    visibleResults: [false],
    enabled: false,
    editable: false,
    visibleWaitFails: true,
  });
  const visible = new FakeLocator({
    count: 1,
    visible: true,
    visibleResults: [false],
    enabled: false,
    editable: false,
  });
  const page = new FakePage(submit, undefined, new Map([
    [SIGN_IN_EXACT_FACT_SELECTORS[0]!, hidden],
    [SIGN_IN_EXACT_FACT_SELECTORS[1]!, visible],
  ]));

  await new PlaywrightAccountPageAdapter().activate(page, "submit_sign_in");

  assert.deepEqual(hidden.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
  assert.deepEqual(visible.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
});

test("a pre-existing visible marker cannot settle a new submit effect", async () => {
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    hiddenWaitFails: true,
  });
  const stale = new FakeLocator({ count: 1, visible: true, enabled: false, editable: false });
  const page = new FakePage(submit, undefined, new Map([
    [WORKDAY_ACCOUNT_FACT_SELECTORS.absent, stale],
    [SIGN_IN_EXACT_FACT_SELECTORS.join(", "), stale],
  ]));

  await assert.rejects(
    new PlaywrightAccountPageAdapter().activate(page, "submit_sign_in"),
    /submit effect did not settle/u,
  );

  assert.equal(stale.isVisibleCalls, 1);
  assert.deepEqual(stale.waitForArguments, []);
});

test("a markerless rejected submit may detach then reattach before classification", async () => {
  const events: string[] = [];
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
  });
  const absentDestination = new FakeLocator({
    count: 0,
    visible: false,
    enabled: false,
    editable: false,
    attachedWaitFails: true,
  });
  const email = new FakeLocator({ count: 1, visible: true, enabled: true, editable: true });
  const password = new FakeLocator({ count: 1, visible: true, enabled: true, editable: true });

  await new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(
    new FakePage(submit, absentDestination, new Map([
      ['[data-automation-id="email"]', email],
      ['[data-automation-id="password"]', password],
    ])),
    "submit_sign_in",
  );

  assert.deepEqual(submit.waitForArguments, [
    { state: "hidden", timeout: 10_000 },
    { state: "visible", timeout: 10_000 },
    { state: "visible", timeout: 10_000 },
  ]);
  assert.deepEqual(email.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
  assert.deepEqual(password.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
  assert.deepEqual(absentDestination.waitForArguments, [
    { state: "attached", timeout: 10_000 },
  ]);
  assert.deepEqual(events, [
    "submit_hit_target_clear",
    "submit_click_started",
    "submit_click_succeeded",
    "submit_rejection_reappeared",
  ]);
});

test("a hidden attached submit owner cannot beat a known destination", async () => {
  const events: string[] = [];
  const submit = new FakeLocator({
    count: 1,
    visible: false,
    enabled: true,
    editable: false,
    visibleWaitFails: true,
  });
  const destination = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    attachedWaitYields: true,
  });
  const opposingCreateOwner = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
  });

  await new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(new FakePage(submit, destination, new Map([
    [
      '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="createAccountSubmitButton"]) [data-automation-id="click_filter"][role="button"]',
      opposingCreateOwner,
    ],
  ])), "submit_sign_in");

  assert.deepEqual(submit.waitForArguments, [
    { state: "hidden", timeout: 10_000 },
    { state: "visible", timeout: 10_000 },
  ]);
  assert.deepEqual(destination.waitForArguments, [
    { state: "attached", timeout: 10_000 },
  ]);
  assert.deepEqual(events, [
    "submit_hit_target_clear",
    "submit_click_started",
    "submit_click_succeeded",
    "submit_destination_observed",
  ]);
});

test("a sign-in rejection waits for the complete semantic form to become visible", async () => {
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
  });
  const absentDestination = new FakeLocator({
    count: 0,
    visible: false,
    enabled: false,
    editable: false,
    attachedWaitFails: true,
  });
  const email = new FakeLocator({ count: 1, visible: true, enabled: true, editable: true });
  const password = new FakeLocator({ count: 1, visible: true, enabled: true, editable: true });
  const page = new FakePage(submit, absentDestination, new Map([
    ['[data-automation-id="email"]', email],
    ['[data-automation-id="password"]', password],
  ]));

  await new PlaywrightAccountPageAdapter().activate(page, "submit_sign_in");

  assert.deepEqual(submit.waitForArguments, [
    { state: "hidden", timeout: 10_000 },
    { state: "visible", timeout: 10_000 },
    { state: "visible", timeout: 10_000 },
  ]);
  assert.deepEqual(email.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
  assert.deepEqual(password.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
  assert.equal(submit.clickCalls, 1);
  for (const field of [email, password]) {
    assert.equal(field.clickCalls, 0);
    assert.deepEqual(field.fillArguments, []);
    assert.equal(field.evaluateCalls, 0);
  }
});

test("a create-account rejection waits for confirmation with the semantic form", async () => {
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
  });
  const absentDestination = new FakeLocator({
    count: 0,
    visible: false,
    enabled: false,
    editable: false,
    attachedWaitFails: true,
  });
  const email = new FakeLocator({ count: 1, visible: true, enabled: true, editable: true });
  const password = new FakeLocator({ count: 1, visible: true, enabled: true, editable: true });
  const confirmation = new FakeLocator({ count: 1, visible: true, enabled: true, editable: true });
  const page = new FakePage(submit, absentDestination, new Map([
    ['[data-automation-id="email"]', email],
    ['[data-automation-id="password"]', password],
    ['[data-automation-id="verifyPassword"]', confirmation],
  ]));

  await new PlaywrightAccountPageAdapter().activate(page, "submit_create_account");

  assert.deepEqual(submit.waitForArguments, [
    { state: "hidden", timeout: 10_000 },
    { state: "visible", timeout: 10_000 },
    { state: "visible", timeout: 10_000 },
  ]);
  for (const field of [email, password, confirmation]) {
    assert.deepEqual(field.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
    assert.equal(field.clickCalls, 0);
    assert.deepEqual(field.fillArguments, []);
    assert.equal(field.evaluateCalls, 0);
  }
  assert.equal(submit.clickCalls, 1);
});

test("rejection readiness identifies the exact failed semantic wait", async () => {
  const cases = [
    ["submit_sign_in", "submit", "submit_rejection_submit_owner_wait_failed"],
    ["submit_sign_in", "email", "submit_rejection_email_wait_failed"],
    ["submit_sign_in", "password", "submit_rejection_password_wait_failed"],
    [
      "submit_create_account",
      "password_confirmation",
      "submit_rejection_password_confirmation_wait_failed",
    ],
  ] as const;

  for (const [action, failedWait, failureEvent] of cases) {
    const events: string[] = [];
    const submit = new FakeLocator({
      count: 1,
      visible: failedWait !== "submit",
      enabled: true,
      editable: false,
      visibleWaitFails: failedWait === "submit",
    });
    const absentDestination = new FakeLocator({
      count: 0,
      visible: false,
      enabled: false,
      editable: false,
      attachedWaitFails: true,
    });
    const email = new FakeLocator({
      count: 1,
      visible: failedWait !== "email",
      enabled: true,
      editable: true,
      visibleWaitFails: failedWait === "email",
    });
    const password = new FakeLocator({
      count: 1,
      visible: failedWait !== "password",
      enabled: true,
      editable: true,
      visibleWaitFails: failedWait === "password",
    });
    const confirmation = new FakeLocator({
      count: 1,
      visible: failedWait !== "password_confirmation",
      enabled: true,
      editable: true,
      visibleWaitFails: failedWait === "password_confirmation",
    });

    await assert.rejects(() => new PlaywrightAccountPageAdapter({
      trace: (event) => events.push(event),
    }).activate(new FakePage(submit, absentDestination, new Map([
      ['[data-automation-id="email"]', email],
      ['[data-automation-id="password"]', password],
      ['[data-automation-id="verifyPassword"]', confirmation],
    ])), action));

    assert.deepEqual(events, [
      "submit_hit_target_clear",
      "submit_click_started",
      "submit_click_succeeded",
      failureEvent,
      "submit_stabilization_failed",
    ]);
    for (const field of [email, password, confirmation]) {
      assert.equal(field.clickCalls, 0);
      assert.deepEqual(field.fillArguments, []);
      assert.equal(field.evaluateCalls, 0);
    }
  }
});

test("submit stabilization excludes the stale current account container", async () => {
  for (const [action, staleMarker] of [
    ["submit_sign_in", "signInPage"],
    ["submit_create_account", "createAccountPage"],
  ] as const) {
    const page = new FakePage(
      new FakeLocator({ count: 1, visible: true, enabled: true, editable: false }),
      new FakeLocator({ count: 1, visible: true, enabled: true, editable: false }),
    );

    await new PlaywrightAccountPageAdapter().activate(page, action);

    const destination = (page.calls as Array<{ readonly selector?: string }>).find(({ selector }) =>
      selector?.includes("candidateHomePage")
    )?.selector ?? "";
    assert.equal(destination.includes(`[data-automation-id="${staleMarker}"]`), false);
    assert.equal(destination.includes('[data-automation-id="authPage"]'), false);
  }
});

test("create-account submit admits a newly visible semantic sign-in destination", async () => {
  const signInOwnerSelector =
    '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]';
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    visibleWaitFails: true,
  });
  const absentStructuralDestination = new FakeLocator({
    count: 0,
    visible: false,
    enabled: false,
    editable: false,
    attachedWaitFails: true,
  });
  const signInOwner = new FakeLocator({
    count: 1,
    visible: false,
    visibleResults: [false],
    enabled: true,
    editable: false,
  });

  await new PlaywrightAccountPageAdapter().activate(
    new FakePage(submit, absentStructuralDestination, new Map([
      [signInOwnerSelector, signInOwner],
    ])),
    "submit_create_account",
  );

  assert.deepEqual(signInOwner.waitForArguments, [
    { state: "visible", timeout: 10_000 },
  ]);
});

test("create-account submit admits a newly visible exact modern sign-in form", async () => {
  const modernSelector =
    '[data-automation-id="signInContent"]:has([data-automation-id="signInSubmitButton"]):has([data-automation-id="createAccountLink"])';
  const modern = new FakeLocator({
    count: 1,
    visible: false,
    visibleResults: [false, true],
    enabled: true,
    editable: false,
  });
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    visibleWaitFails: true,
  });
  const absentDestination = new FakeLocator({
    count: 0,
    visible: false,
    enabled: false,
    editable: false,
    attachedWaitFails: true,
  });
  const absentOpposingOwner = new FakeLocator({
    count: 0,
    visible: false,
    enabled: false,
    editable: false,
    visibleWaitFails: true,
  });

  await new PlaywrightAccountPageAdapter().activate(
    new FakePage(submit, absentDestination, new Map([
      [modernSelector, modern],
      ['[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]', absentOpposingOwner],
    ])),
    "submit_create_account",
  );

  assert.deepEqual(modern.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
  assert.equal(modern.isVisibleCalls, 2);
});

test("modern sign-in settlement rejects hidden, pre-existing, and duplicate forms", async () => {
  const modernSelector =
    '[data-automation-id="signInContent"]:has([data-automation-id="signInSubmitButton"]):has([data-automation-id="createAccountLink"])';
  const cases = [
    new FakeLocator({ count: 1, visible: false, enabled: true, editable: false, visibleWaitFails: true }),
    new FakeLocator({ count: 1, visible: true, enabled: true, editable: false }),
    new FakeLocator({ count: 2, visible: true, enabled: true, editable: false }),
  ];
  for (const modern of cases) {
    const submit = new FakeLocator({
      count: 1,
      visible: true,
      enabled: true,
      editable: false,
      visibleWaitFails: true,
    });
    const absentDestination = new FakeLocator({
      count: 0,
      visible: false,
      enabled: false,
      editable: false,
      attachedWaitFails: true,
    });
    const absentOpposingOwner = new FakeLocator({
      count: 0,
      visible: false,
      enabled: false,
      editable: false,
      visibleWaitFails: true,
    });

    await assert.rejects(() => new PlaywrightAccountPageAdapter().activate(
      new FakePage(submit, absentDestination, new Map([
        [modernSelector, modern],
        ['[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]', absentOpposingOwner],
      ])),
      "submit_create_account",
    ));
  }
});

test("hidden attached semantic sign-in markup cannot settle create-account submit", async () => {
  const signInOwnerSelector =
    '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]';
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    visibleWaitFails: true,
  });
  const absentStructuralDestination = new FakeLocator({
    count: 0,
    visible: false,
    enabled: false,
    editable: false,
    attachedWaitFails: true,
  });
  const hiddenSignInOwner = new FakeLocator({
    count: 1,
    visible: false,
    enabled: true,
    editable: false,
    visibleWaitFails: true,
  });

  await assert.rejects(() => new PlaywrightAccountPageAdapter().activate(
    new FakePage(submit, absentStructuralDestination, new Map([
      [signInOwnerSelector, hiddenSignInOwner],
    ])),
    "submit_create_account",
  ));

  assert.deepEqual(hiddenSignInOwner.waitForArguments, [
    { state: "visible", timeout: 10_000 },
  ]);
});

test("submit stabilization fails closed when no known state appears", async () => {
  const events: string[] = [];
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    visibleWaitFails: true,
  });
  const absentDestination = new FakeLocator({
    count: 0,
    visible: false,
    enabled: false,
    editable: false,
    attachedWaitFails: true,
  });

  await assert.rejects(() => new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(
    new FakePage(submit, absentDestination),
    "submit_sign_in",
  ));
  assert.deepEqual(events, [
    "submit_hit_target_clear",
    "submit_click_started",
    "submit_click_succeeded",
    "submit_rejection_submit_owner_wait_failed",
    "submit_stabilization_failed",
  ]);
});

test("submit click failure never repositions the page", async () => {
  const events: string[] = [];
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    clickFails: true,
    hitTarget: "fixed_overlay",
  });

  await assert.rejects(() => new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(new FakePage(submit), "submit_sign_in"));

  assert.deepEqual(events, [
    "submit_hit_target_fixed_overlay",
    "submit_click_started",
    "submit_click_failed",
    "submit_click_other",
  ]);
});

test("submit intents target Workday's NoCaptcha click owners, never covered buttons", async () => {
  for (const [action, buttonId] of [
    ["submit_sign_in", "signInSubmitButton"],
    ["submit_create_account", "createAccountSubmitButton"],
  ] as const) {
    const page = new FakePage(
      new FakeLocator({ count: 1, visible: true, enabled: true, editable: false }),
    );

    await new PlaywrightAccountPageAdapter().inspect(page, action);

    const selector = (page.calls[0] as { readonly selector: string }).selector;
    assert.equal(
      selector,
      `[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="${buttonId}"]) [data-automation-id="click_filter"][role="button"]`,
    );
    assert.notEqual(selector, `[data-automation-id="${buttonId}"]`);
  }
});

test("submit click timeout is reduced to one fixed diagnostic identifier", async () => {
  const events: string[] = [];
  const timeout = new Error("synthetic private detail");
  timeout.name = "TimeoutError";
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    clickError: timeout,
  });

  await assert.rejects(() => new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(new FakePage(submit), "submit_sign_in"));

  assert.deepEqual(events, [
    "submit_hit_target_clear",
    "submit_click_started",
    "submit_click_failed",
    "submit_click_timeout",
  ]);
  assert.equal(JSON.stringify(events).includes("private"), false);
});

test("specific click obstruction outranks the generic timeout category", async () => {
  const events: string[] = [];
  const timeout = new Error("another element intercepts pointer events");
  timeout.name = "TimeoutError";

  await assert.rejects(() => new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(new FakePage(new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    clickError: timeout,
  })), "submit_sign_in"));

  assert.equal(events.at(-1), "submit_click_intercepted");
});

test("loading obstruction is reduced to a fixed overlay category", async () => {
  const events: string[] = [];
  const timeout = new Error("loading spinner intercepts pointer events");
  timeout.name = "TimeoutError";

  await assert.rejects(() => new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(new FakePage(new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    clickError: timeout,
  })), "submit_sign_in"));

  assert.equal(events.at(-1), "submit_click_loading_overlay");
});

class FakePage {
  readonly calls: unknown[] = [];
  readonly resultLocator: FakeLocator;
  readonly destinationLocator: FakeLocator;
  readonly selectorLocators: ReadonlyMap<string, FakeLocator>;
  readonly absentExactFactLocator = new FakeLocator({
    count: 0,
    visible: false,
    enabled: false,
    editable: false,
    visibleWaitFails: true,
  });
  constructor(
    locator: FakeLocator,
    destinationLocator: FakeLocator = locator,
    selectorLocators: ReadonlyMap<string, FakeLocator> = new Map(),
  ) {
    this.resultLocator = locator;
    this.destinationLocator = destinationLocator;
    this.selectorLocators = selectorLocators;
  }
  getByLabel(name: string, options: { exact: boolean }): FakeLocator {
    this.calls.push({ method: "getByLabel", name, exact: options.exact });
    return this.resultLocator;
  }
  getByRole(role: string, options: { name: string; exact: boolean }): FakeLocator {
    this.calls.push({ method: "getByRole", role, name: options.name, exact: options.exact });
    return this.resultLocator;
  }
  locator(selector: string): FakeLocator {
    this.calls.push({ method: "locator", selector });
    const selected = this.selectorLocators.get(selector);
    if (selected !== undefined) return selected;
    if (
      selector.includes("accountNotFoundError") ||
      selector.includes("accountAlreadyExistsError") ||
      selector.includes('signInPage"]:has-text') ||
      selector === LIVE_VERIFICATION_REQUIRED_SELECTOR ||
      selector === '[data-automation-id="signInPage"]' ||
      selector === '[data-automation-id="createAccountPage"]' ||
      selector === WORKDAY_SIGN_IN_REJECTION_SELECTORS.credentialsOrLocked ||
      selector === '[role="alert"]'
    ) return this.absentExactFactLocator;
    return selector.includes("candidateHomePage")
      ? this.destinationLocator
      : this.resultLocator;
  }
  async goto(): Promise<void> {}
  isClosed(): boolean { return false; }
  async close(): Promise<void> {}
}

class FakeLocator {
  readonly values: {
    count: number;
    visible: boolean;
    enabled: boolean;
    editable: boolean;
    inputValue?: string;
    hiddenWaitFails?: boolean;
    attachedWaitFails?: boolean;
    attachedWaitYields?: boolean;
    visibleWaitFails?: boolean;
    visibleWaitYields?: boolean;
    visibleResults?: boolean[];
    visibleWaitGate?: {
      readonly started: Promise<void>;
      readonly wait: Promise<void>;
      readonly markStarted: () => void;
    };
    clickFails?: boolean;
    clickError?: Error;
    hitTarget?: string;
  };
  readonly fillArguments: string[] = [];
  inputValueCalls = 0;
  isVisibleCalls = 0;
  clearCalls = 0;
  evaluateCalls = 0;
  clickCalls = 0;
  checkCalls = 0;
  readonly waitForArguments: unknown[] = [];
  constructor(values: {
    count: number;
    visible: boolean;
    enabled: boolean;
    editable: boolean;
    inputValue?: string;
    hiddenWaitFails?: boolean;
    attachedWaitFails?: boolean;
    attachedWaitYields?: boolean;
    visibleWaitFails?: boolean;
    visibleWaitYields?: boolean;
    visibleResults?: boolean[];
    visibleWaitGate?: {
      readonly started: Promise<void>;
      readonly wait: Promise<void>;
      readonly markStarted: () => void;
    };
    clickFails?: boolean;
    clickError?: Error;
    hitTarget?: string;
  }) {
    this.values = values;
  }
  async count(): Promise<number> { return this.values.count; }
  async isVisible(): Promise<boolean> {
    this.isVisibleCalls += 1;
    return this.values.visibleResults?.shift() ?? this.values.visible;
  }
  async isEnabled(): Promise<boolean> { return this.values.enabled; }
  async isEditable(): Promise<boolean> { return this.values.editable; }
  async fill(value: string): Promise<void> { this.fillArguments.push(value); }
  async inputValue(): Promise<string> {
    this.inputValueCalls += 1;
    return this.values.inputValue ?? "";
  }
  async clear(): Promise<void> { this.clearCalls += 1; }
  async evaluate(operation: (element: HTMLInputElement) => unknown): Promise<unknown> {
    this.evaluateCalls += 1;
    if (!this.values.editable) return this.values.hitTarget ?? "clear";
    const events: string[] = [];
    const input = {
      value: "occupied",
      dispatchEvent: (event: Event) => {
        events.push(event.type);
        return true;
      },
    } as unknown as HTMLInputElement;
    operation(input);
    assert.equal(input.value, "");
    assert.deepEqual(events, ["input", "change"]);
  }
  async click(): Promise<void> {
    this.clickCalls += 1;
    if (this.values.clickError !== undefined) throw this.values.clickError;
    if (this.values.clickFails) throw new Error("click failed");
  }
  async waitFor(options: unknown): Promise<void> {
    this.waitForArguments.push(options);
    if (
      this.values.hiddenWaitFails &&
      (options as { readonly state?: string }).state === "hidden"
    ) throw new Error("submit remained visible");
    if (
      this.values.attachedWaitFails &&
      (options as { readonly state?: string }).state === "attached"
    ) throw new Error("state remained detached");
    if (
      this.values.attachedWaitYields &&
      (options as { readonly state?: string }).state === "attached"
    ) await new Promise<void>((resolve) => queueMicrotask(resolve));
    if (
      this.values.visibleWaitFails &&
      (options as { readonly state?: string }).state === "visible"
    ) throw new Error("state remained hidden");
    if (
      this.values.visibleWaitYields &&
      (options as { readonly state?: string }).state === "visible"
    ) await new Promise<void>((resolve) => queueMicrotask(resolve));
    if (
      this.values.visibleWaitGate !== undefined &&
      (options as { readonly state?: string }).state === "visible"
    ) {
      this.values.visibleWaitGate.markStarted();
      await this.values.visibleWaitGate.wait;
    }
  }
  first(): FakeLocator { return this; }
  async check(): Promise<void> { this.checkCalls += 1; }
}
