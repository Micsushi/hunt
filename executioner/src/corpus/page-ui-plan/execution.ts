import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson, dataRecord, sha256Pattern } from "../shared.ts";

interface PlanRow {
  readonly id: string;
  readonly testModule: string;
  readonly affectedSlots: readonly string[];
  readonly fixturePath: string;
  readonly productionModules: readonly string[];
  readonly supportModules: readonly string[];
  readonly regressionModules: readonly string[];
}

export interface PageUiExecutionRecord {
  readonly schemaVersion: 1;
  readonly matrixId: "workday-40-page-ui-v1";
  readonly implementationDigest: string;
  readonly variants: readonly {
    readonly id: string;
    readonly testModule: string;
    readonly affectedSlots: readonly string[];
    readonly implementationDigest: string;
  }[];
}

export function pageUiImplementationDigest(root: string, planInput: unknown): string {
  const plan = requirePlan(planInput);
  const paths = [...new Set([
    "corpus/workday-40/page-ui-variants.json",
    "corpus/workday-40/contract-impact.json",
    "corpus/workday-40/variants.json",
    "fixtures/workday/corpus/manifest.json",
    ...plan.variants.flatMap((row) => [
      row.fixturePath,
      row.testModule,
      ...row.productionModules,
      ...row.supportModules,
      ...row.regressionModules,
    ]),
  ])].sort();
  const files = paths.map((path) => ({
    path,
    digest: createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex"),
  }));
  return `sha256.${createHash("sha256").update(canonicalJson(files)).digest("hex")}`;
}

export function createPageUiExecutionRecord(
  planInput: unknown,
  implementationDigest: string,
  executedVariantIds: readonly string[],
): PageUiExecutionRecord {
  const plan = requirePlan(planInput);
  const executed = new Set(executedVariantIds);
  return {
    schemaVersion: 1,
    matrixId: "workday-40-page-ui-v1",
    implementationDigest,
    variants: plan.variants
      .filter(({ id }) => executed.has(id))
      .map((row) => ({
        id: row.id,
        testModule: row.testModule,
        affectedSlots: [...row.affectedSlots],
        implementationDigest,
      })),
  };
}

export function validatePageUiExecutionRecord(
  input: unknown,
  planInput: unknown,
  expectedImplementationDigest: string,
): string[] {
  const errors: string[] = [];
  const plan = requirePlan(planInput);
  const record = dataRecord(input);
  if (
    record === null ||
    record.schemaVersion !== 1 ||
    record.matrixId !== "workday-40-page-ui-v1"
  ) return ["page/UI execution record header is invalid"];
  if (
    typeof record.implementationDigest !== "string" ||
    !sha256Pattern.test(record.implementationDigest) ||
    record.implementationDigest !== expectedImplementationDigest
  ) errors.push("page/UI execution record has the wrong implementation revision");
  const actual = Array.isArray(record.variants) ? record.variants.map(dataRecord) : [];
  if (actual.length !== plan.variants.length) errors.push("not every activated variant executed");
  const rows = new Map(actual
    .filter((row): row is Record<string, unknown> => typeof row?.id === "string")
    .map((row) => [row.id as string, row]));
  if (rows.size !== actual.length) errors.push("executed variants are invalid or duplicated");
  let pairCount = 0;
  for (const expected of plan.variants) {
    const row = rows.get(expected.id);
    if (
      row === undefined ||
      row.testModule !== expected.testModule ||
      canonicalJson(strings(row.affectedSlots)) !== canonicalJson([...expected.affectedSlots].sort()) ||
      row.implementationDigest !== expectedImplementationDigest
    ) {
      errors.push(`variant ${expected.id} has no exact execution proof`);
      continue;
    }
    pairCount += expected.affectedSlots.length;
  }
  if (pairCount !== 52) errors.push("execution proof does not cover the 52 frozen variant-slot pairs");
  return errors;
}

function requirePlan(input: unknown): { readonly variants: readonly PlanRow[] } {
  const plan = dataRecord(input);
  if (plan === null || !Array.isArray(plan.variants)) throw new TypeError("page/UI plan is invalid");
  return plan as unknown as { readonly variants: readonly PlanRow[] };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").sort()
    : [];
}
