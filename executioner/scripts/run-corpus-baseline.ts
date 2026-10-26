import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  createCorpusBaseline,
  validateBaselineReport,
  writeImmutableBaseline,
} from "../src/corpus/runner/index.ts";

const root = resolve(import.meta.dirname, "..");
const inputs = {
  manifest: JSON.parse(readFileSync(resolve(root, "corpus/workday-40/manifest.json"), "utf8")),
  fixtures: JSON.parse(readFileSync(resolve(root, "fixtures/workday/corpus/manifest.json"), "utf8")),
  variants: JSON.parse(readFileSync(resolve(root, "corpus/workday-40/variants.json"), "utf8")),
  sourceRevision: "16c48bd1470addc9d9480d785ae84e412edd55ef",
  fixtureRoot: resolve(root, "fixtures/workday/corpus"),
};
const first = createCorpusBaseline(inputs);
const second = createCorpusBaseline(inputs, first.outcomes.slice(0, 20));
assert.deepEqual(first, second, "unchanged corpus did not reproduce its baseline");
assert.deepEqual(validateBaselineReport(first, inputs), []);

const outputRoot = process.argv[2];
if (outputRoot !== undefined) {
  const output = resolve(outputRoot);
  const location = relative(root, output);
  if (!isAbsolute(location) && !location.startsWith("..")) throw new TypeError("baseline report root must be outside the repository package");
  process.stdout.write(`${writeImmutableBaseline(first, output)} ${first.reportHash}\n`);
} else {
  process.stdout.write(`${first.reportId} ${first.reportHash} 40 outcomes reproduced twice\n`);
}
