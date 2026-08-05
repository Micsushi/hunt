import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  corpusManifestFromCsv,
  validateCorpusManifest,
} from "../src/corpus/manifest/index.ts";
import { canonicalJson, sha256 } from "../src/corpus/shared.ts";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "corpus/workday-40/manifest.json"), "utf8"));
const reconciliation = JSON.parse(
  readFileSync(resolve(root, "corpus/workday-40/source-reconciliation.json"), "utf8"),
) as {
  sourceRevision: string;
  sourceDigest: string;
  evidenceDigests: string[];
  availableSlots: number[];
  unavailableSlots: Record<string, "maintenance" | "removed" | "closed" | "not_found" | "access_control">;
};
const csv = readFileSync(resolve(root, "../wd_test_jobs.csv"), "utf8");
assert.equal(sha256(csv), reconciliation.sourceDigest, "frozen source CSV digest changed");
const reconciled = corpusManifestFromCsv({
  csv,
  sourceRevision: reconciliation.sourceRevision,
  evidenceDigests: reconciliation.evidenceDigests,
  unavailableSlots: new Map(
    Object.entries(reconciliation.unavailableSlots).map(([slot, reason]) => [Number(slot), reason]),
  ),
});
assert.deepEqual(validateCorpusManifest(manifest), []);
assert.equal(canonicalJson(manifest), canonicalJson(reconciled), "manifest does not match source reconciliation");
assert.equal(reconciliation.availableSlots.length + Object.keys(reconciliation.unavailableSlots).length, 40);
process.stdout.write(`${manifest.freeze.digest} 40 slots validated\n`);
