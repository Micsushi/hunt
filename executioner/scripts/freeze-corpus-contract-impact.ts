import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildContractImpact } from "../src/corpus/contract-impact/index.ts";
import { createCorpusBaseline } from "../src/corpus/runner/index.ts";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "corpus/workday-40/manifest.json"), "utf8"));
const fixtures = JSON.parse(readFileSync(resolve(root, "fixtures/workday/corpus/manifest.json"), "utf8"));
const variants = JSON.parse(readFileSync(resolve(root, "corpus/workday-40/variants.json"), "utf8"));
const baseline = createCorpusBaseline({
  manifest,
  fixtures,
  variants,
  sourceRevision: "16c48bd1470addc9d9480d785ae84e412edd55ef",
  fixtureRoot: resolve(root, "fixtures/workday/corpus"),
});
const impact = buildContractImpact({ manifest, fixtures, variants, baseline });
writeFileSync(resolve(root, "corpus/workday-40/contract-impact.json"), `${JSON.stringify(impact, null, 2)}\n`, "utf8");
