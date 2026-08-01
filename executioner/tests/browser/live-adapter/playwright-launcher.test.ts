import assert from "node:assert/strict";
import test from "node:test";

import { PlaywrightPersistentContextLauncher } from "../../../src/browser/playwright-live/private/playwright-launcher.ts";

test("visible secondary launch starts minimized, restores by CDP, and never brings the page forward", async () => {
  const launchCalls: unknown[] = [];
  const cdpCalls: unknown[] = [];
  let detached = 0;
  const page = {};
  const context = {
    pages: () => [page],
    newPage: async () => page,
    newCDPSession: async () => ({
      send: async (method: string, params?: unknown) => {
        cdpCalls.push({ method, params });
        return method === "Browser.getWindowForTarget" ? { windowId: 77 } : {};
      },
      detach: async () => { detached += 1; },
    }),
  };
  const launcher = new PlaywrightPersistentContextLauncher({
    launch: async (profilePath, options) => {
      launchCalls.push({ profilePath, options });
      return context as never;
    },
    visibleWindow: () => ({ x: 1747, y: 40, width: 1400, height: 832 }),
  });

  assert.equal(
    await launcher.launchPersistentContext("C:\\safe-profile", { headless: false }),
    context,
  );
  assert.deepEqual(launchCalls, [{
    profilePath: "C:\\safe-profile",
    options: {
      headless: false,
      viewport: null,
      args: [
        "--start-minimized",
        "--window-position=1747,40",
        "--window-size=1400,832",
      ],
    },
  }]);
  assert.deepEqual(cdpCalls, [
    { method: "Browser.getWindowForTarget", params: undefined },
    {
      method: "Browser.setWindowBounds",
      params: {
        windowId: 77,
        bounds: {
          left: 1747,
          top: 40,
          width: 1400,
          height: 832,
          windowState: "normal",
        },
      },
    },
  ]);
  assert.equal(detached, 1);
});

test("ordinary launch keeps the existing Playwright behavior", async () => {
  const calls: unknown[] = [];
  const context = {};
  const launcher = new PlaywrightPersistentContextLauncher({
    launch: async (profilePath, options) => {
      calls.push({ profilePath, options });
      return context as never;
    },
    visibleWindow: () => undefined,
  });

  assert.equal(
    await launcher.launchPersistentContext("C:\\ordinary-profile", { headless: false }),
    context,
  );
  assert.deepEqual(calls, [{
    profilePath: "C:\\ordinary-profile",
    options: { headless: false },
  }]);
});
