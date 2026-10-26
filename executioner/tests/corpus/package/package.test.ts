import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPackageSbom,
  findPackageContentViolations,
  verifyPackageManifest,
  verifyReproduciblePackage,
  verifyPackageFileList,
} from "../../../src/corpus/package/index.ts";

test("package allowlist keeps runtime source and excludes local corpus data", () => {
  assert.deepEqual(
    verifyPackageFileList([
      "package/package.json",
      "package/README.md",
      "package/dist/control/mcp/facade.js",
      "package/dist/evidence/store.js",
      "package/dist/control/mcp/facade.d.ts",
      "package/docs/corpus-release.md",
    ]),
    [],
  );
  assert.deepEqual(
    verifyPackageFileList([
      "package/package.json",
      "package/README.md",
      "package/dist/control/mcp/facade.js",
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

test("package checksum gate rejects non-reproducible output", () => {
  assert.deepEqual(verifyReproduciblePackage("a".repeat(64), "a".repeat(64)), []);
  assert.deepEqual(
    verifyReproduciblePackage("a".repeat(64), "b".repeat(64)),
    ["package_not_reproducible"],
  );
});

test("package manifest exposes only the approved MCP module", () => {
  assert.deepEqual(verifyPackageManifest({
    name: "@hunt/executioner",
    version: "3.0.0",
    private: true,
    exports: {
      "./mcp": {
        types: "./dist/control/mcp/index.d.ts",
        import: "./dist/control/mcp/index.js",
      },
    },
  }), []);
  assert.deepEqual(verifyPackageManifest({
    name: "@hunt/executioner",
    version: "3.0.0",
    private: true,
    exports: {
      "./mcp": {
        types: "./dist/control/mcp/index.d.ts",
        import: "./dist/control/mcp/index.js",
      },
      "./submit": "./src/submit.ts",
    },
  }), ["package_exports_invalid"]);
});

test("package content scan rejects private values even on allowlisted paths", () => {
  assert.deepEqual(
    findPackageContentViolations(new Map([
      ["README.md", "safe release notes"],
      ["src/index.ts", "const owner = 'person@candidate.invalid';"],
    ])),
    [],
  );
  assert.deepEqual(
    findPackageContentViolations(new Map([
      ["README.md", `contact person@${"example.com"}`],
      ["src/index.ts", `const value = '${"sk-"}${"123456789012345678901234"}';`],
    ])),
    ["README.md:real_email", "src/index.ts:secret_token"],
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
