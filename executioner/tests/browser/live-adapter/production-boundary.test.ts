import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
