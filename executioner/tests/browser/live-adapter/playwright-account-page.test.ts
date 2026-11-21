import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";

import { PlaywrightAccountPageAdapter } from "../../../src/browser/playwright-live/private/playwright-account-page.ts";
import {
  WORKDAY_ACCOUNT_FACT_SELECTORS,
  WORKDAY_INLINE_VERIFICATION_SELECTORS,
  WORKDAY_SIGN_IN_REJECTION_SELECTORS,
} from "../../../src/browser/playwright-live/private/workday-structural-catalog.ts";
const POST_SUBMIT_DESTINATION_SELECTORS = [
  '[data-automation-id="emailVerificationPage"]',
  '[data-automation-id="verifyEmailPage"]',
  '[data-automation-id="candidateHomePage"]',
  '[data-automation-id="applyFlowMyInfoPage"]',
  '[data-automation-id="applyFlowApplicationQuestionsPage"]',
  '[data-automation-id="applyFlowSecondaryQuestionsPage"]',
  '[data-automation-id="applyFlowSupplementaryQuestionsPage"]',
  '[data-automation-id="applyFlowReviewPage"]',
  '[data-automation-id="captchaChallenge"]',
  'iframe[title="reCAPTCHA"]',
  'iframe[title="hCaptcha"]',
  '[data-automation-id="mfaChallenge"]',
  '[data-automation-id="accessDeniedPage"]',
  '[data-automation-id="securityChallenge"]',
  '[data-automation-id="forgotPasswordPage"]',
  '[data-automation-id="forgotPasswordConfirmationPage"]',
  '[data-automation-id="resetPasswordPage"]',
  ':text-is("Something went wrong")',
  ':text-is("{\\"503\\":\\"service-unavailable\\"}")',
] as const;

test("fills field bytes through the exact locator without retaining value material", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const [field, automationId, type] of [
      ['email', 'email', 'email'], ['email', 'email', 'text'],
      ['password', 'password', 'password'], ['password_confirmation', 'verifyPassword', 'password'],
    ] as const) {
    await page.setContent(`<input data-automation-id="${automationId}" type="${type}"><script>
      window.focusCount=0;window.kept='';
      const input=document.querySelector('input');
      input.addEventListener('focus',()=>window.focusCount++);
      input.addEventListener('input',()=>{window.kept=input.value;});
      input.addEventListener('change',()=>{input.value=window.kept;});
    </script>`);
    const adapter = new PlaywrightAccountPageAdapter();
    const bytes = new TextEncoder().encode('fixture-password');
    assert.equal(await adapter.fill(page, field, bytes), undefined);
    assert.equal(await adapter.matches(page, field, bytes), true);
    assert.equal(await page.evaluate('window.focusCount'), 0);
    assert.equal(await page.evaluate('window.kept'), 'fixture-password');
    for (const attribute of ['disabled', 'readonly', 'hidden']) {
      await page.locator('input').evaluate((e, attribute) => e.setAttribute(attribute, ''), attribute);
      await assert.rejects(adapter.fill(page, field, bytes), /credential field could not be filled/);
      await page.locator('input').evaluate((e, attribute) => e.removeAttribute(attribute), attribute);
    }
    await page.evaluate(() => { (window as any).originalValueDescriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value'); Object.defineProperty(HTMLInputElement.prototype, 'value', {
      set(value) { throw new Error(`secret-sentinel:${value}`); }, configurable: true,
    }); });
    await assert.rejects(adapter.fill(page, field, bytes), error => {
      assert.equal(String(error), 'Error: The credential field could not be filled. Check sign-in in the application tab.');
      assert.equal((error as Error).cause, undefined);
      return true;
    });
    assert.equal(new TextDecoder().decode(bytes), 'fixture-password');
    assert.deepEqual(Object.keys(adapter), []);
    await page.evaluate(() => Object.defineProperty(HTMLInputElement.prototype,'value',(window as any).originalValueDescriptor));
    }
  } finally { await browser.close(); }
});

test("a newly visible administrator password-reset alert settles sign-in exactly", async () => {
  const events: string[] = [];
  const submit = new FakeLocator({
    count: 1,
    visible: true,
    enabled: true,
    editable: false,
    hiddenWaitFails: true,
  });
  const reset = new FakeLocator({
    count: 1,
    visible: true,
    visibleResults: [false],
    enabled: false,
    editable: false,
  });
  const page = new FakePage(submit, undefined, new Map([[
    WORKDAY_SIGN_IN_REJECTION_SELECTORS.passwordResetRequired,
    reset,
  ]]));

  await new PlaywrightAccountPageAdapter({
    trace: (event) => events.push(event),
  }).activate(page, "submit_sign_in");

  assert.deepEqual(reset.waitForArguments, [{ state: "visible", timeout: 10_000 }]);
  assert.deepEqual(events.slice(-2), [
    "submit_diagnostic_alert_password_reset_required",
    "submit_exact_fact_observed",
  ]);
  assert.equal(submit.clickCalls, 1);
});

test("modern sign-in settlement defers hidden, pre-existing, and duplicate forms", async () => {
  const modernSelector =
    '[data-automation-id="signInContent"]:has([data-automation-id="signInSubmitButton"]):has([data-automation-id="createAccountLink"])';
  const cases = [
    new FakeLocator({ count: 1, visible: false, enabled: true, editable: false, visibleWaitFails: true }),
    new FakeLocator({ count: 1, visible: true, enabled: true, editable: false }),
    new FakeLocator({ count: 2, visible: true, enabled: true, editable: false }),
  ];
  for (const modern of cases) {
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
    const absentOpposingOwner = new FakeLocator({
      count: 0,
      visible: false,
      enabled: false,
      editable: false,
      visibleWaitFails: true,
    });

    await new PlaywrightAccountPageAdapter({
      trace: (event) => events.push(event),
    }).activate(
      new FakePage(submit, absentDestination, new Map([
        [modernSelector, modern],
        ['[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]', absentOpposingOwner],
      ])),
      "submit_create_account",
    );
    assert.equal(events.includes("submit_destination_observed"), false);
    assert.equal(events.at(-1), "submit_stabilization_deferred");
  }
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
      WORKDAY_INLINE_VERIFICATION_SELECTORS.some((candidate) => candidate === selector) ||
      selector === '[data-automation-id="signInPage"]' ||
      selector === '[data-automation-id="createAccountPage"]' ||
      selector === WORKDAY_SIGN_IN_REJECTION_SELECTORS.credentialsOrLocked ||
      selector === WORKDAY_SIGN_IN_REJECTION_SELECTORS.passwordResetRequired ||
      selector === '[role="alert"]'
    ) return this.absentExactFactLocator;
    if (selector === '[data-automation-id="candidateHomePage"]') {
      return this.destinationLocator;
    }
    if (POST_SUBMIT_DESTINATION_SELECTORS.includes(
      selector as typeof POST_SUBMIT_DESTINATION_SELECTORS[number],
    )) return this.absentExactFactLocator;
    return this.resultLocator;
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
