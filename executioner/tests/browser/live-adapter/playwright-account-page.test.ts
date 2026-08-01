import assert from "node:assert/strict";
import { test } from "node:test";

import { PlaywrightAccountPageAdapter } from "../../../src/browser/playwright-live/private/playwright-account-page.ts";

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
    ["submit_sign_in", { method: "locator", selector: '[data-automation-id="signInSubmitButton"]' }],
    ["submit_create_account", { method: "locator", selector: '[data-automation-id="createAccountSubmitButton"]' }],
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
    ["submit_sign_in", { method: "locator", selector: '[data-automation-id="signInSubmitButton"]' }],
    ["submit_create_account", { method: "locator", selector: '[data-automation-id="createAccountSubmitButton"]' }],
  ] as const;
  const adapter = new PlaywrightAccountPageAdapter();

  for (const [action, expectedCall] of cases) {
    const locator = new FakeLocator({ count: 1, visible: true, enabled: true, editable: false });
    const page = new FakePage(locator);

    assert.equal(await adapter.activate(page, action), undefined);
    assert.deepEqual(page.calls, [expectedCall]);
    assert.equal(locator.clickCalls, 1);
    assert.deepEqual(
      locator.waitForArguments,
      action.startsWith("submit_")
        ? [{ state: "hidden", timeout: 10_000 }]
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

class FakePage {
  readonly calls: unknown[] = [];
  readonly resultLocator: FakeLocator;
  constructor(locator: FakeLocator) { this.resultLocator = locator; }
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
  };
  readonly fillArguments: string[] = [];
  inputValueCalls = 0;
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
  }) {
    this.values = values;
  }
  async count(): Promise<number> { return this.values.count; }
  async isVisible(): Promise<boolean> { return this.values.visible; }
  async isEnabled(): Promise<boolean> { return this.values.enabled; }
  async isEditable(): Promise<boolean> { return this.values.editable; }
  async fill(value: string): Promise<void> { this.fillArguments.push(value); }
  async inputValue(): Promise<string> {
    this.inputValueCalls += 1;
    return this.values.inputValue ?? "";
  }
  async clear(): Promise<void> { this.clearCalls += 1; }
  async evaluate(operation: (element: HTMLInputElement) => void): Promise<void> {
    this.evaluateCalls += 1;
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
  async click(): Promise<void> { this.clickCalls += 1; }
  async waitFor(options: unknown): Promise<void> { this.waitForArguments.push(options); }
  async check(): Promise<void> { this.checkCalls += 1; }
}
