import assert from "node:assert/strict";
import test from "node:test";

import {
  revealVisibleWindow,
  visiblePersistentLaunchOptions,
} from "../../../src/browser/playwright-live/private/playwright-launcher.ts";

test("visible secondary launch options start minimized without foreground controls", () => {
  assert.deepEqual(
    visiblePersistentLaunchOptions({ x: 1747, y: 40, width: 1400, height: 832 }),
    {
      headless: false,
      viewport: null,
      args: [
        "--start-minimized",
        "--window-position=1747,40",
        "--window-size=1400,832",
      ],
    },
  );
});

test("visible secondary reveal uses CDP bounds and never brings the page forward", async () => {
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
  await revealVisibleWindow(context as never, {
    x: 1747,
    y: 40,
    width: 1400,
    height: 832,
  });
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
