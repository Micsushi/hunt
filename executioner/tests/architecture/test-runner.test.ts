import assert from "node:assert/strict";
import { test } from "node:test";

import { testTargets } from "../runner.ts";

test("an explicit directory with no tests is rejected", () => {
  assert.throws(
    () => testTargets(["tests/architecture/empty"]),
    /No test files found in tests\/architecture\/empty/,
  );
});
