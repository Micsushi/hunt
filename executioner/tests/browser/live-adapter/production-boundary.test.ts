import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

test("production browser launch uses only a persistent Playwright context", async () => {
  const source = await readFile(
    new URL("../../../src/browser/playwright-live/private/playwright-launcher.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /chromium\.launchPersistentContext/u);
  for (const forbidden of [
    "connectOverCDP",
    "bringToFront",
    "storageState",
    "chrome://",
    "newContext(",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("all production live-browser files preserve the persistent-context boundary", async () => {
  const privateRoot = new URL(
    "../../../src/browser/playwright-live/private/",
    import.meta.url,
  );
  const sources = await Promise.all(
    (await readdir(privateRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => readFile(new URL(entry.name, privateRoot), "utf8")),
  );
  assert.equal(sources.join("\n").includes("connectOverCDP"), false);
});

test("public live-browser facade adds no frozen port or raw-page capability", async () => {
  const source = await readFile(
    new URL("../../../src/browser/playwright-live/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /createPlaywrightPersistentBrowserSession/u);
  for (const forbidden of ["PersistentPage", "OwnedTargetProbe", "Page", "targetUrl"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("production factory owns the Workday probe while tests retain constructor injection", async () => {
  const source = await readFile(
    new URL("../../../src/browser/playwright-live/factory.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /new WorkdayOwnedTargetProbe\(\)/u);
  assert.equal(source.includes("readonly probe:"), false);
  const session = await readFile(
    new URL("../../../src/browser/playwright-live/session.ts", import.meta.url),
    "utf8",
  );
  assert.match(session, /options\.probe/u);
});
