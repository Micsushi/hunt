import assert from "node:assert/strict";
import { test } from "node:test";

import { PlaywrightPostingNavigationAdapter } from "../../../src/browser/playwright-live/private/playwright-posting-navigation.ts";

test("production adapter resolves each closed Workday transition semantically", async () => {
  for (const [action, role, name] of [
    ["start_application", "button", "Apply"],
    ["start_application", "link", "Apply Now"],
    ["start_application", "button", "Start Your Application"],
    ["apply_manually", "button", "Apply Manually"],
    ["apply_manually", "link", "Apply Manually"],
  ] as const) {
    const page = new SemanticPage({ [`${role}:${name}`]: locator() });
    const adapter = new PlaywrightPostingNavigationAdapter();
    assert.deepEqual(await adapter.inspect(page, action), {
      cardinality: 1,
      actionable: true,
    });
    await adapter.activate(page, action);
    assert.deepEqual(page.clicked, [`${role}:${name}`]);
  }
});

test("missing, duplicate, hidden, and disabled transition controls fail closed", async () => {
  const adapter = new PlaywrightPostingNavigationAdapter();
  const cases = [
    [new SemanticPage({}), { cardinality: 0, actionable: false }],
    [
      new SemanticPage({
        "button:Apply": locator(),
        "link:Apply Now": locator(),
      }),
      { cardinality: 2, actionable: false },
    ],
    [
      new SemanticPage({ "button:Apply": locator(false, true) }),
      { cardinality: 1, actionable: false },
    ],
    [
      new SemanticPage({ "button:Apply": locator(true, false) }),
      { cardinality: 1, actionable: false },
    ],
  ] as const;
  for (const [page, fact] of cases) {
    assert.deepEqual(await adapter.inspect(page, "start_application"), fact);
    await assert.rejects(() => adapter.activate(page, "start_application"));
    assert.deepEqual(page.clicked, []);
  }
});

test("inspection admits a control that hydrates within the bounded semantic wait", async () => {
  const page = new SemanticPage({ "button:Apply": delayedLocator() });
  const adapter = new PlaywrightPostingNavigationAdapter();

  assert.deepEqual(await adapter.inspect(page, "start_application"), {
    cardinality: 1,
    actionable: true,
  });
});

class SemanticPage {
  readonly clicked: string[] = [];
  readonly #locators: Readonly<Record<string, LocatorState>>;
  constructor(locators: Readonly<Record<string, LocatorState>>) {
    this.#locators = locators;
  }
  getByRole(role: string, options: { readonly name: string }): LocatorState {
    const key = `${role}:${options.name}`;
    const item = this.#locators[key] ?? locator(false, false, 0);
    return { ...item, click: async () => { this.clicked.push(key); } };
  }
  async goto(): Promise<void> {}
  isClosed(): boolean { return false; }
  async close(): Promise<void> {}
}

interface LocatorState {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  click(): Promise<void>;
  nth(index: number): LocatorState;
  first(): LocatorState;
  waitFor(options: { readonly state: "visible"; readonly timeout: number }): Promise<void>;
}

function locator(visible = true, enabled = true, count = 1): LocatorState {
  return {
    count: async () => count,
    isVisible: async () => visible,
    isEnabled: async () => enabled,
    click: async () => undefined,
    nth() { return this; },
    first() { return this; },
    waitFor: async () => {
      if (count !== 1 || !visible) throw new Error("not visible");
    },
  };
}

function delayedLocator(): LocatorState {
  let ready = false;
  return {
    count: async () => ready ? 1 : 0,
    isVisible: async () => ready,
    isEnabled: async () => ready,
    click: async () => undefined,
    nth() { return this; },
    first() { return this; },
    waitFor: async () => { ready = true; },
  };
}
