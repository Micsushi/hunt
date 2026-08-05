import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  affectedSlotsForVariant,
  buildImpactMap,
  validateImpactMap,
} from "../../../src/corpus/impact-map/index.ts";
import { frozenDigest } from "../../../src/corpus/shared.ts";

test("the mapping generator derives fixture and slot impact without employer branches", () => {
  const fixtureManifest = {
    fixtures: [
      { id: "fixture-a", provingSlots: ["WD40-002", "WD40-001"], variantIds: ["WD-PAGE-AUTH-ACTION-V1"] },
    ],
    freeze: { digest: "sha256." + "a".repeat(64) },
  };
  const map = buildImpactMap(fixtureManifest, [
    {
      id: "WD-PAGE-AUTH-ACTION-V1",
      category: "page",
      ownerCategory: "workday-auth-page",
      primitiveIds: ["page.auth.action"],
      productionModules: ["src/account/entry/adapter.ts"],
      dependsOn: [],
    },
  ]);
  assert.deepEqual(affectedSlotsForVariant(map, "WD-PAGE-AUTH-ACTION-V1"), ["WD40-001", "WD40-002"]);
  assert.equal(JSON.stringify(map).includes("Company"), false);
});

test("orphan fixture IDs and dependency cycles are rejected", () => {
  const map = {
    schemaVersion: 1,
    taxonomyId: "workday-corpus-v1",
    fixtureManifestHash: "sha256." + "a".repeat(64),
    variants: [
      {
        id: "WD-PAGE-A-V1",
        category: "page",
        ownerCategory: "page-owner",
        status: "observed",
        fixtureIds: ["missing"],
        primitiveIds: ["page.a"],
        productionModules: ["src/a.ts"],
        affectedSlots: ["WD40-001"],
        dependsOn: ["WD-PAGE-B-V1"],
      },
      {
        id: "WD-PAGE-B-V1",
        category: "page",
        ownerCategory: "page-owner",
        status: "observed",
        fixtureIds: ["missing"],
        primitiveIds: ["page.b"],
        productionModules: ["src/b.ts"],
        affectedSlots: ["WD40-001"],
        dependsOn: ["WD-PAGE-A-V1"],
      },
    ],
    freeze: { algorithm: "sha256", digest: "sha256." + "0".repeat(64) },
  };
  const errors = validateImpactMap(map, { fixtures: [] }, { slots: [{ slotId: "WD40-001" }] });
  assert.ok(errors.includes("variant WD-PAGE-A-V1 references unknown fixture missing"));
  assert.ok(errors.includes("variant dependency graph contains a cycle"));
});

test("taxonomy rows cannot carry employer-specific branches", () => {
  const map = JSON.parse(readFileSync(resolve("corpus/workday-40/variants.json"), "utf8"));
  map.variants[0].employer = "tenant-specific-branch";
  map.freeze.digest = frozenDigest(map);
  const fixtures = JSON.parse(readFileSync(resolve("fixtures/workday/corpus/manifest.json"), "utf8"));
  const corpus = JSON.parse(readFileSync(resolve("corpus/workday-40/manifest.json"), "utf8"));
  assert.ok(validateImpactMap(map, fixtures, corpus).includes(
    `variant ${map.variants[0].id} contains unsupported field employer`,
  ));
});

test("the committed taxonomy maps every fixture and affected slot", () => {
  const map = JSON.parse(readFileSync(resolve("corpus/workday-40/variants.json"), "utf8"));
  const fixtures = JSON.parse(readFileSync(resolve("fixtures/workday/corpus/manifest.json"), "utf8"));
  const corpus = JSON.parse(readFileSync(resolve("corpus/workday-40/manifest.json"), "utf8"));
  assert.deepEqual(validateImpactMap(map, fixtures, corpus, resolve(".")), []);
});
