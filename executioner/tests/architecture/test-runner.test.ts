import assert from "node:assert/strict";
import { test } from "node:test";

import { testRunnerArgs, testTargets } from "../runner.ts";

test("the test runner bounds file concurrency", () => {
  assert.deepEqual(testRunnerArgs(["tests/architecture/test-runner.test.ts"]), [
    "--test",
    "--test-concurrency=4",
    "tests/architecture/test-runner.test.ts",
  ]);
});

test("an explicit directory with no tests is rejected", () => {
  assert.throws(
    () => testTargets(["tests/architecture/empty"]),
    /No test files found in tests\/architecture\/empty/,
  );
});

test("an explicit file must use the test filename", () => {
  assert.throws(
    () => testTargets(["tests/run.ts"]),
    /Test file must match \*\.test\.ts: tests\/run\.ts/,
  );
});
