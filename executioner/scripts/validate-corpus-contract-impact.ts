import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateContractImpact } from "../src/corpus/contract-impact/index.ts";
import { createCorpusBaseline } from "../src/corpus/runner/index.ts";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "corpus/workday-40/manifest.json"), "utf8"));
const fixtures = JSON.parse(readFileSync(resolve(root, "fixtures/workday/corpus/manifest.json"), "utf8"));
const variants = JSON.parse(readFileSync(resolve(root, "corpus/workday-40/variants.json"), "utf8"));
const impact = JSON.parse(readFileSync(resolve(root, "corpus/workday-40/contract-impact.json"), "utf8"));
const acceptedS2 = JSON.parse(readFileSync(resolve(root, "docs/s2-contract-revision.json"), "utf8"));
const baseline = createCorpusBaseline({
  manifest,
  fixtures,
  variants,
  sourceRevision: "16c48bd1470addc9d9480d785ae84e412edd55ef",
  fixtureRoot: resolve(root, "fixtures/workday/corpus"),
});
assert.equal(impact.basis.acceptedS2ContractRevision, acceptedS2.s2ContractSource);
assert.equal(impact.basis.acceptedS2ContractTree, acceptedS2.s2ContractSourceTree);
assert.deepEqual(validateContractImpact(impact, { manifest, fixtures, variants, baseline }), []);
process.stdout.write(`${impact.impactSha} ${impact.taskActivations.length} candidate tasks frozen; no core contract reopen\n`);
