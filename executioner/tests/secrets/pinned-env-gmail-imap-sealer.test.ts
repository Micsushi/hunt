import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TargetIdentityV1 } from "../../src/contracts/live/index.ts";
import { WindowsDpapiBridge } from "../../src/secrets/windows-dpapi/bridge.ts";
import { encodeAccountCredentialBundleV1 } from "../../src/secrets/windows-dpapi/private/account-credential-bundle.ts";
import { WindowsPinnedEnvGmailImapSealer } from "../../src/secrets/windows-dpapi/private/pinned-env-gmail-imap-sealer.ts";

class CapturingBridge extends WindowsDpapiBridge {
  readonly #account: Uint8Array;

  constructor(account: Uint8Array) {
    super();
    this.#account = account;
  }

  override async unprotect(): Promise<Uint8Array> {
    return this.#account.slice();
  }

  override async protect(value: Readonly<Uint8Array>): Promise<Uint8Array> {
    return Uint8Array.from(value);
  }
}

test("frames the pinned IMAP bundle for the Gmail secret resolver", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-imap-sealer-"));
  try {
    const sourcePath = join(root, ".env");
    const policyPath = join(root, "company-policy.json");
    const source = [
      "HUNT_C3_MAIL_EMAIL=applicant@example.invalid",
      "HUNT_C3_MAIL_PASSWORD=synthetic-app-password",
    ].join("\n");
    await writeFile(sourcePath, source, "utf8");
    await writeFile(policyPath, JSON.stringify({
      schemaVersion: 1,
      contractRevision: "s2-gmail-company-policy-v1",
      companyName: "Example Company",
      verificationHost: "example.wd5.myworkdayjobs.com",
      verificationTenant: "example",
    }), "utf8");
    const account = encodeAccountCredentialBundleV1({
      email: new TextEncoder().encode("applicant@example.invalid"),
      password: new TextEncoder().encode("synthetic-account-password"),
    });
    assert.notEqual(account, null);
    const sealed = await new WindowsPinnedEnvGmailImapSealer({
      sourcePath,
      expectedSha256: createHash("sha256").update(source).digest("hex"),
      bridge: new CapturingBridge(account!),
    }).seal({
      gmailMetadata: new TextEncoder().encode('{"purpose":"gmail_oauth"}'),
      accountMetadata: new TextEncoder().encode('{"purpose":"account_credentials"}'),
      accountCiphertext: Uint8Array.from([3, 5, 7]),
      clientId: "1234567890-example1.apps.googleusercontent.com",
      installedClientConfigPath: join(root, "google-installed-client.json"),
      senderPolicyConfigPath: policyPath,
      binding: {
        journeyId: "journey_abcdefghijklmnop",
        recipientBindingId: "recipient_abcdefghijklmnop",
        senderPolicyId: "sender_policy_0123456789abcdef0123456789abcdef",
        target: {
          schemaVersion: 1,
          atsFamily: "workday",
          hostId: "host_abcdefghijklmnop",
          tenantId: "tenant_abcdefghijklmnop",
          postingId: "posting_abcdefghijklmnop",
        } as TargetIdentityV1,
        verificationHost: "example.wd5.myworkdayjobs.com",
        verificationTenant: "example",
        verificationTtlSeconds: 86_400,
      },
    }, new AbortController().signal);

    const input = Buffer.from(sealed);
    assert.equal(input.readUInt32LE(0), 1);
    assert.equal(input.readUInt32LE(4), input.byteLength - 8);
    const bundle = JSON.parse(input.subarray(8).toString("utf8"));
    assert.equal(bundle.format, "gmail-imap-app-password-bundle-v1");
    assert.equal(bundle.recipientAddress, "applicant@example.invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
