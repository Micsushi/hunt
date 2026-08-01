import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { TargetIdentityV1 } from "../../src/contracts/live/index.ts";

import {
  WindowsInteractiveGmailOAuthSealer,
  type InteractiveGmailOAuthProcess,
} from "../../src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts";

class ReplyProcess implements InteractiveGmailOAuthProcess {
  input?: Uint8Array;
  readonly #reply: Uint8Array | Error;

  constructor(reply: Uint8Array | Error) {
    this.#reply = reply;
  }

  async run(input: Uint8Array): Promise<Uint8Array> {
    this.input = input;
    if (this.#reply instanceof Error) throw this.#reply;
    return this.#reply;
  }
}

function frame(ciphertext: readonly number[]): Uint8Array {
  const output = Buffer.alloc(9 + ciphertext.length);
  output.write("HAGS", 0, "ascii");
  output.writeUInt8(1, 4);
  output.writeUInt32LE(ciphertext.length, 5);
  output.set(ciphertext, 9);
  return output;
}

const request = {
  gmailMetadata: new TextEncoder().encode('{"expiresAt":"2026-08-01T12:30:00.000Z"}'),
  accountMetadata: new TextEncoder().encode('{"purpose":"account_credentials"}'),
  accountCiphertext: Uint8Array.from([3, 5, 7]),
  clientId: "1234567890-example1.apps.googleusercontent.com",
  binding: {
    journeyId: "journey_abcdefghijklmnop",
    recipientBindingId: "recipient_abcdefghijklmnop",
    senderPolicyId: "sender_policy_0123456789abcdef0123456789abcdef",
    target: {
      schemaVersion: 1 as const,
      atsFamily: "workday" as const,
      hostId: "host_abcdefghijklmnop",
      tenantId: "tenant_abcdefghijklmnop",
      postingId: "posting_abcdefghijklmnop",
    } as TargetIdentityV1,
    verificationHost: "wd5.myworkday.com",
    verificationTenant: "example-tenant",
    verificationTtlSeconds: 86_400 as const,
  },
};

test("accepts only one bounded ciphertext frame and clears its child input", async () => {
  const process = new ReplyProcess(frame([11, 13, 17]));
  const sealed = await new WindowsInteractiveGmailOAuthSealer({ process }).seal(
    request,
    new AbortController().signal,
  );
  assert.deepEqual([...sealed], [11, 13, 17]);
  assert.equal(Buffer.from(process.input?.subarray(0, 4) ?? []).toString("ascii"), "\0\0\0\0");
  assert.equal(process.input?.every((value) => value === 0), true);
  assert.deepEqual([...request.accountCiphertext], [3, 5, 7]);
});

test("fails closed for cancellation, helper failure, and malformed output", async () => {
  for (const process of [
    new ReplyProcess(new Error("synthetic")),
    new ReplyProcess(Buffer.from("malformed")),
    new ReplyProcess(frame([])),
    new ReplyProcess(frame(new Array(65).fill(1))),
  ]) {
    await assert.rejects(
      new WindowsInteractiveGmailOAuthSealer({ process, maxCiphertextBytes: 64 })
        .seal(request, new AbortController().signal),
      /Gmail OAuth/u,
    );
  }
  await assert.rejects(
    new WindowsInteractiveGmailOAuthSealer({ process: new ReplyProcess(frame([1])) })
      .seal(request, AbortSignal.abort()),
    /cancelled/u,
  );
});

test("production helper pins PKCE loopback Gmail readonly profile equality and DPAPI", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  assert.match(source, /const INTERACTIVE_GMAIL_OAUTH_SCRIPT = String\.raw/u);
  assert.match(source, /127\.0\.0\.1/u);
  assert.match(source, /TcpListener\(IPAddress\.Loopback, 0\)/u);
  assert.match(source, /first\[0\] != "GET"/u);
  assert.match(source, /AbsolutePath != "\/oauth2callback"/u);
  assert.match(source, /hostCount != 1/u);
  assert.match(source, /GetValues\("state"\).*Length != 1/u);
  assert.match(source, /code_challenge_method[^\n]*S256/u);
  assert.match(source, /AllowAutoRedirect = false/u);
  assert.match(source, /https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly/u);
  assert.match(source, /https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile/u);
  assert.match(source, /DataProtectionScope\.CurrentUser/u);
  assert.match(
    source,
    /IntegerField\(value, "verificationTtlSeconds", 86400, 86400\) != 86400/u,
  );
  assert.match(source, /InputBox/u);
  assert.match(source, /windowsHide:\s*false/u);
  assert.match(source, /shell:\s*false/u);
  assert.doesNotMatch(source, /client_secret|process\.env|refresh_token[^\n]*bundle/iu);
  assert.doesNotMatch(source, /Write-(?:Output|Error|Host)|console\.(?:log|error)/iu);
});

test("embedded Gmail helper compiles without opening UI or network", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const match = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source);
  assert.notEqual(match, null);
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command",
      "$source=[Console]::In.ReadToEnd(); Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll','Microsoft.VisualBasic.dll'",
    ],
    {
      input: match?.[1] ?? "",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});
