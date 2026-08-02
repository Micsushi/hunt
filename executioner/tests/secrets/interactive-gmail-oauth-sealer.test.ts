import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TargetIdentityV1 } from "../../src/contracts/live/index.ts";

import {
  WindowsInteractiveGmailOAuthSealer,
  type InteractiveGmailOAuthProcess,
} from "../../src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts";

class ReplyProcess implements InteractiveGmailOAuthProcess {
  input?: Uint8Array;
  capturedInput?: Uint8Array;
  readonly #reply: Uint8Array | Error;

  constructor(reply: Uint8Array | Error) {
    this.#reply = reply;
  }

  async run(input: Uint8Array): Promise<Uint8Array> {
    this.input = input;
    this.capturedInput = Uint8Array.from(input);
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
  installedClientConfigPath: "C:\\Users\\example\\AppData\\Local\\Hunt\\google-installed-client.json",
  senderPolicyConfigPath: "C:\\Users\\example\\AppData\\Local\\Hunt\\gmail-sender-policy.json",
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
  assert.equal(process.capturedInput?.[5], 7);
  assert.equal(Buffer.from(process.capturedInput ?? []).includes(Buffer.from(request.installedClientConfigPath)), true);
  assert.equal(Buffer.from(process.capturedInput ?? []).includes(Buffer.from(request.senderPolicyConfigPath)), true);
  assert.equal(Buffer.from(process.capturedInput ?? []).includes(Buffer.from("notifications@example.invalid")), false);
  assert.equal(Buffer.from(process.capturedInput ?? []).includes(Buffer.from("synthetic-client-secret")), false);
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
  assert.match(source, /AuthorizationEndpoint = "https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth"/u);
  assert.match(source, /InstalledClientAuthUri = "https:\/\/accounts\.google\.com\/o\/oauth2\/auth"/u);
  assert.match(source, /CertificateEndpoint = "https:\/\/www\.googleapis\.com\/oauth2\/v1\/certs"/u);
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
  assert.match(source, /ReadInstalledClient/u);
  assert.match(source, /File\.ReadAllBytes/u);
  assert.match(source, /client_secret/u);
  assert.match(source, /\{ "client_secret", clientSecret \}/u);
  assert.match(source, /code === 9[\s\S]*Gmail OAuth client invalid/u);
  assert.match(source, /code === 10[\s\S]*Gmail sender policy invalid/u);
  assert.equal(source.match(/\{ "client_secret", clientSecret \}/gu)?.length, 1);
  assert.match(source, /ExactKeys\(root, new string\[\] \{ "installed" \}\)/u);
  assert.match(source, /redirects\.Length < 1 \|\| redirects\.Length > 4/u);
  const authorizationBlock = /string authorization[\s\S]*?Process\.Start/u.exec(source)?.[0] ?? "";
  assert.doesNotMatch(authorizationBlock, /clientSecret|client_secret/u);
  assert.match(
    source,
    /IntegerField\(value, "verificationTtlSeconds", 86400, 86400\) != 86400/u,
  );
  assert.match(source, /ReadSenderPolicy/u);
  assert.doesNotMatch(source, /InputBox|Microsoft\.VisualBasic|Interaction\./u);
  assert.match(source, /exactBundle\["senderPolicyId"\] = binding\["senderPolicyId"\]/u);
  assert.match(source, /exactBundle\["senderAddress"\] = sender/u);
  const authorizeMethod = /private static Token Authorize[\s\S]*?private static string ReceiveCode/u.exec(source)?.[0] ?? "";
  assert.doesNotMatch(authorizeMethod, /senderAddress|senderPolicy|notifications@/iu);
  assert.match(source, /windowsHide:\s*false/u);
  assert.match(source, /shell:\s*false/u);
  assert.doesNotMatch(source, /process\.env|refresh_token[^\n]*bundle/iu);
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
      "$source=[Console]::In.ReadToEnd(); Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll'",
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

test("embedded helper exact-parses only the matching installed loopback client", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const root = await mkdtemp(join(tmpdir(), "hunt-installed-client-parser-"));
  try {
    const sourcePath = join(root, "helper.cs");
    const validPath = join(root, "valid.json");
    const validMinimumProjectPath = join(root, "valid-project-minimum.json");
    const validMaximumProjectPath = join(root, "valid-project-maximum.json");
    const extraPath = join(root, "extra.json");
    const missingPath = join(root, "missing.json");
    const wrongIdPath = join(root, "wrong-id.json");
    const wrongAuthPath = join(root, "wrong-auth.json");
    const wrongTokenPath = join(root, "wrong-token.json");
    const wrongCertPath = join(root, "wrong-cert.json");
    const webRedirectPath = join(root, "web-redirect.json");
    const invalidProjects = [
      "a1234",
      "1abcde",
      "Abcdef",
      "abcde-",
      `a${"x".repeat(29)}0`,
    ];
    const invalidProjectPaths = invalidProjects.map((_, index) =>
      join(root, `invalid-project-${index}.json`)
    );
    const clientId = request.clientId;
    const valid = installedClient(clientId, "http://localhost");
    const { project_id: _omitted, ...missingInstalled } = valid.installed;
    await Promise.all([
      writeFile(sourcePath, csharp),
      writeFile(validPath, JSON.stringify(valid)),
      writeFile(validMinimumProjectPath, JSON.stringify(installedClient(
        clientId,
        "http://localhost",
        "a12345",
      ))),
      writeFile(validMaximumProjectPath, JSON.stringify(installedClient(
        clientId,
        "http://localhost",
        `a${"x".repeat(28)}0`,
      ))),
      writeFile(extraPath, JSON.stringify({
        installed: { ...valid.installed, unexpected: "rejected" },
      })),
      writeFile(missingPath, JSON.stringify({ installed: missingInstalled })),
      writeFile(wrongIdPath, JSON.stringify(installedClient(
        "1234567890-different.apps.googleusercontent.com",
        "http://localhost",
      ))),
      writeFile(wrongAuthPath, JSON.stringify({
        installed: { ...valid.installed, auth_uri: "https://accounts.google.com/o/oauth2/v2/auth" },
      })),
      writeFile(wrongTokenPath, JSON.stringify({
        installed: { ...valid.installed, token_uri: "https://example.invalid/token" },
      })),
      writeFile(wrongCertPath, JSON.stringify({
        installed: { ...valid.installed, auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs/" },
      })),
      writeFile(webRedirectPath, JSON.stringify(installedClient(clientId, "https://example.invalid/callback"))),
      ...invalidProjects.map((projectId, index) => writeFile(
        invalidProjectPaths[index]!,
        JSON.stringify(installedClient(clientId, "http://localhost", projectId)),
      )),
    ]);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        "$valid=$env:HUNT_TEST_VALIDS | ConvertFrom-Json; $invalid=$env:HUNT_TEST_INVALIDS | ConvertFrom-Json; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; $method=[HuntInteractiveGmailOAuthSealer].GetMethod('ReadInstalledClient',[Reflection.BindingFlags]'NonPublic,Static'); foreach($path in $valid) { try { $null=$method.Invoke($null,@($path,$env:HUNT_TEST_CLIENT_ID)) } catch { exit 11 } }; foreach($path in $invalid) { try { $null=$method.Invoke($null,@($path,$env:HUNT_TEST_CLIENT_ID)); exit 12 } catch {} }; exit 0",
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
        timeout: 15_000,
        env: {
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          HUNT_TEST_SOURCE: sourcePath,
          HUNT_TEST_CLIENT_ID: clientId,
          HUNT_TEST_VALIDS: JSON.stringify([
            validPath,
            validMinimumProjectPath,
            validMaximumProjectPath,
          ]),
          HUNT_TEST_INVALIDS: JSON.stringify([
            extraPath,
            missingPath,
            wrongIdPath,
            wrongAuthPath,
            wrongTokenPath,
            wrongCertPath,
            webRedirectPath,
            ...invalidProjectPaths,
          ]),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded helper exact-parses one versioned lowercase sender policy", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const root = await mkdtemp(join(tmpdir(), "hunt-sender-policy-parser-"));
  try {
    const sourcePath = join(root, "helper.cs");
    const validPath = join(root, "valid.json");
    const bomPath = join(root, "bom.json");
    const invalid = [
      { schemaVersion: 1, contractRevision: "s2-gmail-sender-policy-v1" },
      { schemaVersion: 1, contractRevision: "s2-gmail-sender-policy-v1", senderAddress: "Notifications@example.invalid" },
      { schemaVersion: 1, contractRevision: "s2-gmail-sender-policy-v1", senderAddress: "invalid" },
      { schemaVersion: 1, contractRevision: "s2-gmail-sender-policy-v1", senderAddress: "notifications@example.invalid", extra: true },
      { schemaVersion: 2, contractRevision: "s2-gmail-sender-policy-v1", senderAddress: "notifications@example.invalid" },
    ];
    const invalidPaths = invalid.map((_, index) => join(root, `invalid-${index}.json`));
    await Promise.all([
      writeFile(sourcePath, csharp),
      writeFile(validPath, JSON.stringify({
        schemaVersion: 1,
        contractRevision: "s2-gmail-sender-policy-v1",
        senderAddress: "notifications@example.invalid",
      })),
      writeFile(bomPath, Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(JSON.stringify({
          schemaVersion: 1,
          contractRevision: "s2-gmail-sender-policy-v1",
          senderAddress: "notifications@example.invalid",
        })),
      ])),
      ...invalid.map((value, index) => writeFile(invalidPaths[index]!, JSON.stringify(value))),
    ]);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        "$invalid=$env:HUNT_TEST_INVALIDS | ConvertFrom-Json; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; $method=[HuntInteractiveGmailOAuthSealer].GetMethod('ReadSenderPolicy',[Reflection.BindingFlags]'NonPublic,Static'); try { $sender=$method.Invoke($null,@($env:HUNT_TEST_VALID)); if($sender -ne 'notifications@example.invalid') { exit 21 } } catch { exit 22 }; foreach($path in $invalid) { try { $null=$method.Invoke($null,@($path)); exit 23 } catch {} }; exit 0",
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
        timeout: 15_000,
        env: {
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          HUNT_TEST_SOURCE: sourcePath,
          HUNT_TEST_VALID: validPath,
          HUNT_TEST_INVALIDS: JSON.stringify([bomPath, ...invalidPaths]),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function installedClient(
  clientId: string,
  redirect: string,
  projectId = "synthetic-project",
) {
  return {
    installed: {
      client_id: clientId,
      project_id: projectId,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_secret: "synthetic-client-secret",
      redirect_uris: [redirect],
    },
  };
}
