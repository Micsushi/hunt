import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name: string) =>
  readFile(
    new URL(`../../../../src/mailbox/providers/gmail/${name}`, import.meta.url),
    "utf8",
  );

test("the safe provider surface cannot name or export privileged Gmail values", async () => {
  const [provider, registry, barrel] = await Promise.all([
    source("provider.ts"),
    source("safe-artifact-registry.ts"),
    source("index.ts"),
  ]);
  for (const value of [provider, registry, barrel]) {
    assert.doesNotMatch(
      value,
      /\b(?:accessValue|senderAddress|recipientAddress|messageId|threadId|subject|headers|rawUrl|verificationUrl|verificationToken)\b/u,
    );
    assert.doesNotMatch(value, /(?:console\.|process\.|node:fs|writeFile|appendFile)/u);
  }
  assert.doesNotMatch(barrel, /(?:auth-executor|http-client|http-parser|private)/u);
});

test("the privileged implementation has no persistence, logging, environment, or retry surface", async () => {
  const [executor, client, parser, vault, consumer, navigator] = await Promise.all([
    source("auth-executor.ts"),
    source("http-client.ts"),
    source("http-parser.ts"),
    source("private/raw-artifact-vault.ts"),
    source("private/atomic-artifact-consumer.ts"),
    source("private/privileged-verification-navigator.ts"),
  ]);
  for (const value of [executor, client, parser, vault, consumer, navigator]) {
    assert.doesNotMatch(
      value,
      /(?:console\.|process\.|node:fs|node:path|writeFile|appendFile|createWriteStream|setInterval|scheduleRetry|backoff|localStorage)/u,
    );
  }
  assert.equal(
    executor.match(/this\.#options\.resolver\.useGmailAuthorization\(/gu)?.length,
    1,
  );
  assert.match(executor, /let candidates: readonly GmailSafeCandidate\[\] \| null/u);
  assert.match(executor, /candidates = null/u);
  assert.match(executor, /validSourceRequest/u);
  assert.doesNotMatch(
    navigator,
    /(?:TextDecoder|Buffer\.from|\.toString\(|JSON\.stringify|rawUrl|verificationUrl)/u,
  );
  assert.match(navigator, /sameBytes\(values\[1\]!, policy\.host\)/u);
  assert.match(navigator, /sameBytes\(values\[2\]!, policy\.tenant\)/u);
});
