import assert from "node:assert/strict";
import { test } from "node:test";

import { PlaywrightVerificationNavigationAdapter } from "../../../src/browser/playwright-live/private/playwright-verification-navigation.ts";

test("verification navigation decodes transient bytes for one existing-page goto", async () => {
  const page = new FakePage();
  const events: string[] = [];
  const adapter = new PlaywrightVerificationNavigationAdapter({
    trace: (event) => events.push(event),
  });
  const bytes = new TextEncoder().encode(
    "https://tenant.wd5.myworkdayjobs.invalid/verify?token=private",
  );

  await adapter.navigate(page, bytes);

  assert.deepEqual(page.gotoCalls, [{
    target: "https://tenant.wd5.myworkdayjobs.invalid/verify?token=private",
    options: { waitUntil: "commit" },
  }]);
  assert.deepEqual(events, [
    "verification_navigation_goto_started",
    "verification_navigation_commit_succeeded",
    "verification_navigation_email_sign_in_absent",
  ]);
  assert.deepEqual(Object.keys(adapter), []);
});

test("verification navigation enters the email sign-in form from the provider selector", async () => {
  const page = new FakePage(true);
  const events: string[] = [];
  const adapter = new PlaywrightVerificationNavigationAdapter({
    trace: (event) => events.push(event),
  });

  await adapter.navigate(page, new TextEncoder().encode(
    "https://tenant.wd5.myworkdayjobs.invalid/verify?token=private",
  ));

  assert.equal(page.emailSignInClicks, 1);
  assert.deepEqual(events, [
    "verification_navigation_goto_started",
    "verification_navigation_commit_succeeded",
    "verification_navigation_email_sign_in_started",
    "verification_navigation_email_sign_in_succeeded",
  ]);
});

test("invalid UTF-8 stops before a page effect", async () => {
  const page = new FakePage();
  const adapter = new PlaywrightVerificationNavigationAdapter();

  await assert.rejects(() => adapter.navigate(page, Uint8Array.of(0xff, 0xfe)), TypeError);

  assert.deepEqual(page.gotoCalls, []);
});

test("verification navigation emits a value-free failure after goto rejects", async () => {
  const events: string[] = [];
  const adapter = new PlaywrightVerificationNavigationAdapter({
    trace: (event) => events.push(event),
  });

  await assert.rejects(
    () => adapter.navigate(new ThrowingPage(), new TextEncoder().encode(
      "https://tenant.wd5.myworkdayjobs.invalid/verify?token=private",
    )),
    /synthetic navigation failure/u,
  );

  assert.deepEqual(events, [
    "verification_navigation_goto_started",
    "verification_navigation_goto_failed",
  ]);
});

class FakePage {
  readonly gotoCalls: unknown[] = [];
  emailSignInClicks = 0;
  #emailChoice: boolean;
  #emailDestination = false;

  constructor(emailChoice = false) { this.#emailChoice = emailChoice; }

  async goto(target: string, options?: { readonly waitUntil?: "commit" }): Promise<void> {
    this.gotoCalls.push({ target, options });
  }
  getByRole(role: string, options: { readonly name: string }) {
    const available = this.#emailChoice && role === "button" &&
      options.name === "Sign in with email";
    return new FakeLocator(available, () => {
      this.#emailChoice = false;
      this.#emailDestination = true;
      this.emailSignInClicks += 1;
    });
  }
  locator() { return new FakeLocator(this.#emailDestination); }
  isClosed(): boolean { return false; }
  async close(): Promise<void> {}
}

class FakeLocator {
  readonly #available: boolean;
  readonly #click: () => void;
  constructor(available: boolean, click = () => undefined) {
    this.#available = available;
    this.#click = click;
  }
  first() { return this; }
  nth() { return this; }
  async waitFor(): Promise<void> {
    if (!this.#available) throw new Error("synthetic absent locator");
  }
  async count(): Promise<number> { return this.#available ? 1 : 0; }
  async isVisible(): Promise<boolean> { return this.#available; }
  async isEnabled(): Promise<boolean> { return this.#available; }
  async click(): Promise<void> { this.#click(); }
}

class ThrowingPage extends FakePage {
  override async goto(): Promise<void> {
    throw new Error("synthetic navigation failure");
  }
}
