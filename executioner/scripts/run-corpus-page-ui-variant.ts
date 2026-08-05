import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validatePageUiPlan } from "../src/corpus/page-ui-plan/index.ts";

interface PlanRow {
  readonly id: string;
  readonly testModule: string;
  readonly regressionModules: readonly string[];
}

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length !== 1) throw new TypeError("corpus:variant requires exactly one frozen variant ID");
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const plan = readJson("corpus/workday-40/page-ui-variants.json") as { variants: readonly PlanRow[] };
assert.deepEqual(validatePageUiPlan(
  plan,
  readJson("corpus/workday-40/contract-impact.json"),
  readJson("corpus/workday-40/variants.json"),
  readJson("fixtures/workday/corpus/manifest.json"),
  root,
), []);
const row = plan.variants.find(({ id }) => id === args[0]);
if (row === undefined) throw new TypeError(`unknown or unactivated page/UI variant: ${args[0]}`);
const result = spawnSync(process.execPath, [
  "tests/run.ts",
  "tests/corpus/page-ui-plan",
  row.testModule,
  ...row.regressionModules,
], { cwd: root, stdio: "inherit" });
process.exitCode = result.status ?? 1;
