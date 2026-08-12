import assert from "node:assert/strict";
import { test } from "node:test";

import { PlaywrightPostingNavigationAdapter } from "../../../src/browser/playwright-live/private/playwright-posting-navigation.ts";
import { WORKDAY_COMPLETE_SIGN_IN_SELECTOR } from "../../../src/browser/playwright-live/private/workday-structural-catalog.ts";

test("production adapter resolves each closed Workday transition semantically", async () => {
  for (const [action, role, name] of [
    ["account_sign_in", "link", "Sign In"],
    ["start_application", "button", "Apply"],
    ["start_application", "link", "Apply Now"],
    ["start_application", "button", "Start Your Application"],
    ["apply_manually", "button", "Apply Manually"],
    ["apply_manually", "link", "Apply Manually"],
    ["sign_in_with_email", "button", "Sign in with email"],
    ["sign_in_with_email", "link", "Sign in with email"],
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

test("posting navigation declines an exact cookie banner before Apply", async () => {
  const page = new SemanticPage({
    "button:Decline": locator(),
    "button:Apply": locator(),
  });
  const adapter = new PlaywrightPostingNavigationAdapter();

  await adapter.activate(page, "start_application");

  assert.deepEqual(page.clicked, ["button:Decline", "button:Apply"]);
  assert.deepEqual(page.hiddenWaits, [
    { key: "button:Decline", state: "hidden", timeout: 5_000 },
  ]);
});

test("account Sign In falls back to one exact text control when no semantic role exists", async () => {
  const page = new SemanticPage({ "text:Sign In": locator() });
  const adapter = new PlaywrightPostingNavigationAdapter();

  assert.deepEqual(
    await adapter.inspect(page, "account_sign_in", { waitForCandidate: false }),
    { cardinality: 1, actionable: true },
  );
  await adapter.activate(page, "account_sign_in");
  assert.deepEqual(page.clicked, ["text:Sign In"]);
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

test("inspection gives an exact Apply control twenty seconds then stays fail closed", async () => {
  const waits: Array<{
    readonly state: "attached" | "visible";
    readonly timeout: number;
  }> = [];
  const page = new SemanticPage({ "button:Apply": absentLocator(waits) });
  const adapter = new PlaywrightPostingNavigationAdapter();

  assert.deepEqual(await adapter.inspect(page, "start_application"), {
    cardinality: 0,
    actionable: false,
  });
  assert.deepEqual(waits, [{ state: "visible", timeout: 20_000 }]);
  assert.deepEqual(page.clicked, []);
});

test("posting preflight inspects exact Sign In without waiting for a missing control", async () => {
  const waits: Array<{
    readonly state: "attached" | "visible";
    readonly timeout: number;
  }> = [];
  const page = new SemanticPage({ "link:Sign In": absentLocator(waits) });
  const adapter = new PlaywrightPostingNavigationAdapter();

  assert.deepEqual(
    await adapter.inspect(page, "account_sign_in", { waitForCandidate: false }),
    { cardinality: 0, actionable: false },
  );
  assert.deepEqual(waits, []);
});

test("Apply Manually gives the exact destination 20 seconds without repeating a failed click", async () => {
  const trace: string[] = [];
  const page = new SemanticPage(
    { "button:Apply Manually": locator() },
    { destinationAvailable: false },
  );
  const adapter = new PlaywrightPostingNavigationAdapter({
    trace: (event) => trace.push(event),
  });

  await assert.rejects(() => adapter.activate(page, "apply_manually"));

  assert.deepEqual(page.clicked, ["button:Apply Manually"]);
  assert.deepEqual(page.destinationWaitArguments, [
    { state: "attached", timeout: 20_000 },
  ]);
  assert.equal(trace.at(-1), "posting_apply_manually_destination_wait_failed");
});

test("Apply Manually admits the exact identity-provider choice page without self-settling email sign-in", async () => {
  const choiceSelector =
    '[data-automation-id="signInContent"]:has([data-automation-id="SignInWithEmailButton"])';
  const applyPage = new SemanticPage({ "button:Apply Manually": locator() });
  const emailPage = new SemanticPage({ "button:Sign in with email": locator() });
  const adapter = new PlaywrightPostingNavigationAdapter();

  await adapter.activate(applyPage, "apply_manually");
  await adapter.activate(emailPage, "sign_in_with_email");

  assert.equal(applyPage.destinationQueries[0]?.includes(choiceSelector), true);
  assert.equal(emailPage.destinationQueries[0]?.includes(choiceSelector), false);
});

test("Sign in with email waits for a credential or application destination", async () => {
  const page = new SemanticPage({ "button:Sign in with email": locator() });
  const adapter = new PlaywrightPostingNavigationAdapter();

  await adapter.activate(page, "sign_in_with_email");

  assert.equal(page.destinationWaits, 1);
});

test("account Sign In also admits a complete wrapper-independent credential form", async () => {
  const modernSelector =
    '[data-automation-id="signInContent"]:has([data-automation-id="signInSubmitButton"]):has([data-automation-id="createAccountLink"])';
  const page = new SemanticPage({ "text:Sign In": locator() });
  const adapter = new PlaywrightPostingNavigationAdapter();

  await adapter.activate(page, "account_sign_in");

  assert.equal(page.destinationQueries[0]?.includes(modernSelector), true);
  assert.equal(page.destinationQueries[0]?.includes(WORKDAY_COMPLETE_SIGN_IN_SELECTOR), true);
  assert.equal(
    page.destinationQueries[0]?.split(", ").includes('[data-automation-id="email"]'),
    false,
  );
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
  readonly hiddenWaits: Array<{
    readonly key: string;
    readonly state: "hidden";
    readonly timeout: number;
  }> = [];
  readonly destinationQueries: string[] = [];
  readonly destinationWaitArguments: Array<{
    readonly state: "attached" | "visible";
    readonly timeout: number;
  }> = [];
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
      waitFor: async (waitOptions) => {
        if (waitOptions.state === "hidden") {
          this.hiddenWaits.push({
            key,
            state: "hidden",
            timeout: waitOptions.timeout,
          });
          return;
        }
        await item.waitFor(waitOptions);
      },
    };
  }
  getByText(text: string): LocatorState {
    const key = `text:${text}`;
    const item = this.#locators[key] ?? locator(false, false, 0);
    return {
      ...item,
      click: async () => {
        this.#effectStarted = true;
        this.clicked.push(key);
      },
    };
  }
  locator(selector: string): LocatorState {
    this.destinationQueries.push(selector);
    const item = locator();
    return {
      ...item,
      waitFor: async (options) => {
        if (options.state === "hidden") throw new Error("destination hidden");
        this.destinationWaits += 1;
        this.destinationWaitArguments.push({
          state: options.state === "attached" ? "attached" : "visible",
          timeout: options.timeout,
        });
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
  waitFor(options: {
    readonly state: "attached" | "hidden" | "visible";
    readonly timeout: number;
  }): Promise<void>;
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

function absentLocator(
  waits: Array<{
    readonly state: "attached" | "visible";
    readonly timeout: number;
  }>,
): LocatorState {
  return {
    count: async () => 0,
    isVisible: async () => false,
    isEnabled: async () => false,
    click: async () => undefined,
    nth() { return this; },
    first() { return this; },
    waitFor: async (options) => {
      if (options.state === "hidden") throw new Error("not hidden");
      waits.push({
        state: options.state === "attached" ? "attached" : "visible",
        timeout: options.timeout,
      });
      throw new Error("not visible before timeout");
    },
  };
}
