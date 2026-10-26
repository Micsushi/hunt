import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("one-time v2 migration CLI accepts only pinned paths and a digest", async () => {
  const source = await readFile("scripts/migrate-s2-v2-account.ts", "utf8");
  assert.match(source, /--config/u);
  assert.match(source, /--legacy-source/u);
  assert.match(source, /--sha256/u);
  assert.match(source, /WindowsLegacyV2AccountSealer/u);
  assert.match(source, /runS2AccountBootstrapCli/u);
  assert.match(source, /bootstrapS2AccountSecret/u);
  assert.doesNotMatch(source, /accountEmail|accountPassword|PASSWORD|EMAIL/u);
});
