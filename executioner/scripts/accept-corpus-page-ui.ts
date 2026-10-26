import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validatePageUiPlan } from "../src/corpus/page-ui-plan/index.ts";
import {
  createPageUiExecutionRecord,
  pageUiImplementationDigest,
  validatePageUiExecutionRecord,
} from "../src/corpus/page-ui-plan/execution.ts";

interface PlanRow {
  readonly id: string;
  readonly testModule: string;
  readonly regressionModules: readonly string[];
}

const root = resolve(import.meta.dirname, "..");
if (process.argv.length !== 2) throw new TypeError("corpus:page-ui:accept accepts no arguments");
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const plan = readJson("corpus/workday-40/page-ui-variants.json") as { variants: readonly PlanRow[] };
assert.deepEqual(validatePageUiPlan(
  plan,
  readJson("corpus/workday-40/contract-impact.json"),
  readJson("corpus/workday-40/variants.json"),
  readJson("fixtures/workday/corpus/manifest.json"),
  root,
), []);
const implementationDigest = pageUiImplementationDigest(root, plan);
const executed: string[] = [];
for (const row of plan.variants) {
  const variant = spawnSync(process.execPath, [
    "tests/run.ts",
    "tests/corpus/page-ui-plan",
    row.testModule,
    ...row.regressionModules,
  ], { cwd: root, stdio: "inherit" });
  if (variant.status !== 0) {
    process.exitCode = variant.status ?? 1;
    process.exit();
  }
  executed.push(row.id);
}
const record = createPageUiExecutionRecord(plan, implementationDigest, executed);
assert.deepEqual(validatePageUiExecutionRecord(record, plan, pageUiImplementationDigest(root, plan)), []);
const targets = [
  "tests/acceptance/s3-page-ui",
  "tests/security/privacy",
  "tests/security/admission",
  "tests/architecture",
  "tests/corpus/contract-impact",
  "tests/corpus/runner",
];
const result = spawnSync(process.execPath, ["tests/run.ts", ...targets], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, HUNT_PAGE_UI_EXECUTION_RECORD: JSON.stringify(record) },
});
process.exitCode = result.status ?? 1;
if (result.status === 0) process.stdout.write(`${implementationDigest} 52 variant-slot executions reconciled\n`);
