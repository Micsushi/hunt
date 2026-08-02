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

test("Apply Manually waits for an admitted account or application destination", async () => {
  const page = new SemanticPage({ "button:Apply Manually": locator() });
  const adapter = new PlaywrightPostingNavigationAdapter();

  await adapter.activate(page, "apply_manually");

  assert.equal(page.destinationWaits, 1);
});

test("Apply Manually accepts an admitted destination opened in a popup", async () => {
  const trace: string[] = [];
  const popup = new SemanticPage({}, { destinationAvailable: true });
  const page = new SemanticPage(
    { "button:Apply Manually": locator() },
    { destinationAvailable: false, popup },
  );
  const adapter = new PlaywrightPostingNavigationAdapter({
    trace: (event) => trace.push(event),
  });

  await adapter.activate(page, "apply_manually");

  assert.equal(page.destinationWaits, 1);
  assert.equal(popup.destinationWaits, 1);
  assert.deepEqual(trace, [
    "posting_apply_manually_click_started",
    "posting_apply_manually_click_succeeded",
    "posting_apply_manually_popup_destination_observed",
  ]);
});

class SemanticPage {
  readonly clicked: string[] = [];
  destinationWaits = 0;
  readonly #locators: Readonly<Record<string, LocatorState>>;
  readonly #destinationAvailable: boolean;
  readonly #popup: SemanticPage | undefined;
  #effectStarted = false;
  constructor(
    locators: Readonly<Record<string, LocatorState>>,
    options: {
      readonly destinationAvailable?: boolean;
      readonly popup?: SemanticPage;
    } = {},
  ) {
    this.#locators = locators;
    this.#destinationAvailable = options.destinationAvailable ?? true;
    this.#popup = options.popup;
  }
  getByRole(role: string, options: { readonly name: string }): LocatorState {
    const key = `${role}:${options.name}`;
    const item = this.#locators[key] ?? locator(false, false, 0);
    return {
      ...item,
      click: async () => {
        this.#effectStarted = true;
        this.clicked.push(key);
      },
    };
  }
  locator(): LocatorState {
    const item = locator();
    return {
      ...item,
      waitFor: async () => {
        this.destinationWaits += 1;
        if (!this.#destinationAvailable) throw new Error("destination absent");
      },
    };
  }
  async waitForEvent(event: "popup"): Promise<SemanticPage> {
    assert.equal(event, "popup");
    if (this.#effectStarted) throw new Error("popup listener armed after click");
    if (this.#popup === undefined) throw new Error("popup absent");
    return this.#popup;
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
