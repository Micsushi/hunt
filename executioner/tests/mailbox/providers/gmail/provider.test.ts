import assert from "node:assert/strict";
import test from "node:test";

import type {
  PrivilegedGmailAuthExecutor,
  SecretStore,
} from "../../../../src/contracts/live/index.ts";
import { liveFixtures } from "../../../../src/testing/live/index.ts";
import { GmailMailboxProvider } from "../../../../src/mailbox/providers/gmail/provider.ts";

const signal = () => new AbortController().signal;

test("replay revalidates current auth metadata without decrypting or re-querying", async () => {
  let inspectCalls = 0;
  let queryCalls = 0;
  const secrets: SecretStore = {
    async inspect() {
      inspectCalls += 1;
      return { ok: true, value: liveFixtures.gmailSecret };
    },
    async revoke() {
      throw new Error("not used");
    },
  };
  const executor: PrivilegedGmailAuthExecutor = {
    async query() {
      queryCalls += 1;
      return { ok: true, value: liveFixtures.mailboxAvailable };
    },
  };
  const provider = new GmailMailboxProvider({
    authorization: liveFixtures.gmailSecret,
    binding: liveFixtures.mailboxPollRequest,
    now: () => liveFixtures.issuedAt,
    secretStore: secrets,
    authExecutor: executor,
    artifacts: {
      async inspect() {
        return { ok: true, value: liveFixtures.verificationArtifact };
      },
      async invalidate() {
        throw new Error("not used");
      },
    },
  });

  const first = await provider.poll(liveFixtures.mailboxPollRequest, signal());
  const replay = await provider.poll(
    { ...liveFixtures.mailboxPollRequest },
    signal(),
  );
  assert.deepEqual(first, { ok: true, value: liveFixtures.mailboxAvailable });
  assert.deepEqual(replay, first);
  assert.equal(queryCalls, 1);
  assert.equal(inspectCalls, 2);
});

test("rejects changed query identity and changed auth metadata without a privileged call", async () => {
  let queryCalls = 0;
  let current = liveFixtures.gmailSecret;
  const provider = new GmailMailboxProvider({
    authorization: liveFixtures.gmailSecret,
    binding: liveFixtures.mailboxPollRequest,
    now: () => liveFixtures.issuedAt,
    secretStore: {
      async inspect() {
        return { ok: true, value: current };
      },
      async revoke() {
        throw new Error("not used");
      },
    },
    authExecutor: {
      async query() {
        queryCalls += 1;
        return { ok: true, value: liveFixtures.mailboxAvailable };
      },
    },
    artifacts: {
      async inspect() {
        return { ok: true, value: liveFixtures.verificationArtifact };
      },
      async invalidate() {
        throw new Error("not used");
      },
    },
  });
  assert.equal(
    (await provider.poll(liveFixtures.mailboxPollRequest, signal())).ok,
    true,
  );

  assert.deepEqual(
    await provider.poll(
      {
        ...liveFixtures.mailboxPollRequest,
        target: liveFixtures.otherTarget,
      },
      signal(),
    ),
    {
      ok: false,
      error: { code: "mailbox_query_invalid", retryable: false },
    },
  );
  current = { ...liveFixtures.gmailSecret, expiresAt: liveFixtures.pastAt };
  assert.deepEqual(
    await provider.poll(liveFixtures.mailboxPollRequest, signal()),
    {
      ok: false,
      error: { code: "secret_handle_mismatched", retryable: false },
    },
  );
  assert.equal(queryCalls, 1);
});

test("passes stable provider failures and cancellation without diagnostics", async () => {
  let executorCalls = 0;
  const provider = new GmailMailboxProvider({
    authorization: liveFixtures.gmailSecret,
    binding: liveFixtures.mailboxPollRequest,
    now: () => liveFixtures.issuedAt,
    secretStore: {
      async inspect() {
        return { ok: true, value: liveFixtures.gmailSecret };
      },
      async revoke() {
        throw new Error("not used");
      },
    },
    authExecutor: {
      async query() {
        executorCalls += 1;
        return {
          ok: false,
          error: { code: "gmail_rate_limited", retryable: true },
        };
      },
    },
    artifacts: {
      async inspect() {
        return { ok: true, value: liveFixtures.verificationArtifact };
      },
      async invalidate() {
        throw new Error("not used");
      },
    },
  });
  assert.deepEqual(
    await provider.poll(liveFixtures.mailboxPollRequest, signal()),
    {
      ok: false,
      error: { code: "gmail_rate_limited", retryable: true },
    },
  );
  assert.deepEqual(
    await provider.poll(liveFixtures.mailboxPollRequest, AbortSignal.abort()),
    {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    },
  );
  assert.equal(executorCalls, 1);
});

test("safe replay projects invalidated artifact state without another query", async () => {
  let queryCalls = 0;
  const provider = new GmailMailboxProvider({
    authorization: liveFixtures.gmailSecret,
    binding: liveFixtures.mailboxPollRequest,
    now: () => liveFixtures.issuedAt,
    timeoutMs: 100,
    secretStore: {
      async inspect() {
        return { ok: true, value: liveFixtures.gmailSecret };
      },
      async revoke() {
        throw new Error("not used");
      },
    },
    authExecutor: {
      async query() {
        queryCalls += 1;
        return { ok: true, value: liveFixtures.mailboxAvailable };
      },
    },
    artifacts: {
      async inspect() {
        return {
          ok: true,
          value: { ...liveFixtures.verificationArtifact, state: "invalidated" },
        };
      },
      async invalidate() {
        throw new Error("not used");
      },
    },
  });
  assert.equal((await provider.poll(liveFixtures.mailboxPollRequest, signal())).ok, true);
  assert.deepEqual(
    await provider.poll(liveFixtures.mailboxPollRequest, signal()),
    {
      ok: true,
      value: { ...liveFixtures.mailboxAvailable, verificationHandle: null },
    },
  );
  assert.equal(queryCalls, 1);
});

test("bounded provider timeout aborts one privileged query and remains retryable", async () => {
  const provider = new GmailMailboxProvider({
    authorization: liveFixtures.gmailSecret,
    binding: liveFixtures.mailboxPollRequest,
    now: () => liveFixtures.issuedAt,
    timeoutMs: 5,
    secretStore: {
      async inspect() {
        return { ok: true, value: liveFixtures.gmailSecret };
      },
      async revoke() {
        throw new Error("not used");
      },
    },
    authExecutor: {
      async query() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ok: true, value: liveFixtures.mailboxAvailable };
      },
    },
    artifacts: {
      async inspect() {
        throw new Error("not used");
      },
      async invalidate() {
        throw new Error("not used");
      },
    },
  });
  assert.deepEqual(
    await provider.poll(liveFixtures.mailboxPollRequest, signal()),
    {
      ok: false,
      error: { code: "mailbox_timeout", retryable: true },
    },
  );
});

test("the same timeout bounds metadata inspection before any privileged query", async () => {
  let queryCalls = 0;
  const provider = new GmailMailboxProvider({
    authorization: liveFixtures.gmailSecret,
    binding: liveFixtures.mailboxPollRequest,
    now: () => liveFixtures.issuedAt,
    timeoutMs: 5,
    secretStore: {
      async inspect() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ok: true, value: liveFixtures.gmailSecret };
      },
      async revoke() {
        throw new Error("not used");
      },
    },
    authExecutor: {
      async query() {
        queryCalls += 1;
        return { ok: true, value: liveFixtures.mailboxAvailable };
      },
    },
    artifacts: {
      async inspect() {
        throw new Error("not used");
      },
      async invalidate() {
        throw new Error("not used");
      },
    },
  });
  assert.deepEqual(
    await provider.poll(liveFixtures.mailboxPollRequest, signal()),
    {
      ok: false,
      error: { code: "mailbox_timeout", retryable: true },
    },
  );
  assert.equal(queryCalls, 0);
});
