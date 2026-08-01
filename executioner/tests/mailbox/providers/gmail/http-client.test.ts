import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { GmailHttpClient } from "../../../../src/mailbox/providers/gmail/http-client.ts";
import { GmailProviderFailure } from "../../../../src/mailbox/providers/gmail/http-parser.ts";

const authority = {
  accessValue: "synthetic-private-auth-value",
  senderAddress: "workday@example.invalid",
  recipientAddress: "applicant@example.invalid",
  verificationHost: "tenant.example.invalid",
  verificationTtlSeconds: 900,
};
const window = {
  notBefore: "2026-08-01T12:00:00.000Z",
  notAfter: "2026-08-01T12:15:00.000Z",
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/gmail/v1/users/me`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function failureCode(expected: string) {
  return (error: unknown) =>
    error instanceof GmailProviderFailure && error.code === expected;
}

test("never follows redirects or pagination and stays within two message fetches", async () => {
  let redirectCalls = 0;
  const redirect = createServer((_request, response) => {
    redirectCalls += 1;
    response.statusCode = 302;
    response.setHeader("location", "/synthetic-private-target");
    response.end();
  });
  const redirectBase = await listen(redirect);
  try {
    await assert.rejects(
      new GmailHttpClient({ baseUrl: redirectBase, allowLoopbackHttp: true })
        .query(authority, window, new AbortController().signal),
      failureCode("gmail_network_unavailable"),
    );
    assert.equal(redirectCalls, 1);
  } finally {
    await close(redirect);
  }

  let paginationCalls = 0;
  const pagination = createServer((request, response) => {
    paginationCalls += 1;
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (requestUrl.pathname.endsWith("/messages")) {
      response.end(JSON.stringify({
        messages: [{ id: "one" }],
        nextPageToken: "synthetic-private-page-token",
      }));
      return;
    }
    response.end(JSON.stringify({
      internalDate: String(Date.parse("2026-08-01T12:05:00.000Z")),
      payload: {
        headers: [
          { name: "From", value: authority.senderAddress },
          { name: "To", value: authority.recipientAddress },
        ],
        body: {
          data: Buffer.from(
            "https://tenant.example.invalid/verify?token=synthetic-private",
          ).toString("base64url"),
        },
      },
    }));
  });
  const paginationBase = await listen(pagination);
  try {
    const result = await new GmailHttpClient({
      baseUrl: paginationBase,
      allowLoopbackHttp: true,
    }).query(authority, window, new AbortController().signal);
    assert.equal(result.length, 1);
    assert.equal(paginationCalls, 2);
  } finally {
    await close(pagination);
  }
});
test("rejects oversized and malformed responses without retaining diagnostics", async () => {
  const payloads = [
    `{"padding":"${"x".repeat(1_048_576)}"}`,
    "synthetic-private-malformed-json",
    JSON.stringify({ messages: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
  ];
  for (const payload of payloads) {
    const server = createServer((_request, response) => response.end(payload));
    const baseUrl = await listen(server);
    try {
      await assert.rejects(
        new GmailHttpClient({ baseUrl, allowLoopbackHttp: true })
          .query(authority, window, new AbortController().signal),
        failureCode("mailbox_query_invalid"),
      );
    } finally {
      await close(server);
    }
  }
});

test("cancellation and network failure map to value-free stable sentinels", async () => {
  const pending = createServer(() => undefined);
  const baseUrl = await listen(pending);
  try {
    const controller = new AbortController();
    const query = new GmailHttpClient({ baseUrl, allowLoopbackHttp: true })
      .query(authority, window, controller.signal);
    controller.abort();
    await assert.rejects(query, failureCode("operation_cancelled"));
  } finally {
    await close(pending);
  }

  await assert.rejects(
    new GmailHttpClient({
      baseUrl: "http://127.0.0.1:1/gmail/v1/users/me",
      allowLoopbackHttp: true,
    }).query(authority, window, new AbortController().signal),
    failureCode("gmail_network_unavailable"),
  );
});

test("production and explicit loopback are the only admitted API bases", () => {
  assert.doesNotThrow(() => new GmailHttpClient());
  for (const value of [
    "http://example.invalid/gmail/v1/users/me",
    "https://gmail.googleapis.com/other",
    "http://127.0.0.1:1/gmail/v1/users/me#fragment",
  ]) {
    assert.throws(
      () => new GmailHttpClient({ baseUrl: value, allowLoopbackHttp: true }),
      /invalid Gmail API base URL/u,
    );
  }
});
