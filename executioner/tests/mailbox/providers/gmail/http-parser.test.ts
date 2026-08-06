import assert from "node:assert/strict";
import test from "node:test";

import {
  GmailProviderFailure,
  parseGmailMessage,
  parseMessageIds,
} from "../../../../src/mailbox/providers/gmail/http-parser.ts";

const expected = {
  recipientAddress: "applicant@example.invalid",
  verificationHost: "tenant.example.invalid",
  notBefore: "2026-08-01T12:00:00.000Z",
  notAfter: "2026-08-01T12:15:00.000Z",
  verificationTtlSeconds: 900,
};

function encoded(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    internalDate: String(Date.parse("2026-08-01T12:05:00.000Z")),
    payload: {
      headers: [
        { name: "From", value: "Unexpected Sender <random@mailer.example.invalid>" },
        { name: "To", value: `Applicant <${expected.recipientAddress}>` },
      ],
      parts: [
        { body: { data: encoded("x") } },
        {
          body: {
            data: encoded(
              "<a href=\"https://tenant.example.invalid/verify?token=private\">verify</a>",
            ),
          },
        },
      ],
    },
    ...overrides,
  };
}

test("list parsing fails closed on pagination and result overflow", () => {
  const invalid = [
    { messages: [{ id: "one" }], nextPageToken: "private-page-token" },
    { messages: [{ id: "one" }], nextPageToken: "" },
    { messages: [{ id: "one" }], resultSizeEstimate: 2 },
    { messages: [], resultSizeEstimate: 1 },
    { messages: [{ id: "one" }], resultSizeEstimate: "1" },
  ];
  for (const value of invalid) {
    assert.throws(
      () => parseMessageIds(value),
      (error: unknown) =>
        error instanceof GmailProviderFailure &&
        error.code === "mailbox_query_invalid",
    );
  }

  assert.deepEqual(
    parseMessageIds({ messages: [{ id: "one" }], resultSizeEstimate: 1 }),
    ["one"],
  );
  assert.deepEqual(parseMessageIds({ resultSizeEstimate: 0 }), []);
});

test("finds an admitted target in a bounded later MIME part", () => {
  const parsed = parseGmailMessage(message(), expected);
  assert.equal(parsed?.receivedAt, "2026-08-01T12:05:00.000Z");
  assert.equal(
    new TextDecoder().decode(parsed?.verificationTarget),
    "https://tenant.example.invalid/verify?token=private",
  );
});

test("accepts canonical padded Gmail base64url bodies", () => {
  const value = message();
  const payload = value.payload as {
    parts: { body: { data: string } }[];
  };
  const target = "https://tenant.example.invalid/verify?token=private&a=b";
  const unpadded = encoded(target);
  const paddingLength = (4 - (unpadded.length % 4)) % 4;
  assert.notEqual(paddingLength, 0);
  payload.parts[1]!.body.data = `${unpadded}${"=".repeat(paddingLength)}`;

  assert.equal(
    new TextDecoder().decode(
      parseGmailMessage(value, expected)?.verificationTarget,
    ),
    target,
  );
});

test("returns no candidate when the message has no verification target", () => {
  const value = message({
    payload: {
      ...message().payload,
      parts: [{ body: { data: encoded("no target") } }],
    },
  });

  assert.equal(parseGmailMessage(value, expected), null);
});

test("rejects multiple unique verification targets", () => {
  const value = message();
  const payload = value.payload as {
    parts: { body: { data: string } }[];
  };
  payload.parts.push({
    body: {
      data: encoded(
        "https://tenant.example.invalid/verify?token=other-private",
      ),
    },
  });

  assert.equal(parseGmailMessage(value, expected), null);
});

test("deduplicates canonical equivalents before enforcing uniqueness", () => {
  const value = message();
  const payload = value.payload as {
    parts: { body: { data: string } }[];
  };
  payload.parts.push({
    body: {
      data: encoded(
        "https://TENANT.example.invalid:443/other/../verify?token=private",
      ),
    },
  });

  assert.equal(
    new TextDecoder().decode(
      parseGmailMessage(value, expected)?.verificationTarget,
    ),
    "https://tenant.example.invalid/verify?token=private",
  );
});

test("rejects unsafe targets without exposing their values", () => {
  const privateValue = "private-value-that-must-not-escape";
  const targets = [
    `https://other.example.invalid/verify?token=${privateValue}`,
    `https://user:${privateValue}@tenant.example.invalid/verify?token=x`,
    `https://tenant.example.invalid/verify?token=${privateValue}#fragment`,
    "https://%",
    `https://tenant.example.invalid/verify?token=${"x".repeat(4_097)}`,
    "https://tenant.example.invalid/account",
    "https://tenant.example.invalid/verify?token=",
  ];

  for (const target of targets) {
    const value = message({
      payload: {
        ...message().payload,
        parts: [{ body: { data: encoded(target) } }],
      },
    });
    const parsed = parseGmailMessage(value, expected);
    assert.equal(parsed, null);
    assert.doesNotMatch(
      JSON.stringify(parsed),
      /private-value-that-must-not-escape/u,
    );
  }
});

test("admits a token carried in an explicit verification path", () => {
  const value = message({
    payload: {
      ...message().payload,
      parts: [{
        body: {
          data: encoded(
            "https://tenant.example.invalid/account/verify/private-path-token",
          ),
        },
      }],
    },
  });

  assert.equal(
    new TextDecoder().decode(
      parseGmailMessage(value, expected)?.verificationTarget,
    ),
    "https://tenant.example.invalid/account/verify/private-path-token",
  );
});

test("an out-of-range timestamp is a stable malformed-response failure", () => {
  assert.throws(
    () => parseGmailMessage(
      message({ internalDate: "8640000000000001" }),
      expected,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "GmailProviderFailure" &&
      error.message === "mailbox_query_invalid",
  );
});

test("accepts an arbitrary sender but rejects the wrong recipient, time, or host", () => {
  const cases = [
    message({
      payload: {
        ...message().payload,
        headers: [
          { name: "From", value: "any-sender@example.invalid" },
          { name: "To", value: "other@example.invalid" },
        ],
      },
    }),
    message({ internalDate: String(Date.parse("2026-08-01T11:59:59.999Z")) }),
  ];
  assert.notEqual(parseGmailMessage(message(), expected), null);
  for (const value of cases) assert.equal(parseGmailMessage(value, expected), null);
  assert.equal(
    parseGmailMessage(message(), { ...expected, verificationHost: "other.example.invalid" }),
    null,
  );
});
