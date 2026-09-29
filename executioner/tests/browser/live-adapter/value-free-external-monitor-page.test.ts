import assert from "node:assert/strict";
import test from "node:test";

import {
  valueFreeExternalMonitorPage,
  valueFreeMonitorMaskSelectors,
} from "../../../src/browser/playwright-live/private/value-free-external-monitor-page.ts";

test("external monitor screenshots mask every value-bearing control family", async () => {
  let screenshotOptions: Record<string, unknown> | undefined;
  let viewportRestored = false;
  const page = {
    async evaluate(callback: () => void) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        scrollTo(options: unknown) {
          assert.deepEqual(options, { top: 0, left: 0, behavior: "instant" });
          viewportRestored = true;
        },
      } });
      try { callback(); } finally {
        if (previous) Object.defineProperty(globalThis, "window", previous);
        else Reflect.deleteProperty(globalThis, "window");
      }
    },
    locator(selector: string) { return { selector }; },
    async screenshot(options: Record<string, unknown>) {
      assert.equal(viewportRestored, true);
      screenshotOptions = options;
      return Buffer.from("png");
    },
    async title() { return "Sign In"; },
    url() { return "https://tenant.invalid/job/example"; },
  };

  const monitor = valueFreeExternalMonitorPage(page as never);
  assert.deepEqual(await monitor.screenshot({ type: "png", fullPage: true }), Buffer.from("png"));
  assert.equal(await monitor.title(), "Sign In");
  assert.equal(await monitor.url(), "https://tenant.invalid/job/example");
  assert.equal(screenshotOptions?.maskColor, "#6B7280");
  assert.deepEqual(
    (screenshotOptions?.mask as readonly { readonly selector: string }[])
      .map(({ selector }) => selector),
    valueFreeMonitorMaskSelectors,
  );
});
