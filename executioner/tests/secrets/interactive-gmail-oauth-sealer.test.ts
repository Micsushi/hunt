import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TargetIdentityV1 } from "../../src/contracts/live/index.ts";
import { liveFixtures } from "../../src/testing/live/index.ts";

import {
  WindowsInteractiveGmailOAuthSealer,
  type InteractiveGmailOAuthProcess,
} from "../../src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts";
import { WindowsDpapiBridge } from "../../src/secrets/windows-dpapi/bridge.ts";
import { WindowsDpapiSecretResolver } from "../../src/secrets/windows-dpapi/private/resolver.ts";
import { writeSecretRecord } from "../../src/secrets/windows-dpapi/record.ts";

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

class ControlledUnprotectBridge extends WindowsDpapiBridge {
  readonly #payload: Uint8Array;

  constructor(payload: Uint8Array) {
    super();
    this.#payload = payload;
  }

  override async unprotect(): Promise<Uint8Array> {
    return this.#payload.slice();
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

test("trusted helper frames the Gmail bundle for the resolver's exact one-item decoder", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-bundle-frame-"));
  const bundle = new TextEncoder().encode('{"format":"gmail-oauth-bundle-v1","accessValue":"synthetic"}');
  try {
    const sourcePath = join(root, "helper.cs");
    const bundlePath = join(root, "bundle.bin");
    const framedPath = join(root, "framed.bin");
    await Promise.all([
      writeFile(sourcePath, csharp),
      writeFile(bundlePath, bundle),
    ]);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        "$bundle=$null; $framed=$null; try { Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; $method=[HuntInteractiveGmailOAuthSealer].GetMethod('FrameBundle',[Reflection.BindingFlags]'NonPublic,Static'); if($null -eq $method) { exit 41 }; $bundle=[IO.File]::ReadAllBytes($env:HUNT_TEST_BUNDLE); $framed=[byte[]]$method.Invoke($null,@(,$bundle)); [IO.File]::WriteAllBytes($env:HUNT_TEST_FRAMED,$framed); exit 0 } finally { if($null -ne $bundle) { [Array]::Clear($bundle,0,$bundle.Length) }; if($null -ne $framed) { [Array]::Clear($framed,0,$framed.Length) } }",
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 15_000,
        env: {
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          HUNT_TEST_SOURCE: sourcePath,
          HUNT_TEST_BUNDLE: bundlePath,
          HUNT_TEST_FRAMED: framedPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    const framed = await readFile(framedPath);
    const expected = Buffer.alloc(8 + bundle.byteLength);
    expected.writeUInt32LE(1, 0);
    expected.writeUInt32LE(bundle.byteLength, 4);
    expected.set(bundle, 8);
    assert.deepEqual(framed, expected);

    const gmailHandle = {
      ...liveFixtures.gmailSecret,
      handleId: "secret_handle_fedcba9876543210fedcba9876543210" as typeof liveFixtures.gmailSecret.handleId,
    };
    await writeSecretRecord(root, {
      storageVersion: 1,
      ...gmailHandle,
      scope: "mailbox_verification",
    }, Uint8Array.from([1]));
    const resolver = new WindowsDpapiSecretResolver({
      root,
      forbiddenRoots: [process.cwd()],
      now: () => liveFixtures.issuedAt,
      bridge: new ControlledUnprotectBridge(framed),
    });
    let callbackBytes: Uint8Array | undefined;
    const resolved = await resolver.useGmailAuthorization(
      gmailHandle,
      new AbortController().signal,
      async (value) => {
        callbackBytes = Uint8Array.from(value);
        return liveFixtures.mailboxAvailable;
      },
    );
    assert.deepEqual(resolved, { ok: true, value: liveFixtures.mailboxAvailable });
    assert.deepEqual(callbackBytes, bundle);
    framed.fill(0);
    expected.fill(0);
  } finally {
    bundle.fill(0);
    await rm(root, { recursive: true, force: true });
  }
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
  await assert.rejects(
    new WindowsInteractiveGmailOAuthSealer({
      process: new ReplyProcess(new Error("Gmail refresh grant invalid")),
    }).seal(request, new AbortController().signal),
    /Gmail refresh grant invalid/u,
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
  assert.match(source, /AcquireToken\([\s\S]*new WindowsCredentialManagerGrantStore\(\)[\s\S]*new WindowsGmailOAuthClient\(\)/u);
  assert.match(source, /AuthorizationUrl\(clientId, redirect, state, challenge, loginHint\)/u);
  assert.match(source, /\{ "login_hint", loginHint \}/u);
  assert.match(
    source,
    /String\.Equals\(accountEmail, profileEmail, StringComparison\.OrdinalIgnoreCase\)/u,
  );
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
  assert.match(source, /EntryPoint = "CredReadW"/u);
  assert.match(source, /EntryPoint = "CredWriteW"/u);
  assert.match(source, /EntryPoint = "CredDeleteW"/u);
  assert.match(source, /LocalMachinePersistence = 2/u);
  assert.match(source, /Comment = null/u);
  assert.match(source, /AttributeCount = 0/u);
  assert.match(source, /TargetAlias = null/u);
  assert.match(source, /UserName = null/u);
  assert.match(source, /framedBundle = FrameBundle\(bundle\)/u);
  assert.match(
    source,
    /ProtectedData\.Protect\(framedBundle, input\[0\], DataProtectionScope\.CurrentUser\)/u,
  );
  assert.match(source, /Clear\(framedBundle\)/u);
  assert.doesNotMatch(source, /WriteOutput\((?:bundle|framedBundle)\)/u);
  assert.match(source, /ReadInstalledClient/u);
  assert.match(source, /File\.ReadAllBytes/u);
  assert.match(source, /client_secret/u);
  assert.match(source, /\{ "client_secret", clientSecret \}/u);
  assert.match(source, /code === 9[\s\S]*Gmail OAuth client invalid/u);
  assert.match(source, /code === 10[\s\S]*Gmail sender policy invalid/u);
  assert.match(source, /code === 11[\s\S]*Gmail refresh grant invalid/u);
  assert.equal(source.match(/\{ "client_secret", clientSecret \}/gu)?.length, 2);
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
  const authorizeMethod = /private static HuntGmailToken Authorize[\s\S]*?private static string ReceiveCode/u.exec(source)?.[0] ?? "";
  assert.doesNotMatch(authorizeMethod, /senderAddress|senderPolicy|notifications@/iu);
  const bundleBlock = /IDictionary<string, object> exactBundle[\s\S]*?WriteOutput\(sealedValue\)/u.exec(source)?.[0] ?? "";
  assert.doesNotMatch(bundleBlock, /login_hint|loginHint|accountEmail/u);
  assert.match(source, /windowsHide:\s*false/u);
  assert.match(source, /shell:\s*false/u);
  assert.doesNotMatch(source, /process\.env|refresh_token[^\n]*bundle/iu);
  assert.doesNotMatch(source, /Write-(?:Output|Error|Host)|console\.(?:log|error)/iu);
});

test("trusted authorization URL contains one encoded private login hint", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const root = await mkdtemp(join(tmpdir(), "hunt-login-hint-url-"));
  try {
    const sourcePath = join(root, "helper.cs");
    await writeFile(sourcePath, csharp);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        "Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; $method=[HuntInteractiveGmailOAuthSealer].GetMethod('AuthorizationUrl',[Reflection.BindingFlags]'NonPublic,Static'); try { $url=$method.Invoke($null,@('1234567890-example1.apps.googleusercontent.com','http://127.0.0.1:43210/oauth2callback','state-value','challenge-value','person+tag@example.invalid')) } catch { exit 31 }; $uri=[Uri]$url; $query=[System.Web.HttpUtility]::ParseQueryString($uri.Query); $hints=$query.GetValues('login_hint'); if($uri.GetLeftPart([UriPartial]::Path) -ne 'https://accounts.google.com/o/oauth2/v2/auth' -or $query.AllKeys.Length -ne 10 -or $null -eq $hints -or $hints.Length -ne 1 -or $hints[0] -ne 'person+tag@example.invalid' -or $query.GetValues('access_type').Length -ne 1 -or $query['access_type'] -ne 'offline' -or $query.GetValues('prompt').Length -ne 1 -or $query['prompt'] -ne 'consent' -or -not $url.Contains('login_hint=person%2btag%40example.invalid')) { exit 32 }; exit 0",
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
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted helper derives one deterministic opaque grant target", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-grant-target-"));
  const clientId = "1234567890-example1.apps.googleusercontent.com";
  const email = "person@example.invalid";
  try {
    const sourcePath = join(root, "helper.cs");
    const outputPath = join(root, "target.txt");
    await writeFile(sourcePath, csharp);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        "Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; $method=[HuntInteractiveGmailOAuthSealer].GetMethod('GrantTarget',[Reflection.BindingFlags]'NonPublic,Static'); if($null -eq $method) { exit 51 }; $first=$method.Invoke($null,@($env:HUNT_TEST_CLIENT,$env:HUNT_TEST_EMAIL)); $second=$method.Invoke($null,@($env:HUNT_TEST_CLIENT,'PERSON@example.invalid')); if($first -ne $second) { exit 52 }; [IO.File]::WriteAllText($env:HUNT_TEST_OUTPUT,$first,[Text.Encoding]::ASCII); exit 0",
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
          HUNT_TEST_CLIENT: clientId,
          HUNT_TEST_EMAIL: email,
          HUNT_TEST_OUTPUT: outputPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const target = await readFile(outputPath, "ascii");
    const digest = createHash("sha256")
      .update(`hunt-c3-gmail-refresh-grant-v1\0${clientId}\0${email}`)
      .digest("hex");
    assert.equal(target, `Hunt/C3/GmailRefresh/v1/${digest}`);
    assert.doesNotMatch(target, /person|example|@/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted helper exact-parses interactive and refresh token responses", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-token-parser-"));
  try {
    const sourcePath = join(root, "helper.cs");
    await writeFile(sourcePath, csharp);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        `$source=$env:HUNT_TEST_SOURCE; Add-Type -Path $source -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; $flags=[Reflection.BindingFlags]'NonPublic,Static'; $method=[HuntInteractiveGmailOAuthSealer].GetMethod('ParseTokenResponse',$flags); $exact=[HuntInteractiveGmailOAuthSealer].GetMethod('ExactObject',$flags); if($null -eq $method -or $null -eq $exact) { exit 61 }; $at=[DateTimeOffset]::Parse('2026-08-01T12:00:00.000Z'); function Parse($json,$required) { $value=$exact.Invoke($null,@($json)); return $method.Invoke($null,@($value,$required,$at)) }; $interactive='{"access_token":"access-value","expires_in":3600,"refresh_token":"refresh-value","scope":"https://www.googleapis.com/auth/gmail.readonly","token_type":"Bearer"}'; $refresh='{"access_token":"access-value-2","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.readonly","token_type":"Bearer"}'; $rotated='{"access_token":"access-value-3","expires_in":3600,"refresh_token":"refresh-value-2","scope":"https://www.googleapis.com/auth/gmail.readonly","token_type":"Bearer"}'; try { $one=Parse $interactive $true; $two=Parse $refresh $false; $three=Parse $rotated $false; if($one.RefreshValue.Length -lt 1 -or $null -ne $two.RefreshValue -or $three.RefreshValue.Length -lt 1) { exit 62 }; $one.Clear(); $two.Clear(); $three.Clear() } catch { exit 63 }; foreach($invalid in @('{"access_token":"a","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.readonly","token_type":"Bearer"}','{"access_token":"a","expires_in":3600,"refresh_token":"r","scope":"https://www.googleapis.com/auth/gmail.readonly","token_type":"Bearer","extra":true}','{"access_token":"a","expires_in":3600,"refresh_token":"r","scope":"wrong","token_type":"Bearer"}')) { try { $bad=Parse $invalid $true; $bad.Clear(); exit 64 } catch {} }; exit 0`,
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
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted grant flow covers missing, existing, invalid, rotated, mismatch, and revoke branches", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const fakes = String.raw`
public sealed class HuntTestGrantStore : IHuntGmailGrantStore
{
    public byte[] Value;
    public byte[] LastRead;
    public byte[] LastWrite;
    public string LastTarget;
    public int Reads;
    public int Writes;
    public int Deletes;

    public byte[] Read(string target)
    {
        Reads++;
        LastTarget = target;
        if (Value == null) return null;
        LastRead = (byte[])Value.Clone();
        return LastRead;
    }

    public void Write(string target, byte[] value)
    {
        Writes++;
        LastTarget = target;
        LastWrite = value;
        Value = (byte[])value.Clone();
    }

    public bool Delete(string target)
    {
        Deletes++;
        LastTarget = target;
        bool existed = Value != null;
        if (Value != null) Array.Clear(Value, 0, Value.Length);
        Value = null;
        return existed;
    }
}

public sealed class HuntTestOAuthClient : IHuntGmailOAuthClient
{
    public string Scenario;
    public int InteractiveCalls;
    public int RefreshCalls;
    public int ProfileCalls;
    public byte[] LastRefreshView;

    public HuntTestOAuthClient(string scenario) { Scenario = scenario; }

    public HuntGmailToken AuthorizeInteractive(string clientId, string clientSecret, string loginHint)
    {
        InteractiveCalls++;
        HuntGmailToken token = Token("interactive-access", Encoding.UTF8.GetBytes("interactive-refresh"));
        LastRefreshView = token.RefreshValue;
        return token;
    }

    public HuntGmailToken Refresh(string clientId, string clientSecret, byte[] refreshValue)
    {
        RefreshCalls++;
        if (Scenario == "invalid") throw new InvalidOperationException();
        byte[] rotated = Scenario == "rotated" ? Encoding.UTF8.GetBytes("rotated-refresh") : null;
        HuntGmailToken token = Token("refreshed-access", rotated);
        LastRefreshView = token.RefreshValue;
        return token;
    }

    public string ProfileEmail(string accessValue)
    {
        ProfileCalls++;
        return Scenario == "mismatch" ? "other@example.invalid" : "person@example.invalid";
    }

    private static HuntGmailToken Token(string access, byte[] refresh)
    {
        return new HuntGmailToken {
            AccessValue = access,
            RefreshValue = refresh,
            ExpiresIn = 3600,
            ReceivedAt = DateTimeOffset.Parse("2026-08-01T12:00:00.000Z")
        };
    }
}
`;
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-grant-flow-"));
  try {
    const sourcePath = join(root, "helper.cs");
    const fakesPath = join(root, "fakes.cs");
    const outputPath = join(root, "result.json");
    await Promise.all([
      writeFile(sourcePath, `${csharp}\n${fakes}`),
      writeFile(fakesPath, "public sealed class HuntTestAssemblyMarker {}"),
    ]);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        `$refs='System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies $refs; Add-Type -Path $env:HUNT_TEST_FAKES -ReferencedAssemblies $refs; $flags=[Reflection.BindingFlags]'NonPublic,Static'; $acquire=[HuntInteractiveGmailOAuthSealer].GetMethod('AcquireToken',$flags); $delete=[HuntInteractiveGmailOAuthSealer].GetMethod('DeleteGrant',$flags); if($null -eq $acquire -or $null -eq $delete) { exit 71 }; function Cleared($value) { if($null -eq $value) { return $false }; foreach($item in $value) { if($item -ne 0) { return $false } }; return $true }; function Case($scenario,$existing) { $store=[HuntTestGrantStore]::new(); if($existing) { $store.Value=[Text.Encoding]::UTF8.GetBytes('stored-refresh') }; $oauth=[HuntTestOAuthClient]::new($scenario); $token=$null; $exitCode=0; try { $token=$acquire.Invoke($null,@('1234567890-example1.apps.googleusercontent.com','client-secret','person@example.invalid',$store,$oauth)) } catch { $inner=$_.Exception.InnerException; $exitCode=if($null -ne $inner -and $null -ne $inner.GetType().GetProperty('ExitCode')) { $inner.ExitCode } else { 99 } }; if($null -ne $token) { $token.Clear() }; return [pscustomobject]@{ scenario=$scenario; exitCode=$exitCode; interactive=$oauth.InteractiveCalls; refresh=$oauth.RefreshCalls; profile=$oauth.ProfileCalls; reads=$store.Reads; writes=$store.Writes; readCleared=(Cleared $store.LastRead); writeCleared=(Cleared $store.LastWrite); issuedCleared=(Cleared $oauth.LastRefreshView); opaque=($store.LastTarget -match '^Hunt/C3/GmailRefresh/v1/[0-9a-f]{64}$' -and -not $store.LastTarget.Contains('person')) } }; $cases=@((Case 'missing' $false),(Case 'existing' $true),(Case 'invalid' $true),(Case 'rotated' $true),(Case 'mismatch' $false)); $revoke=[HuntTestGrantStore]::new(); $revoke.Value=[Text.Encoding]::UTF8.GetBytes('stored-refresh'); $deleted=$delete.Invoke($null,@('1234567890-example1.apps.googleusercontent.com','person@example.invalid',$revoke)); $output=[pscustomobject]@{ cases=$cases; revoke=[pscustomobject]@{ deleted=$deleted; deletes=$revoke.Deletes; opaque=($revoke.LastTarget -match '^Hunt/C3/GmailRefresh/v1/[0-9a-f]{64}$' -and -not $revoke.LastTarget.Contains('person')) } }; $utf8=New-Object Text.UTF8Encoding($false); [IO.File]::WriteAllText($env:HUNT_TEST_OUTPUT,($output | ConvertTo-Json -Depth 5 -Compress),$utf8); exit 0`,
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
          HUNT_TEST_FAKES: fakesPath,
          HUNT_TEST_OUTPUT: outputPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(await readFile(outputPath, "utf8")) as {
      cases: Array<Record<string, boolean | number | string>>;
      revoke: Record<string, boolean | number>;
    };
    assert.deepEqual(value.cases, [
      { scenario: "missing", exitCode: 0, interactive: 1, refresh: 0, profile: 1, reads: 1, writes: 1, readCleared: false, writeCleared: true, issuedCleared: true, opaque: true },
      { scenario: "existing", exitCode: 0, interactive: 0, refresh: 1, profile: 1, reads: 1, writes: 0, readCleared: true, writeCleared: false, issuedCleared: false, opaque: true },
      { scenario: "invalid", exitCode: 11, interactive: 0, refresh: 1, profile: 0, reads: 1, writes: 0, readCleared: true, writeCleared: false, issuedCleared: false, opaque: true },
      { scenario: "rotated", exitCode: 0, interactive: 0, refresh: 1, profile: 1, reads: 1, writes: 1, readCleared: true, writeCleared: true, issuedCleared: true, opaque: true },
      { scenario: "mismatch", exitCode: 4, interactive: 1, refresh: 0, profile: 1, reads: 1, writes: 0, readCleared: false, writeCleared: false, issuedCleared: true, opaque: true },
    ]);
    assert.deepEqual(value.revoke, { deleted: true, deletes: 1, opaque: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
