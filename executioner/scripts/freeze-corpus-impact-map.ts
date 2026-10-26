import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildImpactMap, type VariantDeclaration } from "../src/corpus/impact-map/index.ts";

const root = resolve(import.meta.dirname, "..");
const fixtureManifest = JSON.parse(readFileSync(resolve(root, "fixtures/workday/corpus/manifest.json"), "utf8"));
const declarations = JSON.parse(readFileSync(resolve(root, "corpus/workday-40/variant-declarations.json"), "utf8")) as {
  variants: VariantDeclaration[];
};
const map = buildImpactMap(fixtureManifest, declarations.variants);
writeFileSync(resolve(root, "corpus/workday-40/variants.json"), `${JSON.stringify(map, null, 2)}\n`, "utf8");
