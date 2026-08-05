import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { corpusManifestFromCsv } from "../src/corpus/manifest/index.ts";

const root = resolve(import.meta.dirname, "..");
const reconciliation = JSON.parse(
  readFileSync(resolve(root, "corpus/workday-40/source-reconciliation.json"), "utf8"),
) as {
  sourceRevision: string;
  evidenceDigests: string[];
  unavailableSlots: Record<string, "maintenance" | "removed" | "closed" | "not_found" | "access_control">;
};
const manifest = corpusManifestFromCsv({
  csv: readFileSync(resolve(root, "../wd_test_jobs.csv"), "utf8"),
  sourceRevision: reconciliation.sourceRevision,
  evidenceDigests: reconciliation.evidenceDigests,
  unavailableSlots: new Map(
    Object.entries(reconciliation.unavailableSlots).map(([slot, reason]) => [Number(slot), reason]),
  ),
});
writeFileSync(
  resolve(root, "corpus/workday-40/manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { encoding: "utf8", flag: "w" },
);
