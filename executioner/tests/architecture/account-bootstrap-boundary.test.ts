import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("account bootstrap has no Gmail, browser, secret enumeration, or secret CLI surface", async () => {
  const files = await Promise.all([
    readFile("src/composition/s2-account-bootstrap.ts", "utf8"),
    readFile("src/composition/s2-account-bootstrap-cli.ts", "utf8"),
    readFile("scripts/provision-s2-account.ts", "utf8"),
    readFile("src/secrets/windows-dpapi/private/exact-record-acl-protector.ts", "utf8"),
  ]);
  const source = files.join("\n");
  assert.doesNotMatch(source, /gmail|oauth|mailbox|playwright|chromium/iu);
  assert.doesNotMatch(source, /readdir|glob|opendir/iu);
  assert.doesNotMatch(source, /--(?:email|password|token|secret|credential)/iu);
  assert.doesNotMatch(source, /console\.(?:log|error)/u);
  assert.match(source, /--config/u);
  assert.match(source, /process\.stdout\.write/u);
  assert.match(source, /SetAccessRuleProtection\(true, false\)/u);
  assert.match(source, /S-1-5-18/u);
});
