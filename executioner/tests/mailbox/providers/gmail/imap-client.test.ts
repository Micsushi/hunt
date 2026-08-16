import assert from "node:assert/strict";
import test from "node:test";

import { encodeGmailImapQueryRequest } from "../../../../src/mailbox/providers/gmail/private/imap-client.ts";

test("IMAP query input excludes resolver-only authorization fields", () => {
  const authorization = {
    accountPassword: "synthetic-app-password",
    companyName: "Example Company",
    recipientAddress: "applicant@example.invalid",
    verificationHost: "example.wd5.myworkdayjobs.com",
    kind: "imap",
    verificationTtlSeconds: 86_400,
  };
  const input = encodeGmailImapQueryRequest(authorization, {
    notBefore: "2026-08-15T12:00:00.000Z",
    notAfter: "2026-08-15T12:05:00.000Z",
  });

  assert.deepEqual(Object.keys(JSON.parse(input.toString("utf8"))).sort(), [
    "accountPassword",
    "companyName",
    "notAfter",
    "notBefore",
    "recipientAddress",
    "verificationHost",
  ]);
});
