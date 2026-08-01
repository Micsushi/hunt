import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Gmail bootstrap keeps OAuth and mailbox values inside the trusted child", async () => {
  const [child, coordinator, cli] = await Promise.all([
    readFile("src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts", "utf8"),
    readFile("src/composition/s2-gmail-bootstrap.ts", "utf8"),
    readFile("src/composition/s2-gmail-bootstrap-cli.ts", "utf8"),
  ]);
  assert.doesNotMatch(child, /process\.env|process\.argv|client_secret/iu);
  assert.match(child, /env:\s*\{\s*SystemRoot:/u);
  assert.doesNotMatch(coordinator, /access_token|refresh_token|senderAddress|recipientAddress/u);
  assert.doesNotMatch(cli, /environment\[[^\]]+\]|process\.env\./u);
  assert.match(cli, /SECRET_ENVIRONMENT/u);
});
