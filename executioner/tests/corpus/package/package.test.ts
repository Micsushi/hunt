import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPackageSbom,
  verifyPackageFileList,
} from "../../../src/corpus/package/index.ts";

test("package allowlist keeps runtime source and excludes local corpus data", () => {
  assert.deepEqual(
    verifyPackageFileList([
      "package/package.json",
      "package/README.md",
      "package/src/control/mcp/facade.ts",
      "package/src/evidence/store.ts",
      "package/docs/corpus-release.md",
    ]),
    [],
  );
  assert.deepEqual(
    verifyPackageFileList([
      "package/package.json",
      "package/README.md",
      "package/src/control/mcp/facade.ts",
      "package/tests/account.json",
      "package/fixtures/workday.json",
      "package/.runtime/evidence.json",
    ]),
    [
      "package/.runtime/evidence.json",
      "package/fixtures/workday.json",
      "package/tests/account.json",
    ],
  );
});

test("SBOM is deterministic and contains dependency coordinates only", () => {
  const sbom = createPackageSbom({
    name: "@hunt/executioner",
    version: "3.0.0",
    packages: {
      "": { name: "@hunt/executioner", version: "3.0.0" },
      "node_modules/playwright": { version: "1.62.1" },
    },
  });

  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.deepEqual(sbom.components, [
    { type: "library", name: "playwright", version: "1.62.1" },
  ]);
  assert.doesNotMatch(JSON.stringify(sbom), /path|account|profile|evidence/iu);
});
