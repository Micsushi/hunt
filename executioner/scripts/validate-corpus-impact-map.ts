import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateImpactMap } from "../src/corpus/impact-map/index.ts";

const root = resolve(import.meta.dirname, "..");
const map = JSON.parse(readFileSync(resolve(root, "corpus/workday-40/variants.json"), "utf8"));
const fixtures = JSON.parse(readFileSync(resolve(root, "fixtures/workday/corpus/manifest.json"), "utf8"));
const corpus = JSON.parse(readFileSync(resolve(root, "corpus/workday-40/manifest.json"), "utf8"));
assert.deepEqual(validateImpactMap(map, fixtures, corpus, root), []);
process.stdout.write(`${map.freeze.digest} ${map.variants.length} variants mapped\n`);
