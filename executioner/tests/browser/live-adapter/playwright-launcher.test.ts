import assert from "node:assert/strict";
import test from "node:test";

import {
  PlaywrightPersistentContextLauncher,
  verifyMinimizedSecondaryWindow,
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

test("secondary launch verifies minimized bounds without restoring or focusing", async () => {
  const cdpCalls: unknown[] = [];
  let detached = 0;
  const page = {};
  const context = {
    pages: () => [page],
    newPage: async () => page,
    newCDPSession: async () => ({
      send: async (method: string, params?: unknown) => {
        cdpCalls.push({ method, params });
        if (method === "Browser.getWindowForTarget") return { windowId: 77 };
        if (method === "Browser.getWindowBounds") {
          return {
            bounds: {
              left: 1747,
              top: 40,
              width: 1400,
              height: 832,
              windowState: "minimized",
            },
          };
        }
        return {};
      },
      detach: async () => { detached += 1; },
    }),
  };
  await verifyMinimizedSecondaryWindow(context as never, {
    x: 1747,
    y: 40,
    width: 1400,
    height: 832,
  });
  assert.deepEqual(cdpCalls, [
    { method: "Browser.getWindowForTarget", params: undefined },
    {
      method: "Browser.getWindowBounds",
      params: { windowId: 77 },
    },
  ]);
  assert.equal(detached, 1);
});

test("secondary launch fails closed when Chrome restores the window", async () => {
  const page = {};
  const context = {
    pages: () => [page],
    newPage: async () => page,
    newCDPSession: async () => ({
      send: async (method: string) => method === "Browser.getWindowForTarget"
        ? { windowId: 77 }
        : {
          bounds: {
            left: 1747,
            top: 40,
            width: 1400,
            height: 832,
            windowState: "normal",
          },
        },
      detach: async () => undefined,
    }),
  };

  await assert.rejects(
    verifyMinimizedSecondaryWindow(context as never, {
      x: 1747,
      y: 40,
      width: 1400,
      height: 832,
    }),
    /did not remain minimized/u,
  );
});

test("unsafe-window cleanup retries and supersedes placement failure", async () => {
  let closeCalls = 0;
  const page = {};
  const context = {
    pages: () => [page],
    newPage: async () => page,
    newCDPSession: async () => ({
      send: async (method: string) => method === "Browser.getWindowForTarget"
        ? { windowId: 77 }
        : {
          bounds: {
            left: 40,
            top: 40,
            width: 1400,
            height: 832,
            windowState: "normal",
          },
        },
      detach: async () => undefined,
    }),
    close: async () => {
      closeCalls += 1;
      throw new Error("private browser close detail");
    },
  };
  const launcher = new PlaywrightPersistentContextLauncher({
    launch: async () => context as never,
    visibleWindow: () => ({ x: 1747, y: 40, width: 1400, height: 832 }),
  });

  await assert.rejects(
    launcher.launchPersistentContext("C:\\safe-profile", { headless: false }),
    /window safety cleanup failed/u,
  );
  assert.equal(closeCalls, 2);
});
