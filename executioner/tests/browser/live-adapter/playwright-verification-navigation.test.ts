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
  ]);
  assert.deepEqual(Object.keys(adapter), []);
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
  async goto(target: string, options?: { readonly waitUntil?: "commit" }): Promise<void> {
    this.gotoCalls.push({ target, options });
  }
  isClosed(): boolean { return false; }
  async close(): Promise<void> {}
}

class ThrowingPage extends FakePage {
  override async goto(): Promise<void> {
    throw new Error("synthetic navigation failure");
  }
}
