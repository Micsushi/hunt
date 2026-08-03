import assert from "node:assert/strict";
import test from "node:test";

import {
  PlaywrightPersistentContextLauncher,
  verifyMinimizedSecondaryWindow,
} from "../../../src/browser/playwright-live/private/playwright-launcher.ts";

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
      method: "Browser.setWindowBounds",
      params: { windowId: 77, bounds: { windowState: "minimized" } },
    },
    {
      method: "Browser.getWindowBounds",
      params: { windowId: 77 },
    },
  ]);
  assert.equal(detached, 1);
});

test("secondary launch accepts minimized restored bounds contained by the approved window", async () => {
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
            height: 810,
            windowState: "minimized",
          },
        },
      detach: async () => undefined,
    }),
  };

  await verifyMinimizedSecondaryWindow(context as never, {
    x: 1747,
    y: 40,
    width: 1400,
    height: 832,
  });
});

test("secondary launch accepts uniformly DPI-scaled minimized bounds", async () => {
  const page = {};
  const context = {
    pages: () => [page],
    newPage: async () => page,
    newCDPSession: async () => ({
      send: async (method: string) => method === "Browser.getWindowForTarget"
        ? { windowId: 77 }
        : {
          bounds: {
            left: 1734,
            top: 27,
            width: 934,
            height: 668,
            windowState: "minimized",
          },
        },
      detach: async () => undefined,
    }),
  };

  await verifyMinimizedSecondaryWindow(context as never, {
    x: 2600,
    y: 40,
    width: 1400,
    height: 1000,
  });
});

test("visible secondary launch attests isolation before Playwright launch", async () => {
  let directLaunches = 0;
  let isolatedLaunches = 0;
  const order: string[] = [];
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
            height: 810,
            windowState: "minimized",
          },
        },
      detach: async () => undefined,
    }),
    close: async () => undefined,
  };
  const launcher = new PlaywrightPersistentContextLauncher({
    launch: async () => {
      directLaunches += 1;
      return context as never;
    },
    visibleLaunch: async (profilePath, window) => {
      order.push("launch");
      isolatedLaunches += 1;
      assert.equal(profilePath, "C:\\safe-profile");
      assert.deepEqual(window, { x: 1747, y: 40, width: 1400, height: 832 });
      return context as never;
    },
    isolatedDesktop: async () => { order.push("attest"); },
    visibleWindow: () => ({ x: 1747, y: 40, width: 1400, height: 832 }),
  });

  await launcher.launchPersistentContext("C:\\safe-profile", { headless: false });

  assert.equal(directLaunches, 0);
  assert.equal(isolatedLaunches, 1);
  assert.deepEqual(order, ["attest", "launch"]);
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
    visibleLaunch: async () => context as never,
    isolatedDesktop: async () => undefined,
    visibleWindow: () => ({ x: 1747, y: 40, width: 1400, height: 832 }),
  });

  await assert.rejects(
    launcher.launchPersistentContext("C:\\safe-profile", { headless: false }),
    /window safety cleanup failed/u,
  );
  assert.equal(closeCalls, 2);
});
