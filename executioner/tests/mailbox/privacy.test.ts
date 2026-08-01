import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const policyUrl = new URL("../../src/mailbox/policy.ts", import.meta.url);

test("mailbox policy contains no forbidden message, credential, or persistence surface", async () => {
  const source = await readFile(policyUrl, "utf8");

  assert.doesNotMatch(
    source,
    /\b(?:messageId|threadId|subject|headers|body|rawUrl|verificationUrl|verificationToken|oauthToken|accessToken|refreshToken)\b/u,
  );
  assert.doesNotMatch(
    source,
    /(?:node:fs|node:path|console\.|process\.|writeFile|appendFile|createWriteStream|setInterval|queueMicrotask|backoff|scheduleRetry)/u,
  );
  assert.equal(
    source.match(/candidateSource\.query|source\.query/gu)?.length,
    1,
  );
});
