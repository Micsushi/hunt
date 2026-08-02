import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mailbox checkpoint dispatch stays browser-free and evidence stays value-free", async () => {
  const script = await read("scripts/run-s2-acceptance.ts");
  const composition = await read("src/composition/s2-mailbox-candidate-runner.ts");
  const evidence = await read("src/live/evidence/mailbox-candidate-evidence.ts");
  assert.match(script, /checkpoint === "mailbox_candidate"/u);
  assert.match(script, /import\("\.\.\/src\/composition\/s2-mailbox-candidate-runner\.ts"\)/u);
  assert.match(script, /checkpoint === "account_verified"/u);
  assert.match(script, /import\("\.\.\/src\/composition\/s2-account-verified-runner\.ts"\)/u);
  assert.equal(composition.includes("browser/playwright-live"), false);
  assert.equal(composition.includes("s2-account-access-runner"), false);
  for (const forbidden of [
    "verificationHandle", "receivedTimeBucket", "expiresAt", "senderAddress",
    "recipientAddress", "messageId", "threadId", "rawUrl", "token", "body",
  ]) {
    assert.equal(evidence.includes(forbidden), false, forbidden);
  }
});

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}
