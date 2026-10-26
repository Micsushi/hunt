import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { normalizeCapture } from "../src/corpus/capture/index.ts";
import { frozenDigest } from "../src/corpus/shared.ts";

const root = resolve(import.meta.dirname, "../fixtures/workday/corpus");
const fixtures = readdirSync(root)
  .filter((file) => file !== "manifest.json" && file.endsWith(".json"))
  .sort()
  .map((file) => {
    const fixture = normalizeCapture(JSON.parse(readFileSync(resolve(root, file), "utf8")));
    writeFileSync(resolve(root, file), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    return {
      id: fixture.fixtureId,
      path: file,
      semanticHash: fixture.semanticHash,
      provingSlots: fixture.provingSlots,
      variantIds: fixture.variantIds,
      captureRevision: fixture.captureRevision,
    };
  });
const manifest = {
  schemaVersion: 1,
  fixtureSet: "workday-40",
  fixtures,
  freeze: { algorithm: "sha256", digest: "" },
};
manifest.freeze.digest = frozenDigest(manifest);
writeFileSync(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
