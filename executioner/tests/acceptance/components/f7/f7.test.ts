import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { admitContractSnapshot } from "../../../../src/contracts/index.ts";
import { createFieldDriver } from "../../../../src/interaction/drivers/registry.ts";
import {
  assertProviderConformance,
  createBrowserSessionFake,
  createSafetyGuardFake,
} from "../../../../src/testing/contracts/index.ts";
import {
  dependencyViolations,
  sourceFiles,
} from "../../../architecture/dependency-rule.ts";

function admittingSafety() {
  return createSafetyGuardFake({
    admit: (request) =>
      admitContractSnapshot(
        request.input,
        "safety",
        request.binding,
      ) as never,
  });
}

test("the real field driver conforms to the frozen provider port", async () => {
  const safety = admittingSafety();
  const browser = createBrowserSessionFake();

  await assertProviderConformance(
    "FieldDriver",
    createFieldDriver(browser.port, safety.port),
  );

  assert.equal(safety.calls.length, 1);
  assert.equal(browser.calls.length, 1);
});

test("drivers use only contracts and expose no readback, raw mutation, or Submit path", () => {
  assert.deepEqual(
    dependencyViolations(sourceFiles("src/interaction/drivers")),
    [],
  );
  const source = readFileSync(
    "src/interaction/drivers/registry.ts",
    "utf8",
  );
  assert.doesNotMatch(source, /\.observe\s*\(/u);
  assert.doesNotMatch(source, /\.navigate\s*\(/u);
  assert.doesNotMatch(source, /kind:\s*["'](?:click|type|submit)["']/iu);
  assert.doesNotMatch(source, /resumeId\s*:/u);
  assert.doesNotMatch(source, /\.submit\s*\(/iu);
  assert.doesNotMatch(source, /console\.|logger|telemetry/iu);
  assert.doesNotMatch(source, /\[\.\.\.[^\]]+\]\.length/u);
});

test("F7 acceptance contains no skipped or placeholder test", () => {
  const files = [
    ...sourceFiles("tests/interaction/drivers"),
    ...sourceFiles("tests/acceptance/components/f7"),
  ];
  const skipCall = new RegExp(`\\.${"skip"}\\s*\\(`, "u");
  const todoCall = new RegExp(`\\.${"todo"}\\s*\\(`, "u");

  for (const file of files) {
    assert.doesNotMatch(file.source, skipCall, file.path);
    assert.doesNotMatch(file.source, todoCall, file.path);
  }
});
