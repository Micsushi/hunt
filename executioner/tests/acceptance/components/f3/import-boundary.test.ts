import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("F3 production imports only contracts, shared deterministic policy, Playwright, and its own implementation", () => {
  for (const file of ["src/browser/adapter.ts", "src/browser/session.ts"]) {
    const source = readFileSync(file, "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
    assert.equal(imports.some((specifier) =>
      specifier?.startsWith("../") &&
      !specifier.startsWith("../contracts/") &&
      !specifier.startsWith("../deterministic/")
    ), false, file);
  }
});
