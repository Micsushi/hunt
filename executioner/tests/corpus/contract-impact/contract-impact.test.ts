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

test("contract impact validation reports altered dependencies, digest and unsupported metadata", () => {
  const baseline = inputs();
  const impact = buildContractImpact(baseline);
  const broken = structuredClone(impact);
  broken.taskActivations.find((task: { taskId: string }) => task.taskId === "S3-F2-T2")!.exactDependencies = [];
  const errors = validateContractImpact(broken, baseline);
  assert.ok(errors.includes("task graph link S3-F2-T1 -> S3-F2-T2 is nonreciprocal"));
  assert.ok(errors.includes("impactSha does not match frozen impact content"));

  const tagged = structuredClone(impact);
  (tagged.taskActivations[0]! as unknown as Record<string, unknown>).employer = "tenant-specific-branch";
  assert.ok(validateContractImpact(tagged, baseline).includes(`task ${tagged.taskActivations[0]!.taskId} contains unsupported field employer`));
});
