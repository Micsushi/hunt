import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson, dataRecord, frozenDigest, sha256Pattern } from "../shared.ts";

export interface VariantDeclaration {
  readonly id: string;
  readonly category: "page" | "ui" | "question" | "answer" | "option";
  readonly ownerCategory: string;
  readonly primitiveIds: readonly string[];
  readonly productionModules: readonly string[];
  readonly dependsOn: readonly string[];
}

export interface ImpactMap {
  schemaVersion: 1;
  taxonomyId: "workday-corpus-v1";
  fixtureManifestHash: string;
  variants: Array<VariantDeclaration & {
    status: "observed";
    fixtureIds: string[];
    affectedSlots: string[];
  }>;
  freeze: { algorithm: "sha256"; digest: string };
}

export function buildImpactMap(fixtureManifestInput: unknown, declarations: readonly VariantDeclaration[]): ImpactMap {
  const fixtureManifest = dataRecord(fixtureManifestInput);
  const fixtures = Array.isArray(fixtureManifest?.fixtures) ? fixtureManifest.fixtures.map(dataRecord) : [];
  const variants = declarations.map((declaration) => {
    const provingFixtures = fixtures.filter((fixture) =>
      Array.isArray(fixture?.variantIds) && fixture.variantIds.includes(declaration.id),
    );
    return {
      ...declaration,
      status: "observed" as const,
      fixtureIds: provingFixtures
        .map((fixture) => fixture?.id)
        .filter((id): id is string => typeof id === "string")
        .sort(),
      affectedSlots: [...new Set(provingFixtures.flatMap((fixture) =>
        Array.isArray(fixture?.provingSlots)
          ? fixture.provingSlots.filter((slot): slot is string => typeof slot === "string")
          : [],
      ))].sort(),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const map: ImpactMap = {
    schemaVersion: 1,
    taxonomyId: "workday-corpus-v1",
    fixtureManifestHash: String(dataRecord(fixtureManifest?.freeze)?.digest ?? ""),
    variants,
    freeze: { algorithm: "sha256", digest: "" },
  };
  map.freeze.digest = frozenDigest(map);
  return map;
}

export function affectedSlotsForVariant(map: ImpactMap, variantId: string): string[] {
  return [...(map.variants.find((variant) => variant.id === variantId)?.affectedSlots ?? [])];
}

export function validateImpactMap(
  input: unknown,
  fixtureManifestInput: unknown,
  corpusInput: unknown,
  executionerRoot?: string,
): string[] {
  const errors: string[] = [];
  const map = dataRecord(input);
  const fixtureManifest = dataRecord(fixtureManifestInput);
  const corpus = dataRecord(corpusInput);
  if (map === null || map.schemaVersion !== 1 || map.taxonomyId !== "workday-corpus-v1") {
    return ["impact map header is invalid"];
  }
  rejectExtra(map, ["schemaVersion", "taxonomyId", "fixtureManifestHash", "variants", "freeze"], "impact map", errors);
  const fixtureHash = dataRecord(fixtureManifest?.freeze)?.digest;
  if (map.fixtureManifestHash !== fixtureHash) errors.push("fixtureManifestHash does not match the frozen fixture set");
  const fixtures = new Map(
    (Array.isArray(fixtureManifest?.fixtures) ? fixtureManifest.fixtures : [])
      .map(dataRecord)
      .filter((fixture): fixture is Record<string, unknown> => fixture !== null && typeof fixture.id === "string")
      .map((fixture) => [fixture.id as string, fixture]),
  );
  const corpusSlots = new Set(
    (Array.isArray(corpus?.slots) ? corpus.slots : [])
      .map(dataRecord)
      .map((slot) => slot?.slotId)
      .filter((slot): slot is string => typeof slot === "string"),
  );
  const variants = Array.isArray(map.variants) ? map.variants.map(dataRecord) : [];
  const variantIds = new Set<string>();
  for (const [index, variant] of variants.entries()) {
    if (variant === null || typeof variant.id !== "string") {
      errors.push(`variants[${index}] is invalid`);
      continue;
    }
    const id = variant.id;
    rejectExtra(
      variant,
      [
        "id", "category", "ownerCategory", "status", "fixtureIds", "primitiveIds",
        "productionModules", "affectedSlots", "dependsOn",
      ],
      `variant ${id}`,
      errors,
    );
    if (!/^WD-(?:PAGE|UI|QA|OPTION)-[A-Z0-9-]+-V\d+$/u.test(id)) errors.push(`variant ${id} has an invalid reusable ID`);
    if (variantIds.has(id)) errors.push(`variant ${id} is duplicated`);
    variantIds.add(id);
    if (!new Set(["page", "ui", "question", "answer", "option"]).has(String(variant.category))) errors.push(`variant ${id} has an invalid category`);
    if (typeof variant.ownerCategory !== "string" || !/^[a-z0-9][a-z0-9-]+$/u.test(variant.ownerCategory)) errors.push(`variant ${id} has no owner category`);
    if (variant.status !== "observed") errors.push(`variant ${id} is not observed`);
    const fixtureIds = stringArray(variant.fixtureIds);
    if (fixtureIds.length === 0) errors.push(`variant ${id} has no proving fixture`);
    const expectedSlots = new Set<string>();
    for (const fixtureId of fixtureIds) {
      const fixture = fixtures.get(fixtureId);
      if (fixture === undefined) {
        errors.push(`variant ${id} references unknown fixture ${fixtureId}`);
        continue;
      }
      if (!stringArray(fixture.variantIds).includes(id)) errors.push(`fixture ${fixtureId} does not reciprocate variant ${id}`);
      stringArray(fixture.provingSlots).forEach((slot) => expectedSlots.add(slot));
    }
    const affectedSlots = stringArray(variant.affectedSlots);
    if (canonicalJson(affectedSlots) !== canonicalJson([...expectedSlots].sort())) errors.push(`variant ${id} affectedSlots do not match fixture provenance`);
    for (const slot of affectedSlots) if (!corpusSlots.has(slot)) errors.push(`variant ${id} references unknown slot ${slot}`);
    if (stringArray(variant.primitiveIds).length === 0) errors.push(`variant ${id} has no primitive`);
    const modules = stringArray(variant.productionModules);
    if (modules.length === 0) errors.push(`variant ${id} has no production module`);
    if (executionerRoot !== undefined) {
      for (const module of modules) {
        if (!module.startsWith("src/") || !existsSync(resolve(executionerRoot, module))) errors.push(`variant ${id} production module is missing: ${module}`);
      }
    }
  }
  for (const fixture of fixtures.values()) {
    const fixtureId = String(fixture.id);
    const ids = stringArray(fixture.variantIds);
    if (ids.length === 0) errors.push(`fixture ${fixtureId} has no variant`);
    for (const id of ids) if (!variantIds.has(id)) errors.push(`fixture ${fixtureId} references unknown variant ${id}`);
  }
  if (hasCycle(variants)) errors.push("variant dependency graph contains a cycle");
  for (const variant of variants) {
    if (variant === null || typeof variant.id !== "string") continue;
    for (const dependency of stringArray(variant.dependsOn)) {
      if (!variantIds.has(dependency)) errors.push(`variant ${variant.id} depends on unknown variant ${dependency}`);
    }
  }
  const freeze = dataRecord(map.freeze);
  if (freeze?.algorithm !== "sha256" || typeof freeze.digest !== "string" || !sha256Pattern.test(freeze.digest) || freeze.digest !== frozenDigest(map)) {
    errors.push("impact map freeze is invalid");
  }
  return errors;
}

function hasCycle(variants: Array<Record<string, unknown> | null>): boolean {
  const graph = new Map<string, string[]>();
  for (const variant of variants) {
    if (typeof variant?.id === "string") graph.set(variant.id, stringArray(variant.dependsOn));
  }
  const active = new Set<string>();
  const complete = new Set<string>();
  function visit(id: string): boolean {
    if (active.has(id)) return true;
    if (complete.has(id)) return false;
    active.add(id);
    for (const child of graph.get(id) ?? []) if (graph.has(child) && visit(child)) return true;
    active.delete(id);
    complete.add(id);
    return false;
  }
  return [...graph.keys()].some(visit);
}

function stringArray(value: unknown): string[] {
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
