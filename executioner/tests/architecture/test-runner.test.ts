import assert from "node:assert/strict";
import { test } from "node:test";

import { testTargets } from "../runner.ts";

test("explicit test targets reject empty directories and non-test files", () => {
  for (const [target, reason] of [
    ["tests/architecture/empty", /No test files found in tests\/architecture\/empty/],
    ["tests/run.ts", /Test file must match \*\.test\.ts: tests\/run\.ts/],
  ] as const) {
    assert.throws(() => testTargets([target]), reason, target);
  }
});
