import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateCorpusFixtures } from "../src/corpus/capture/index.ts";

const root = resolve(import.meta.dirname, "../fixtures/workday/corpus");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const corpus = JSON.parse(readFileSync(resolve(import.meta.dirname, "../corpus/workday-40/manifest.json"), "utf8"));
assert.deepEqual(validateCorpusFixtures(root, manifest, corpus), []);
process.stdout.write(`${manifest.freeze.digest} ${manifest.fixtures.length} fixtures validated offline\n`);
