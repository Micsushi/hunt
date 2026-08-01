import assert from "node:assert/strict";
import test from "node:test";

import {
  selectVisibleSecondaryWindow,
} from "../../../src/browser/playwright-live/private/windows-visible-secondary.ts";

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
