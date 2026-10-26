import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Windows ACL helper uses a constant hidden bounded binary process boundary", async () => {
  const source = await readFile("src/live/preflight/private/windows-acl.ts", "utf8");
  assert.match(source, /const WINDOWS_ACL_SCRIPT = String\.raw/u);
  assert.match(source, /shell:\s*false/u);
  assert.match(source, /windowsHide:\s*true/u);
  assert.match(source, /stdio:\s*\["pipe",\s*"pipe",\s*"ignore"\]/u);
  assert.match(source, /timeout:/u);
  assert.match(source, /maxBuffer:/u);
  assert.doesNotMatch(source, /exec\(|execFile\(/u);
});
