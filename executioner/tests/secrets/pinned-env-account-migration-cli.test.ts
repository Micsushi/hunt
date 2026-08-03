import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("one-time env migration CLI accepts only pinned paths and a digest", async () => {
  const source = await readFile("scripts/migrate-s2-env-account.ts", "utf8");
  assert.match(source, /--config/u);
  assert.match(source, /--env-source/u);
  assert.match(source, /--sha256/u);
  assert.match(source, /WindowsPinnedEnvAccountSealer/u);
  assert.match(source, /runS2AccountBootstrapCli/u);
  assert.match(source, /bootstrapS2AccountSecret/u);
  assert.doesNotMatch(source, /accountEmail|accountPassword|PASSWORD|EMAIL/u);
});
