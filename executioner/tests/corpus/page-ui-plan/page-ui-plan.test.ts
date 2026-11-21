import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { validatePageUiPlan } from "../../../src/corpus/page-ui-plan/index.ts";

const root = resolve(import.meta.dirname, "../../..");
const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(root, path), "utf8"));

test("unactivated tasks and unowned variants fail closed", () => {
  const plan = readJson("corpus/workday-40/page-ui-variants.json") as {
    variants: Array<Record<string, unknown>>;
  };
  const impact = readJson("corpus/workday-40/contract-impact.json");
  const variants = readJson("corpus/workday-40/variants.json");
  const fixtures = readJson("fixtures/workday/corpus/manifest.json");
  plan.variants.push({
    id: "WD-PAGE-READINESS-V1",
    taskId: "S3-F2-T4",
    ownerRole: "page-completion-owner",
    fixtureId: "invented",
    affectedSlots: [],
    productionModules: [],
  });

  const errors = validatePageUiPlan(plan, impact, variants, fixtures, root);
  assert.ok(errors.includes("variant WD-PAGE-READINESS-V1 is not activated by the frozen impact"));
});
