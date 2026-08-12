import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const tempProfilePath = await mkdtemp(join(tmpdir(), "hunt-launcher-profile-"));
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
    visibleLaunch: async (launchedProfilePath, window) => {
      order.push("launch");
      isolatedLaunches += 1;
      assert.equal(launchedProfilePath, tempProfilePath);
      assert.deepEqual(window, { x: 1747, y: 40, width: 1400, height: 832 });
      return context as never;
    },
    isolatedDesktop: async () => { order.push("attest"); },
    visibleWindow: () => ({ x: 1747, y: 40, width: 1400, height: 832 }),
  });

  try {
    await launcher.launchPersistentContext(tempProfilePath, { headless: false });
    assert.equal(directLaunches, 0);
    assert.equal(isolatedLaunches, 1);
    assert.deepEqual(order, ["attest", "launch"]);
  } finally {
    await rm(tempProfilePath, { recursive: true, force: true });
  }
});

test("default visible production launch receives the bounded native timeout", async () => {
  const tempProfilePath = await mkdtemp(join(tmpdir(), "hunt-launcher-visible-timeout-"));
  let launchOptions: Record<string, unknown> | undefined;
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
  const launcher = new PlaywrightPersistentContextLauncher({
    timeoutMs: 2_500,
    launch: async (_profilePath, options) => {
      launchOptions = options;
      return context as never;
    },
    isolatedDesktop: async () => undefined,
    visibleWindow: () => ({ x: 1747, y: 40, width: 1400, height: 832 }),
  });

  try {
    await launcher.launchPersistentContext(tempProfilePath, { headless: false });
    assert.equal(launchOptions?.headless, false);
    assert.equal(launchOptions?.timeout, 2_500);
    assert.equal(launchOptions?.viewport, null);
  } finally {
    await rm(tempProfilePath, { recursive: true, force: true });
  }
});

test("headless production launch receives the bounded native timeout", async () => {
  const tempProfilePath = await mkdtemp(join(tmpdir(), "hunt-launcher-headless-timeout-"));
  let launchOptions: Record<string, unknown> | undefined;
  const launcher = new PlaywrightPersistentContextLauncher({
    timeoutMs: 2_500,
    launch: async (_profilePath, options) => {
      launchOptions = options;
      return { pages: () => [] } as never;
    },
    visibleWindow: () => undefined,
  });

  try {
    await launcher.launchPersistentContext(tempProfilePath, { headless: true });
    assert.equal(launchOptions?.headless, true);
    assert.equal(launchOptions?.timeout, 2_500);
  } finally {
    await rm(tempProfilePath, { recursive: true, force: true });
  }
});

test("production launch disables Chrome password storage in the isolated profile", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "hunt-launcher-profile-"));
  const defaultPath = join(profilePath, "Default");
  await mkdir(defaultPath);
  await writeFile(join(defaultPath, "Preferences"), JSON.stringify({
    credentials_enable_service: true,
    profile: { password_manager_enabled: true, preserved: "yes" },
    preserved: { value: 7 },
  }));
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
  const launcher = new PlaywrightPersistentContextLauncher({
    launch: async (launchedProfilePath) => {
      const preferences = JSON.parse(
        await readFile(join(launchedProfilePath, "Default", "Preferences"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(preferences.credentials_enable_service, false);
      assert.deepEqual(preferences.profile, {
        password_manager_enabled: false,
        preserved: "yes",
      });
      assert.deepEqual(preferences.preserved, { value: 7 });
      return context as never;
    },
    isolatedDesktop: async () => undefined,
    visibleWindow: () => ({ x: 1747, y: 40, width: 1400, height: 832 }),
  });

  try {
    await launcher.launchPersistentContext(profilePath, { headless: false });
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
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
  const profilePath = await mkdtemp(join(tmpdir(), "hunt-launcher-profile-"));
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

  try {
    await assert.rejects(
      launcher.launchPersistentContext(profilePath, { headless: false }),
      /window safety cleanup failed/u,
    );
    assert.equal(closeCalls, 2);
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});
