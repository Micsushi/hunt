import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("account bootstrap output and process surfaces remain value-free", async () => {
  const [helper, coordinator, script] = await Promise.all([
    readFile("src/secrets/windows-dpapi/private/interactive-account-sealer.ts", "utf8"),
    readFile("src/composition/s2-account-bootstrap.ts", "utf8"),
    readFile("scripts/provision-s2-account.ts", "utf8"),
  ]);
  assert.doesNotMatch(helper, /process\.env|process\.argv/u);
  assert.match(helper, /env:\s*\{\s*SystemRoot:/u);
  assert.doesNotMatch(helper, /stderr|Write-(?:Output|Error|Host)/iu);
  assert.doesNotMatch(coordinator, /readdir|opendir|glob/iu);
  assert.doesNotMatch(script, /console\.(?:log|error)|stderr/iu);
  assert.match(script, /JSON\.stringify\(result\)/u);
});
