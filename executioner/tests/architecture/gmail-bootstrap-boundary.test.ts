import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Gmail bootstrap has no provider query, secret arguments, or enumeration surface", async () => {
  const source = (await Promise.all([
    readFile("src/composition/s2-gmail-bootstrap.ts", "utf8"),
    readFile("src/composition/s2-gmail-bootstrap-cli.ts", "utf8"),
    readFile("scripts/provision-s2-gmail.ts", "utf8"),
  ])).join("\n");
  assert.doesNotMatch(source, /messages|mailbox\/providers|readdir|glob|opendir/iu);
  assert.doesNotMatch(source, /--(?:email|sender|password|token|secret|client-secret)/iu);
  assert.doesNotMatch(source, /console\.(?:log|error)|stderr/iu);
  assert.match(source, /--config/u);
  assert.match(source, /--gmail-bootstrap/u);
  assert.match(source, /process\.stdout\.write/u);
});
