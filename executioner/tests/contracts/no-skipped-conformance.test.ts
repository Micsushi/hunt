import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  canonicalProbeRegistry,
  contractConformanceRegistry,
  executeContractScenarioRegistry,
} from "../../src/testing/contracts/index.ts";
import { portNames } from "../../src/contracts/index.ts";

test("every R2 port and both probe roots have executed mandatory nonempty coverage", async () => {
  assert.deepEqual(
    contractConformanceRegistry.map(({ name }) => name),
    portNames,
  );
  for (const entry of contractConformanceRegistry) {
    assert.ok(entry.operations.length > 0, `${entry.name} must have operations`);
    assert.equal(entry.skip, false, `${entry.name} must not be skipped`);
  }
  assert.equal(canonicalProbeRegistry.length, 2);
  const executed = await executeContractScenarioRegistry();
  assert.ok(executed.length >= 9);
  const covered = new Set(executed.flatMap(({ ports }) => ports));
  for (const port of portNames) {
    assert.ok(covered.has(port), `${port} must appear in a mandatory scenario`);
  }
  for (const probe of canonicalProbeRegistry) {
    assert.ok(covered.has(probe.root), `${probe.root} must appear in a mandatory scenario`);
  }
});

test("mandatory conformance and compatibility probe tests contain no skip marker", () => {
  const roots = [
    "tests/contracts/conformance",
    "tests/contracts/compatibility-probes",
  ];
  for (const root of roots) {
    const paths = testFiles(root);
    assert.ok(paths.length > 0, `${root} must contain tests`);
    for (const path of paths) {
    const source = readFileSync(path, "utf8");
      assert.match(source, /\btest\s*\(/u, `${path} must contain a test`);
      assert.doesNotMatch(
        source,
        /\b(?:test|describe|it)\.(?:skip|todo|only)\b|\b(?:skip|todo|only)\s*:\s*(?:true|["'])/u,
      );
    }
  }
});

function testFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}
