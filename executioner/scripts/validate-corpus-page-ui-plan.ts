import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validatePageUiPlan } from "../src/corpus/page-ui-plan/index.ts";

const root = resolve(import.meta.dirname, "..");
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const plan = readJson("corpus/workday-40/page-ui-variants.json");
assert.deepEqual(validatePageUiPlan(
  plan,
  readJson("corpus/workday-40/contract-impact.json"),
  readJson("corpus/workday-40/variants.json"),
  readJson("fixtures/workday/corpus/manifest.json"),
  root,
), []);
process.stdout.write(`${(plan as { freeze: { digest: string } }).freeze.digest} 4 activated page/UI variants owned\n`);
