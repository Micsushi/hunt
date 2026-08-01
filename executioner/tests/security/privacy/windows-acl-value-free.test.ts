import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ACL failures expose only stable closed target and reason identifiers", async () => {
  const source = await readFile("src/live/preflight/private/windows-acl.ts", "utf8");
  assert.doesNotMatch(source, /stderr/u);
  assert.doesNotMatch(source, /error\.message/u);
  assert.doesNotMatch(source, /throw new Error\([^)]*path/u);
  assert.match(source, /"runtime_root"/u);
  assert.match(source, /"owner_config"/u);
  assert.match(source, /"secret_record"/u);
});
