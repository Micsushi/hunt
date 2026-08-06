import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { MailboxPollResultV1 } from "../../../../src/contracts/live/index.ts";
import { liveFixtures } from "../../../../src/testing/live/index.ts";
import {
  createBoundedMailboxPolicy,
  type SenderPolicyId,
} from "../../../../src/mailbox/policy.ts";
import {
  GmailApiAuthExecutor,
  type GmailAuthorizationResolver,
} from "../../../../src/mailbox/providers/gmail/auth-executor.ts";
import { GmailHttpClient } from "../../../../src/mailbox/providers/gmail/http-client.ts";
import { GmailRawArtifactVault } from "../../../../src/mailbox/providers/gmail/private/raw-artifact-vault.ts";
import { GmailSafeArtifactRegistry } from "../../../../src/mailbox/providers/gmail/safe-artifact-registry.ts";
import { WindowsDpapiSecretResolver } from "../../../../src/secrets/windows-dpapi/private/resolver.ts";

const resolverCompatibility: GmailAuthorizationResolver =
  null as unknown as WindowsDpapiSecretResolver;
void resolverCompatibility;

const senderPolicyId =
  "sender_policy_0123456789abcdef" as SenderPolicyId;
const recipientAddress = "applicant@example.invalid";
const companyName = "Acme Research";
const verificationHost = "tenant.example.invalid";
const verificationTenant = "example-tenant";
const verificationTarget =
  `https://${verificationHost}/verify?token=synthetic-private-value`;
const accessValue = "synthetic-private-auth-value";

function sealedBundle(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    format: "gmail-oauth-bundle-v2",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    accessValue,
    journeyId: liveFixtures.journeyId,
    recipientBindingId: liveFixtures.mailboxPollRequest.recipientBindingId,
    senderPolicyId,
    recipientAddress,
    companyName,
    target: liveFixtures.target,
    verificationHost,
    verificationTenant,
    verificationTtlSeconds: 900,
    ...overrides,
  }));
}

async function withFakeGmail(
  operation: (baseUrl: string, calls: () => number) => Promise<void>,
): Promise<void> {
  let callCount = 0;
  const server = createServer((request, response) => {
    callCount += 1;
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    assert.equal(request.headers.authorization === `Bearer ${accessValue}`, true);
    if (requestUrl.pathname.endsWith("/messages")) {
      assert.equal(requestUrl.searchParams.get("maxResults"), "2");
      const query = requestUrl.searchParams.get("q") ?? "";
      assert.match(query, /"Acme Research"/u);
      assert.match(query, /to:applicant@example\.invalid/u);
      assert.match(query, /after:\d+/u);
      assert.match(query, /before:\d+/u);
      assert.doesNotMatch(query, /(?:^|\s)from:/u);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ messages: [{ id: "synthetic-message-id" }] }));
      return;
    }
    if (requestUrl.pathname.endsWith("/messages/synthetic-message-id")) {
      assert.equal(requestUrl.searchParams.get("format"), "full");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "synthetic-message-id",
        internalDate: String(Date.parse("2026-08-01T12:05:00.000Z")),
        payload: {
          headers: [
            { name: "From", value: "random@mailer.example.invalid" },
            { name: "To", value: recipientAddress },
          ],
          body: {
            data: Buffer.from(`<a href="${verificationTarget}">verify</a>`)
              .toString("base64url"),
          },
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await operation(
      `http://127.0.0.1:${address.port}/gmail/v1/users/me`,
      () => callCount,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    );
  }
}

function buildExecutor(baseUrl: string, bundle = sealedBundle()) {
  let resolverCalls = 0;
  let policyCalls = 0;
  let callbackView: Readonly<Uint8Array> | undefined;
  let policyViews: readonly Readonly<Uint8Array>[] = [];
  const resolver: GmailAuthorizationResolver = {
    async useGmailAuthorization(_handle, signal, operation) {
      if (signal.aborted) {
        return {
          ok: false,
          error: { code: "operation_cancelled", retryable: false },
        };
      }
      resolverCalls += 1;
      callbackView = bundle;
      try {
        return { ok: true, value: await operation(bundle) };
      } finally {
        bundle.fill(0);
      }
    },
  };
  const rawVault = new GmailRawArtifactVault();
  const artifacts = new GmailSafeArtifactRegistry();
  const binding = {
    journeyId: liveFixtures.journeyId,
    recipientBindingId: liveFixtures.mailboxPollRequest.recipientBindingId,
    senderPolicyId,
    target: liveFixtures.target,
    notBefore: liveFixtures.mailboxPollRequest.notBefore,
    notAfter: liveFixtures.mailboxPollRequest.notAfter,
    verificationOperationId: liveFixtures.operationIds.verificationNavigation,
  };
  const executor = new GmailApiAuthExecutor({
    binding,
    resolver,
    httpClient: new GmailHttpClient({ baseUrl, allowLoopbackHttp: true }),
    rawVault,
    artifactRegistry: artifacts,
    approvedPolicy: {
      async use(operation) {
        policyCalls += 1;
        const host = new TextEncoder().encode(verificationHost);
        const tenant = new TextEncoder().encode(verificationTenant);
        policyViews = [host, tenant];
        try {
          return await operation({ host, tenant });
        } finally {
          host.fill(0);
          tenant.fill(0);
        }
      },
    },
    createHandle: () => liveFixtures.verificationArtifact.handleId,
    policyFactory: {
      create(candidateSource, admittedNow) {
        return createBoundedMailboxPolicy({
          binding,
          candidateSource,
          clock: () => admittedNow,
          timeoutMs: 100,
        });
      },
    },
  });
  return {
    executor,
    artifacts,
    rawVault,
    resolverCalls: () => resolverCalls,
    policyCalls: () => policyCalls,
    policyViews: () => policyViews,
    callbackView: () => callbackView,
  };
}

test("one readonly DPAPI callback returns only safe metadata and commits one admitted raw handle", async () => {
  await withFakeGmail(async (baseUrl, httpCalls) => {
    assert.doesNotMatch(new TextDecoder().decode(sealedBundle()), /senderAddress/u);
    const harness = buildExecutor(baseUrl);
    const result = await harness.executor.query(
      {
        ...liveFixtures.mailboxPollRequest,
        now: liveFixtures.issuedAt,
        authorization: liveFixtures.gmailSecret,
      },
      new AbortController().signal,
    );

    assert.deepEqual(result, {
      ok: true,
      value: {
        provider: "gmail_api_v1",
        receivedTimeBucket: "2026-08-01T12:05Z",
        expiresAt: "2026-08-01T12:20:00.000Z",
        candidateCount: 1,
        verificationHandle: liveFixtures.verificationArtifact.handleId,
      } satisfies MailboxPollResultV1,
    });
    assert.equal(harness.resolverCalls(), 1);
    assert.equal(harness.policyCalls(), 1);
    assert.equal(httpCalls(), 2);
    assert.equal(harness.rawVault.committedCount, 1);
    assert.deepEqual([...(harness.callbackView() ?? [])], new Array(sealedBundle().length).fill(0));
    assert.deepEqual(
      harness.policyViews().map((value) => [...value]),
      [
        new Array(verificationHost.length).fill(0),
        new Array(verificationTenant.length).fill(0),
      ],
    );
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private/u);

    const inspected = await harness.artifacts.port.inspect(
      {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        handleId: liveFixtures.verificationArtifact.handleId,
        expectedRecipientBindingId:
          liveFixtures.mailboxPollRequest.recipientBindingId,
        expectedTarget: liveFixtures.target,
      },
      new AbortController().signal,
    );
    assert.equal(inspected.ok && inspected.value.state, "available");
    assert.deepEqual(
      await harness.artifacts.port.invalidate(
        {
          schemaVersion: 1,
          journeyId: liveFixtures.journeyId,
          operationId: liveFixtures.operationIds.artifactInvalidate,
          handleId: liveFixtures.verificationArtifact.handleId,
        },
        new AbortController().signal,
      ),
      { ok: true, value: undefined },
    );
    assert.equal(harness.rawVault.committedCount, 0);
  });
});

test("admits the exact 24-hour Workday verification lifetime and rejects any longer value", async () => {
  await withFakeGmail(async (baseUrl, httpCalls) => {
    const admitted = buildExecutor(
      baseUrl,
      sealedBundle({ verificationTtlSeconds: 86_400 }),
    );
    const result = await admitted.executor.query(
      {
        ...liveFixtures.mailboxPollRequest,
        now: liveFixtures.issuedAt,
        authorization: liveFixtures.gmailSecret,
      },
      new AbortController().signal,
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.expiresAt, "2026-08-02T12:05:00.000Z");
    assert.equal(admitted.rawVault.committedCount, 1);

    const rejected = buildExecutor(
      baseUrl,
      sealedBundle({ verificationTtlSeconds: 86_401 }),
    );
    assert.deepEqual(
      await rejected.executor.query(
        {
          ...liveFixtures.mailboxPollRequest,
          now: liveFixtures.issuedAt,
          authorization: liveFixtures.gmailSecret,
        },
        new AbortController().signal,
      ),
      { ok: false, error: { code: "gmail_auth_denied", retryable: false } },
    );
    assert.equal(rejected.rawVault.committedCount, 0);
    assert.equal(httpCalls(), 2);
  });
});

test("zero, ambiguous, and expired candidates remain exact and never commit raw targets", async () => {
  const cases = [
    {
      messages: [] as readonly { readonly id: string; readonly receivedAt: string }[],
      now: liveFixtures.issuedAt,
      expected: {
        provider: "gmail_api_v1",
        receivedTimeBucket: null,
        expiresAt: null,
        candidateCount: 0,
        verificationHandle: null,
      },
    },
    {
      messages: [
        { id: "one", receivedAt: "2026-08-01T12:04:00.000Z" },
        { id: "two", receivedAt: "2026-08-01T12:05:00.000Z" },
      ],
      now: liveFixtures.issuedAt,
      expected: {
        provider: "gmail_api_v1",
        receivedTimeBucket: "2026-08-01T12:05Z",
        expiresAt: "2026-08-01T12:20:00.000Z",
        candidateCount: 2,
        verificationHandle: null,
      },
    },
    {
      messages: [{ id: "expired", receivedAt: "2026-08-01T12:05:00.000Z" }],
      now: "2026-08-01T12:30:00.000Z",
      expected: {
        provider: "gmail_api_v1",
        receivedTimeBucket: "2026-08-01T12:05Z",
        expiresAt: "2026-08-01T12:20:00.000Z",
        candidateCount: 1,
        verificationHandle: null,
      },
    },
  ] as const;

  for (const current of cases) {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("content-type", "application/json");
      if (requestUrl.pathname.endsWith("/messages")) {
        response.end(JSON.stringify({
          messages: current.messages.map(({ id }) => ({ id })),
        }));
        return;
      }
      const id = requestUrl.pathname.split("/").at(-1);
      const message = current.messages.find((candidate) => candidate.id === id);
      response.end(JSON.stringify({
        internalDate: String(Date.parse(message?.receivedAt ?? "invalid")),
        payload: {
          headers: [
            { name: "From", value: "random@mailer.example.invalid" },
            { name: "To", value: recipientAddress },
          ],
          body: {
            data: Buffer.from(verificationTarget).toString("base64url"),
          },
        },
      }));
    });
    const baseUrl = await listenTestServer(server);
    try {
      const harness = buildExecutor(baseUrl);
      assert.deepEqual(
        await harness.executor.query(
          {
            ...liveFixtures.mailboxPollRequest,
            now: current.now,
            authorization: liveFixtures.gmailSecret,
          },
          new AbortController().signal,
        ),
        { ok: true, value: current.expected },
      );
      assert.equal(harness.rawVault.committedCount, 0);
    } finally {
      await closeTestServer(server);
    }
  }
});

async function listenTestServer(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/gmail/v1/users/me`;
}

async function closeTestServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("wrong scope or sealed binding fails before HTTP and emits no raw handle", async () => {
  await withFakeGmail(async (baseUrl, httpCalls) => {
    const cases = [
      [sealedBundle({ scope: "https://mail.google.com/" }), "gmail_auth_denied"],
      [sealedBundle({ companyName: "" }), "gmail_auth_denied"],
      [sealedBundle({ companyName: " Acme Research" }), "gmail_auth_denied"],
      [sealedBundle({ companyName: "Acme\nResearch" }), "gmail_auth_denied"],
      [sealedBundle({ companyName: "x".repeat(201) }), "gmail_auth_denied"],
      [sealedBundle({
        format: "gmail-oauth-bundle-v1",
        senderAddress: "workday@example.invalid",
        companyName: undefined,
      }), "gmail_auth_denied"],
      [sealedBundle({ extra: "not-admitted" }), "gmail_auth_denied"],
      [sealedBundle({ journeyId: liveFixtures.otherJourneyId }), "mailbox_query_invalid"],
      [sealedBundle({ recipientBindingId: "recipient_fedcba9876543210" }), "mailbox_query_invalid"],
      [sealedBundle({ senderPolicyId: "sender_policy_fedcba9876543210" }), "mailbox_query_invalid"],
      [sealedBundle({ target: liveFixtures.otherTarget }), "mailbox_query_invalid"],
      [sealedBundle({ verificationHost: "other.example.invalid" }), "mailbox_query_invalid"],
      [sealedBundle({ verificationTenant: "other-tenant" }), "mailbox_query_invalid"],
    ] as const;
    for (const [bundle, code] of cases) {
      const harness = buildExecutor(baseUrl, bundle);
      assert.deepEqual(
        await harness.executor.query(
          {
            ...liveFixtures.mailboxPollRequest,
            now: liveFixtures.issuedAt,
            authorization: liveFixtures.gmailSecret,
          },
          new AbortController().signal,
        ),
        { ok: false, error: { code, retryable: false } },
      );
      assert.equal(harness.resolverCalls(), 1);
      assert.equal(harness.policyCalls(), 1);
      assert.equal(harness.rawVault.committedCount, 0);
    }
    assert.equal(httpCalls(), 0);
  });
});

test("rejects every secret and bounded-query mismatch before resolving bytes", async () => {
  const authorizationCases = [
    [{ ...liveFixtures.gmailSecret, state: "revoked" }, "secret_handle_invalid"],
    [{ ...liveFixtures.gmailSecret, expiresAt: liveFixtures.pastAt }, "secret_handle_expired"],
    [{ ...liveFixtures.gmailSecret, provider: "synthetic_wrong_provider" }, "secret_handle_mismatched"],
    [{ ...liveFixtures.gmailSecret, purpose: "account_credentials" }, "secret_handle_mismatched"],
    [{ ...liveFixtures.gmailSecret, consumer: "credential_mutation_adapter" }, "secret_consumer_forbidden"],
    [{ ...liveFixtures.gmailSecret, journeyId: liveFixtures.otherJourneyId }, "secret_handle_mismatched"],
  ] as const;
  for (const [authorization, code] of authorizationCases) {
    const harness = buildExecutor("http://127.0.0.1:1/gmail/v1/users/me");
    assert.deepEqual(
      await harness.executor.query(
        {
          ...liveFixtures.mailboxPollRequest,
          now: liveFixtures.issuedAt,
          authorization,
        } as never,
        new AbortController().signal,
      ),
      { ok: false, error: { code, retryable: false } },
    );
    assert.equal(harness.resolverCalls(), 0);
    assert.equal(harness.policyCalls(), 0);
  }

  const queryCases = [
    { target: liveFixtures.otherTarget },
    { recipientBindingId: "recipient_fedcba9876543210" },
    { notBefore: liveFixtures.expiresAt, notAfter: liveFixtures.issuedAt },
    { now: "not-an-instant" },
  ] as const;
  for (const query of queryCases) {
    const harness = buildExecutor("http://127.0.0.1:1/gmail/v1/users/me");
    assert.deepEqual(
      await harness.executor.query(
        {
          ...liveFixtures.mailboxPollRequest,
          now: liveFixtures.issuedAt,
          ...query,
          authorization: liveFixtures.gmailSecret,
        } as never,
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "mailbox_query_invalid", retryable: false },
      },
    );
    assert.equal(harness.resolverCalls(), 0);
    assert.equal(harness.policyCalls(), 0);
  }
});

test("HTTP auth, rate, network, malformed, and cancellation failures stay stable and value-free", async () => {
  const cases = [
    [401, "gmail_auth_denied", false],
    [403, "gmail_auth_denied", false],
    [429, "gmail_rate_limited", true],
    [500, "gmail_network_unavailable", true],
    [503, "gmail_network_unavailable", true],
  ] as const;
  for (const [status, code, retryable] of cases) {
    const server = createServer((_request, response) => {
      response.statusCode = status;
      response.end("synthetic-private-diagnostic");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const harness = buildExecutor(
        `http://127.0.0.1:${address.port}/gmail/v1/users/me`,
      );
      const result = await harness.executor.query(
        {
          ...liveFixtures.mailboxPollRequest,
          now: liveFixtures.issuedAt,
          authorization: liveFixtures.gmailSecret,
        },
        new AbortController().signal,
      );
      assert.deepEqual(result, { ok: false, error: { code, retryable } });
      assert.doesNotMatch(JSON.stringify(result), /synthetic-private/u);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const cancelled = buildExecutor(
    "http://127.0.0.1:1/gmail/v1/users/me",
  );
  assert.deepEqual(
    await cancelled.executor.query(
      {
        ...liveFixtures.mailboxPollRequest,
        now: liveFixtures.issuedAt,
        authorization: liveFixtures.gmailSecret,
      },
      AbortSignal.abort(),
    ),
    {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    },
  );
  assert.equal(cancelled.resolverCalls(), 0);
});
