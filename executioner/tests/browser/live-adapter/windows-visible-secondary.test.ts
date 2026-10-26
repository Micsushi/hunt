import assert from "node:assert/strict";
import test from "node:test";

import {
  requiresMinimizedSecondaryWindow,
  selectVisibleSecondaryWindow,
  windowsScreenDiscoveryScript,
} from "../../../src/browser/playwright-live/private/windows-visible-secondary.ts";

test("Windows live browser tests always require minimized secondary placement", () => {
  assert.equal(requiresMinimizedSecondaryWindow("win32"), true);
  assert.equal(requiresMinimizedSecondaryWindow("linux"), false);
});

test("screen discovery enables per-monitor DPI awareness before reading physical work areas", () => {
  const script = windowsScreenDiscoveryScript();
  const awarenessIndex = script.indexOf(
    "[HuntDpiAwareness]::SetThreadDpiAwarenessContext",
  );
  const enumerationIndex = script.indexOf("[System.Windows.Forms.Screen]::AllScreens");

  assert.notEqual(awarenessIndex, -1);
  assert.notEqual(enumerationIndex, -1);
  assert.ok(awarenessIndex < enumerationIndex);
});

test("physical 2560 by 1440 secondary contains the entire visible window", () => {
  const secondary = { primary: false, x: 2560, y: 0, width: 2560, height: 1440 };
  const window = selectVisibleSecondaryWindow([
    { primary: true, x: 0, y: 0, width: 2560, height: 1440 },
    secondary,
  ]);

  assert.deepEqual(window, { x: 2600, y: 40, width: 1400, height: 1000 });
  assert.ok(window.x >= secondary.x);
  assert.ok(window.y >= secondary.y);
  assert.ok(window.x + window.width <= secondary.x + secondary.width);
  assert.ok(window.y + window.height <= secondary.y + secondary.height);
});

test("visible inspection selects and clamps inside the rightmost non-primary monitor", () => {
  assert.deepEqual(selectVisibleSecondaryWindow([
    { primary: false, x: -1707, y: 0, width: 1707, height: 912 },
    { primary: true, x: 0, y: 0, width: 1707, height: 912 },
    { primary: false, x: 1707, y: 0, width: 1707, height: 912 },
  ]), {
    x: 1747,
    y: 40,
    width: 1400,
    height: 832,
  });
});

test("visible inspection refuses a primary-only desktop", () => {
  assert.throws(
    () => selectVisibleSecondaryWindow([
      { primary: true, x: 0, y: 0, width: 1920, height: 1040 },
    ]),
    /secondary monitor/u,
  );
});

test("visible inspection rejects malformed or undersized monitor geometry", () => {
  for (const screen of [
    { primary: false, x: 0.5, y: 0, width: 1707, height: 912 },
    { primary: false, x: 1707, y: 0, width: 600, height: 912 },
    { primary: false, x: 1707, y: 0, width: 1707, height: 400 },
  ]) {
    assert.throws(() => selectVisibleSecondaryWindow([screen]), /monitor geometry/u);
  }
});
