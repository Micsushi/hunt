import assert from "node:assert/strict";
import test from "node:test";

import { parseGmailMessage } from "../../../../src/mailbox/providers/gmail/http-parser.ts";

const expected = {
  senderAddress: "workday@example.invalid",
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
        { name: "From", value: `Workday <${expected.senderAddress}>` },
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

test("finds an admitted target in a bounded later MIME part", () => {
  const parsed = parseGmailMessage(message(), expected);
  assert.equal(parsed?.receivedAt, "2026-08-01T12:05:00.000Z");
  assert.equal(
    new TextDecoder().decode(parsed?.verificationTarget),
    "https://tenant.example.invalid/verify?token=private",
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

test("wrong sender, recipient, time, or host is not a candidate", () => {
  const cases = [
    message({
      payload: {
        ...message().payload,
        headers: [
          { name: "From", value: "other@example.invalid" },
          { name: "To", value: expected.recipientAddress },
        ],
      },
    }),
    message({
      payload: {
        ...message().payload,
        headers: [
          { name: "From", value: expected.senderAddress },
          { name: "To", value: "other@example.invalid" },
        ],
      },
    }),
    message({ internalDate: String(Date.parse("2026-08-01T11:59:59.999Z")) }),
  ];
  for (const value of cases) assert.equal(parseGmailMessage(value, expected), null);
  assert.equal(
    parseGmailMessage(message(), { ...expected, verificationHost: "other.example.invalid" }),
    null,
  );
});
