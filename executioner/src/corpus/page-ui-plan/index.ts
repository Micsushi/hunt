import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson, dataRecord, frozenDigest, sha256Pattern } from "../shared.ts";

const activatedTasks = new Set(["S3-F2-T2", "S3-F2-T3", "S3-F2-T5", "S3-F2-T7"]);
const unactivatedTasks = ["S3-F2-T4", "S3-F2-T6", "S3-F2-T8", "S3-F2-T9", "S3-F2-T10", "S3-F2-T11", "S3-F2-T12"];
const supportModules = new Map<string, readonly string[]>([
  ["WD-PAGE-AUTH-ACTION-V1", [
    "src/browser/playwright-live/private/playwright-account-page.ts",
    "src/browser/playwright-live/private/workday-structural-catalog.ts",
  ]],
  ["WD-PAGE-EXTERNAL-STATE-V1", [
    "src/browser/playwright-live/private/workday-owned-target-probe.ts",
    "src/browser/playwright-live/private/workday-structural-catalog.ts",
  ]],
  ["WD-UI-SCALAR-COMPOSITE-V1", [
    "src/browser/adapter.ts",
    "src/interaction/verification/field-verifier.ts",
  ]],
  ["WD-UI-SOURCE-SELECT-V1", [
    "src/browser/adapter.ts",
    "src/interaction/verification/field-verifier.ts",
  ]],
]);

export function validatePageUiPlan(
  input: unknown,
  impactInput: unknown,
  variantsInput: unknown,
  fixturesInput: unknown,
  executionerRoot?: string,
): string[] {
  const errors: string[] = [];
  const plan = dataRecord(input);
  const impact = dataRecord(impactInput);
  const variantMap = dataRecord(variantsInput);
  const fixtureManifest = dataRecord(fixturesInput);
  if (plan === null || plan.schemaVersion !== 1 || plan.planId !== "workday-40-page-ui-v1") {
    return ["page/UI plan header is invalid"];
  }
  rejectExtra(plan, ["schemaVersion", "planId", "impactSha", "contractReopen", "unactivatedTaskIds", "variants", "freeze"], "page/UI plan", errors);
  if (plan.impactSha !== impact?.impactSha) errors.push("impactSha does not match the frozen contract impact");
  if (plan.contractReopen !== false || dataRecord(impact?.contractReopen)?.required !== false) {
    errors.push("page/UI closure requires a forbidden contract reopen");
  }
  if (canonicalJson(strings(plan.unactivatedTaskIds)) !== canonicalJson([...unactivatedTasks].sort())) {
    errors.push("unactivated task residuals do not match the frozen impact");
  }

  const sourceVariants = new Map(
    records(variantMap?.variants)
      .filter((row): row is Record<string, unknown> => typeof row?.id === "string")
      .map((row) => [row.id as string, row]),
  );
  const fixtures = new Map(
    records(fixtureManifest?.fixtures)
      .filter((row): row is Record<string, unknown> => typeof row?.id === "string")
      .map((row) => [row.id as string, row]),
  );
  const activations = new Map(
    records(impact?.taskActivations)
      .filter((row): row is Record<string, unknown> => typeof row?.taskId === "string")
      .map((row) => [row.taskId as string, row]),
  );
  const expectedByVariant = new Map<string, string>();
  for (const taskId of activatedTasks) {
    const activation = activations.get(taskId);
    if (activation?.decision !== "activated") {
      errors.push(`required task ${taskId} is not activated by the frozen impact`);
      continue;
    }
    for (const variantId of strings(activation.variantIds)) expectedByVariant.set(variantId, taskId);
  }
  for (const taskId of unactivatedTasks) {
    if (activations.get(taskId)?.decision !== "not-activated") {
      errors.push(`residual task ${taskId} is not frozen as not-activated`);
    }
  }
  const t13 = activations.get("S3-F2-T13");
  if (
    t13?.decision !== "activated" ||
    canonicalJson(strings(t13.exactDependencies)) !== canonicalJson([...activatedTasks])
  ) errors.push("S3-F2-T13 dependencies do not match the activated behavior tasks");

  const rows = records(plan.variants);
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row === null || typeof row.id !== "string") {
      errors.push(`variants[${index}] is invalid`);
      continue;
    }
    const id = row.id;
    rejectExtra(
      row,
      ["id", "taskId", "ownerRole", "fixtureId", "fixturePath", "semanticHash", "productionModules", "supportModules", "affectedSlots", "testModule", "regressionModules"],
      `variant ${id}`,
      errors,
    );
    if (seen.has(id)) errors.push(`variant ${id} is duplicated`);
    seen.add(id);
    const expectedTask = expectedByVariant.get(id);
    if (expectedTask === undefined) {
      errors.push(`variant ${id} is not activated by the frozen impact`);
      continue;
    }
    if (row.taskId !== expectedTask || !activatedTasks.has(String(row.taskId))) {
      errors.push(`variant ${id} does not map to activated task ${expectedTask}`);
    }
    const activation = activations.get(expectedTask);
    if (
      activation?.status !== `activated@${String(impact?.impactSha)}` ||
      canonicalJson(strings(activation.variantIds)) !== canonicalJson([id]) ||
      canonicalJson(strings(activation.provingFixtures)) !== canonicalJson([String(row.fixtureId)]) ||
      canonicalJson(strings(activation.provingSlots)) !== canonicalJson(strings(row.affectedSlots)) ||
      canonicalJson(strings(activation.exactDependencies)) !== canonicalJson(["S3-F2-T1"]) ||
      canonicalJson(strings(activation.exactBlocks)) !== canonicalJson(["S3-F2-T13"])
    ) errors.push(`variant ${id} activation provenance does not match its owned row`);
    const source = sourceVariants.get(id);
    if (source === undefined) {
      errors.push(`variant ${id} is absent from the frozen impact map`);
      continue;
    }
    if (row.ownerRole !== source.ownerCategory) errors.push(`variant ${id} ownerRole does not match the impact map`);
    if (canonicalJson(strings(row.productionModules)) !== canonicalJson(strings(source.productionModules))) {
      errors.push(`variant ${id} productionModules do not match the impact map`);
    }
    if (canonicalJson(strings(row.supportModules)) !== canonicalJson([...(supportModules.get(id) ?? [])].sort())) {
      errors.push(`variant ${id} supportModules do not match existing behavior owners`);
    }
    if (canonicalJson(strings(row.affectedSlots)) !== canonicalJson(strings(source.affectedSlots))) {
      errors.push(`variant ${id} affectedSlots do not match fixture provenance`);
    }
    const sourceFixtureIds = strings(source.fixtureIds);
    if (sourceFixtureIds.length !== 1 || row.fixtureId !== sourceFixtureIds[0]) {
      errors.push(`variant ${id} does not have one exact proving fixture`);
      continue;
    }
    const fixture = fixtures.get(sourceFixtureIds[0]!);
    const expectedPath = `fixtures/workday/corpus/${String(fixture?.path ?? "")}`;
    if (fixture === undefined || row.fixturePath !== expectedPath || row.semanticHash !== fixture.semanticHash) {
      errors.push(`variant ${id} fixture provenance does not match the frozen fixture manifest`);
    }
    if (executionerRoot !== undefined) {
      for (const path of [row.fixturePath, row.testModule, ...strings(row.regressionModules), ...strings(row.productionModules), ...strings(row.supportModules)]) {
        if (typeof path !== "string" || !existsSync(resolve(executionerRoot, path))) {
          errors.push(`variant ${id} owned path is missing: ${String(path)}`);
        }
      }
    }
  }
  for (const [id] of expectedByVariant) if (!seen.has(id)) errors.push(`activated variant ${id} is unowned`);
  if (seen.size !== expectedByVariant.size) errors.push("page/UI plan contains unresolved or missing variants");
  const ownedIds = [...seen].sort();
  const ownedFixtures = rows.map((row) => row?.fixtureId).filter((value): value is string => typeof value === "string").sort();
  const ownedSlots = [...new Set(rows.flatMap((row) => strings(row?.affectedSlots)))].sort();
  for (const gateId of ["S3-F2-T1", "S3-F2-T13"]) {
    const gate = activations.get(gateId);
    if (
      gate?.status !== `activated@${String(impact?.impactSha)}` ||
      canonicalJson(strings(gate.variantIds)) !== canonicalJson(ownedIds) ||
      canonicalJson(strings(gate.provingFixtures)) !== canonicalJson(ownedFixtures) ||
      canonicalJson(strings(gate.provingSlots)) !== canonicalJson(ownedSlots)
    ) errors.push(`${gateId} gate provenance does not match the owned matrix`);
  }

  const freeze = dataRecord(plan.freeze);
  if (
    freeze?.algorithm !== "sha256" ||
    typeof freeze.digest !== "string" ||
    !sha256Pattern.test(freeze.digest) ||
    freeze.digest !== frozenDigest(plan)
  ) errors.push("page/UI plan freeze is invalid");
  return errors;
}

function records(value: unknown): Array<Record<string, unknown> | null> {
  return Array.isArray(value) ? value.map(dataRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").sort()
    : [];
}

function rejectExtra(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record).filter((key) => !allowedSet.has(key)).sort()) {
    errors.push(`${label} contains unsupported field ${key}`);
  }
}
