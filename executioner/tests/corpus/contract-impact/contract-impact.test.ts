import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  buildContractImpact,
  validateContractImpact,
} from "../../../src/corpus/contract-impact/index.ts";
import { createCorpusBaseline } from "../../../src/corpus/runner/index.ts";

function inputs() {
  const manifest = JSON.parse(readFileSync(resolve("corpus/workday-40/manifest.json"), "utf8"));
  const fixtures = JSON.parse(readFileSync(resolve("fixtures/workday/corpus/manifest.json"), "utf8"));
  const variants = JSON.parse(readFileSync(resolve("corpus/workday-40/variants.json"), "utf8"));
  const baseline = createCorpusBaseline({
    manifest,
    fixtures,
    variants,
    sourceRevision: "16c48bd1470addc9d9480d785ae84e412edd55ef",
    fixtureRoot: resolve("fixtures/workday/corpus"),
  });
  return { manifest, fixtures, variants, baseline };
}

test("the corpus evidence freezes a no-contract-delta impact with evidence-backed tasks", () => {
  const impact = buildContractImpact(inputs());
  assert.deepEqual(validateContractImpact(impact, inputs()), []);
  assert.equal(impact.contractReopen.required, false);
  assert.deepEqual(impact.allowedTerminalCodes, [
    "application_ready",
    "posting_unavailable:maintenance",
  ]);
  const activated = impact.taskActivations.filter((task: { decision: string }) => task.decision === "activated");
  assert.deepEqual(
    activated.map((task: { taskId: string }) => task.taskId),
    ["S3-F2-T1", "S3-F2-T2", "S3-F2-T3", "S3-F2-T5", "S3-F2-T7", "S3-F2-T13"],
  );
  for (const task of activated.filter((task: { taskId: string }) => !["S3-F2-T1", "S3-F2-T13"].includes(task.taskId))) {
    assert.ok(task.provingFixtures.length > 0);
    assert.ok(task.provingSlots.length > 0);
  }
  assert.ok(impact.taskActivations.every((task: { status: string }) => task.status.endsWith(impact.impactSha)));
});

test("activation graph reciprocity and impact SHA are mandatory", () => {
  const impact = buildContractImpact(inputs());
  const broken = structuredClone(impact);
  broken.taskActivations.find((task: { taskId: string }) => task.taskId === "S3-F2-T2")!.exactDependencies = [];
  const errors = validateContractImpact(broken, inputs());
  assert.ok(errors.includes("task graph link S3-F2-T1 -> S3-F2-T2 is nonreciprocal"));
  assert.ok(errors.includes("impactSha does not match frozen impact content"));
});

test("contract impact rows reject employer-specific metadata", () => {
  const impact = buildContractImpact(inputs());
  const broken = structuredClone(impact);
  (broken.taskActivations[0]! as unknown as Record<string, unknown>).employer = "tenant-specific-branch";
  assert.ok(validateContractImpact(broken, inputs()).includes(
    `task ${broken.taskActivations[0]!.taskId} contains unsupported field employer`,
  ));
});

test("the committed contract impact validates against the same baseline", () => {
  const impact = JSON.parse(readFileSync(resolve("corpus/workday-40/contract-impact.json"), "utf8"));
  assert.deepEqual(validateContractImpact(impact, inputs()), []);
});
