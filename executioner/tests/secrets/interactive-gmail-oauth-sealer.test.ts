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
  WindowsGmailRefreshGrantRevoker,
  WindowsInteractiveGmailOAuthSealer,
  type GmailRefreshGrantRevokeRequest,
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

  async reconcile(): Promise<void> {}
}

class PersistThenFailProcess implements InteractiveGmailOAuthProcess {
  persisted = false;
  reconcileInput?: Uint8Array;
  readonly #failure: Error;
  readonly #reconcileFailure?: Error;

  constructor(failure: Error, reconcileFailure?: Error) {
    this.#failure = failure;
    this.#reconcileFailure = reconcileFailure;
  }

  async run(): Promise<Uint8Array> {
    this.persisted = true;
    throw this.#failure;
  }

  async reconcile(input: Uint8Array): Promise<void> {
    this.reconcileInput = Uint8Array.from(input);
    if (this.#reconcileFailure !== undefined) throw this.#reconcileFailure;
    this.persisted = false;
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

const revokeRequest: GmailRefreshGrantRevokeRequest = {
  recipientBindingId: "recipient_abcdefghijklmnop",
  clientId: "1234567890-example1.apps.googleusercontent.com",
  installedClientConfigPath:
    "C:\\Users\\example\\AppData\\Local\\Hunt\\google-installed-client.json",
};

function revokeFrame(outcome: "absent" | "revoked"): Uint8Array {
  return Uint8Array.from([
    72, 65, 71, 82,
    1,
    outcome === "revoked" ? 1 : 0,
  ]);
}

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

test("refresh-grant revoker emits one value-free operation frame and clears child input", async () => {
  for (const outcome of ["absent", "revoked"] as const) {
    const process = new ReplyProcess(revokeFrame(outcome));
    const result = await new WindowsGmailRefreshGrantRevoker({ process }).revoke(
      revokeRequest,
      new AbortController().signal,
    );
    assert.equal(result, outcome);
    assert.equal(process.input?.every((value) => value === 0), true);
    const captured = Buffer.from(process.capturedInput ?? []);
    assert.equal(captured.subarray(0, 4).toString("ascii"), "HAGR");
    assert.equal(captured[4], 1);
    assert.equal(captured[5], 3);
    assert.equal(captured.includes(Buffer.from(revokeRequest.recipientBindingId)), true);
    assert.equal(captured.includes(Buffer.from(revokeRequest.clientId)), true);
    assert.equal(
      captured.includes(Buffer.from(revokeRequest.installedClientConfigPath)),
      true,
    );
    assert.equal(captured.includes(Buffer.from("person@example.invalid")), false);
    assert.equal(captured.includes(Buffer.from("refresh")), false);
  }
});

test("refresh-grant revoker preserves exact value-free child errors", async () => {
  for (const message of [
    "Gmail refresh grant invalid",
    "Gmail refresh unavailable",
  ]) {
    await assert.rejects(
      new WindowsGmailRefreshGrantRevoker({
        process: new ReplyProcess(new Error(message)),
      }).revoke(revokeRequest, new AbortController().signal),
      new RegExp(message, "u"),
    );
  }
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
  await assert.rejects(
    new WindowsInteractiveGmailOAuthSealer({
      process: new ReplyProcess(new Error("Gmail refresh unavailable")),
    }).seal(request, new AbortController().signal),
    /Gmail refresh unavailable/u,
  );
});

test("timeout and cancellation reconcile an uncertain durable refresh grant before failing", async () => {
  for (const message of ["Gmail OAuth timeout", "Gmail OAuth cancelled"] as const) {
    const process = new PersistThenFailProcess(new Error(message));
    await assert.rejects(
      new WindowsInteractiveGmailOAuthSealer({ process }).seal(
        request,
        new AbortController().signal,
      ),
      new RegExp(message, "u"),
    );
    assert.equal(process.persisted, false);
    const input = Buffer.from(process.reconcileInput ?? []);
    assert.equal(input.subarray(0, 4).toString("ascii"), "HAGC");
    assert.equal(input[4], 1);
    assert.equal(input[5], 5);
    assert.equal(input.includes(Buffer.from(request.binding.recipientBindingId)), true);
    assert.equal(input.includes(Buffer.from(request.clientId)), true);
    assert.equal(input.includes(Buffer.from(request.installedClientConfigPath)), true);
    assert.equal(input.includes(Buffer.from("person@example.invalid")), false);
    assert.equal(input.includes(Buffer.from("refresh")), false);
  }
});

test("failed durable-grant reconciliation outranks a timeout or cancellation report", async () => {
  for (const message of ["Gmail OAuth timeout", "Gmail OAuth cancelled"] as const) {
    const process = new PersistThenFailProcess(
      new Error(message),
      new Error("synthetic cleanup detail"),
    );
    await assert.rejects(
      new WindowsInteractiveGmailOAuthSealer({ process }).seal(
        request,
        new AbortController().signal,
      ),
      /^Error: Gmail OAuth reconciliation failed$/u,
    );
    assert.equal(process.persisted, true);
  }
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
  assert.match(source, /AcquireTokenWithLookup\([\s\S]*new WindowsCredentialManagerGrantStore\(\)[\s\S]*new WindowsGmailOAuthClient\(\)/u);
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
  assert.match(source, /WriteReconcileOutput\(DeleteFromInput\(input\)\)/u);
  assert.match(source, /LocalMachinePersistence = 2/u);
  assert.match(source, /MaximumRefreshGrantBytes = 512/u);
  assert.match(source, /Hunt\/C3\/GmailRefreshLookup\/v1\//u);
  assert.match(source, /AcquireTokenWithLookup/u);
  assert.match(source, /EnsureGrantLookup/u);
  assert.match(source, /DeleteExactGrantAndLookup/u);
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
  assert.match(source, /code === 12[\s\S]*Gmail refresh unavailable/u);
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
  const cancelBlock = /const cancel = \(\) => \{[\s\S]*?\n      \};/u.exec(source)?.[0] ?? "";
  assert.match(cancelBlock, /terminalError = new Error\("Gmail OAuth cancelled"\)/u);
  assert.match(cancelBlock, /child\.kill\(\)/u);
  assert.doesNotMatch(cancelBlock, /finish\(/u);
  assert.match(
    source,
    /child\.once\("close", \(code\) => \{\s*if \(terminalError !== undefined\) \{\s*finish\(terminalError\)/u,
  );
  assert.doesNotMatch(source, /process\.env|refresh_token[^\n]*bundle/iu);
  assert.doesNotMatch(source, /Write-(?:Output|Error|Host)|console\.(?:log|error)/iu);
  const revokeInputBlock = /private static bool RevokeFromInput[\s\S]*?private static bool DeleteFromInput/u
    .exec(source)?.[0] ?? "";
  assert.doesNotMatch(revokeInputBlock, /ProtectedData|ReadAccountEmail|accountCiphertext/u);
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
      .update(
        `hunt-c3-gmail-refresh-grant-v1\0${clientId}\0${email}\0` +
          "https://www.googleapis.com/auth/gmail.readonly",
      )
      .digest("hex");
    assert.equal(target, `Hunt/C3/GmailRefresh/v1/${digest}`);
    assert.doesNotMatch(target, /person|example|@/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted helper derives one scope-bound lookup target from only the value-free recipient binding", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-grant-lookup-target-"));
  try {
    const sourcePath = join(root, "helper.cs");
    const outputPath = join(root, "target.txt");
    await writeFile(sourcePath, csharp);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        "$refs='System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies $refs; $flags=[Reflection.BindingFlags]'NonPublic,Static'; $target=[HuntInteractiveGmailOAuthSealer].GetMethod('LookupTarget',$flags); $valid=[HuntInteractiveGmailOAuthSealer].GetMethod('ValidRecipientBindingId',$flags); if($null -eq $target -or $null -eq $valid) { exit 53 }; if(-not $valid.Invoke($null,@('recipient_abcdefghijklmnop')) -or $valid.Invoke($null,@('recipient_short')) -or $valid.Invoke($null,@('recipient_abcdefghijklmnop.'))) { exit 54 }; $value=$target.Invoke($null,@($env:HUNT_TEST_CLIENT,'recipient_abcdefghijklmnop')); [IO.File]::WriteAllText($env:HUNT_TEST_OUTPUT,$value,[Text.Encoding]::ASCII); exit 0",
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
          HUNT_TEST_CLIENT: revokeRequest.clientId,
          HUNT_TEST_OUTPUT: outputPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const target = await readFile(outputPath, "ascii");
    const digest = createHash("sha256")
      .update(
        `hunt-c3-gmail-refresh-lookup-v1\0${revokeRequest.clientId}\0` +
          `${revokeRequest.recipientBindingId}\0` +
          "https://www.googleapis.com/auth/gmail.readonly",
      )
      .digest("hex");
    assert.equal(target, `Hunt/C3/GmailRefreshLookup/v1/${digest}`);
    assert.doesNotMatch(target, /recipient|person|example|@/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful acquisition installs an exact lookup and lookup failure removes both durable entries", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const fakes = String.raw`
public sealed class HuntLookupStore : IHuntGmailGrantStore
{
    public Dictionary<string, byte[]> Values = new Dictionary<string, byte[]>();
    public bool FailLookupWrite;
    public int Deletes;

    public byte[] Read(string target)
    {
        byte[] value;
        return Values.TryGetValue(target, out value) ? (byte[])value.Clone() : null;
    }

    public void Write(string target, byte[] value)
    {
        if (FailLookupWrite && target.StartsWith("Hunt/C3/GmailRefreshLookup/v1/"))
            throw new InvalidOperationException();
        Values[target] = (byte[])value.Clone();
    }

    public bool Delete(string target)
    {
        Deletes++;
        byte[] value;
        if (!Values.TryGetValue(target, out value)) return false;
        Array.Clear(value, 0, value.Length);
        Values.Remove(target);
        return true;
    }
}

public sealed class HuntLookupOAuth : IHuntGmailOAuthClient
{
    public HuntGmailToken AuthorizeInteractive(string clientId, string clientSecret, string loginHint)
    {
        return Token("interactive", Encoding.UTF8.GetBytes("new-refresh"));
    }

    public HuntGmailToken Refresh(string clientId, string clientSecret, byte[] refreshValue)
    {
        return Token("refreshed", null);
    }

    public string ProfileEmail(string accessValue, bool usedExistingGrant)
    {
        return "person@example.invalid";
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
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-lookup-flow-"));
  try {
    const sourcePath = join(root, "helper.cs");
    await writeFile(sourcePath, `${csharp}\n${fakes}`);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        `$refs='System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies $refs; $flags=[Reflection.BindingFlags]'NonPublic,Static'; $type=[HuntInteractiveGmailOAuthSealer]; $acquire=$type.GetMethod('AcquireTokenWithLookup',$flags); $grantTarget=$type.GetMethod('GrantTarget',$flags); $lookupTarget=$type.GetMethod('LookupTarget',$flags); $cleanup=$type.GetMethod('DeleteGrantAndLookup',$flags); if($null -eq $acquire -or $null -eq $grantTarget -or $null -eq $lookupTarget -or $null -eq $cleanup) { exit 55 }; $client='1234567890-example1.apps.googleusercontent.com'; $email='person@example.invalid'; $recipient='recipient_abcdefghijklmnop'; $grant=[string]$grantTarget.Invoke($null,@($client,$email)); $lookup=[string]$lookupTarget.Invoke($null,@($client,$recipient)); function Acquire($store) { try { $token=$acquire.Invoke($null,@($client,'client-secret',$email,$recipient,$store,[HuntLookupOAuth]::new())); $token.Clear(); return 0 } catch { $inner=$_.Exception.InnerException; if($null -ne $inner -and $null -ne $inner.GetType().GetProperty('ExitCode')) { return $inner.ExitCode }; return 99 } }; $fresh=[HuntLookupStore]::new(); if((Acquire $fresh) -ne 0 -or -not $fresh.Values.ContainsKey($grant) -or -not $fresh.Values.ContainsKey($lookup) -or [Text.Encoding]::ASCII.GetString($fresh.Values[$lookup]) -ne $grant.Substring($grant.Length-64)) { exit 56 }; $existing=[HuntLookupStore]::new(); $existing.Values[$grant]=[Text.Encoding]::UTF8.GetBytes('stored-refresh'); if((Acquire $existing) -ne 0 -or -not $existing.Values.ContainsKey($grant) -or -not $existing.Values.ContainsKey($lookup)) { exit 57 }; $failed=[HuntLookupStore]::new(); $failed.FailLookupWrite=$true; if((Acquire $failed) -ne 11 -or $failed.Values.Count -ne 0 -or $failed.Deletes -lt 2) { exit 58 }; $mismatch=[HuntLookupStore]::new(); $mismatch.Values[$grant]=[Text.Encoding]::UTF8.GetBytes('stored-refresh'); $mismatch.Values[$lookup]=[Text.Encoding]::ASCII.GetBytes(('0'*64)); if((Acquire $mismatch) -ne 11 -or $mismatch.Values.Count -ne 0 -or $mismatch.Deletes -lt 2) { exit 59 }; $cleanupStore=[HuntLookupStore]::new(); $cleanupStore.Values[$grant]=[Text.Encoding]::UTF8.GetBytes('stored-refresh'); $cleanupStore.Values[$lookup]=[Text.Encoding]::ASCII.GetBytes($grant.Substring($grant.Length-64)); if(-not $cleanup.Invoke($null,@($client,$email,$recipient,$cleanupStore)) -or $cleanupStore.Values.Count -ne 0 -or $cleanupStore.Deletes -ne 2) { exit 60 }; exit 0`,
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

test("trusted helper enforces the exact 512-byte refresh-grant bound", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-grant-bound-"));
  try {
    const sourcePath = join(root, "helper.cs");
    await writeFile(sourcePath, csharp);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        `$refs='System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies $refs; $flags=[Reflection.BindingFlags]'NonPublic,Static'; $valid=[HuntInteractiveGmailOAuthSealer].GetMethod('ValidGrant',$flags); $parse=[HuntInteractiveGmailOAuthSealer].GetMethod('ParseTokenResponse',$flags); $exact=[HuntInteractiveGmailOAuthSealer].GetMethod('ExactObject',$flags); if($null -eq $valid -or $null -eq $parse -or $null -eq $exact) { exit 81 }; $bytes512=[Text.Encoding]::ASCII.GetBytes('r'*512); $bytes513=[Text.Encoding]::ASCII.GetBytes('r'*513); if(-not $valid.Invoke($null,@(,$bytes512)) -or $valid.Invoke($null,@(,$bytes513))) { exit 82 }; function Parse($refresh) { $json='{"access_token":"access","expires_in":3600,"refresh_token":"'+$refresh+'","scope":"https://www.googleapis.com/auth/gmail.readonly","token_type":"Bearer"}'; $value=$exact.Invoke($null,@($json)); return $parse.Invoke($null,@($value,$true,[DateTimeOffset]::Parse('2026-08-01T12:00:00.000Z'))) }; try { $token=Parse ('r'*512); $token.Clear() } catch { exit 83 }; try { $token=Parse ('r'*513); $token.Clear(); exit 84 } catch {}; exit 0`,
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

test("trusted helper classifies exact transient refresh transport outcomes", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-refresh-classifier-"));
  try {
    const sourcePath = join(root, "helper.cs");
    await writeFile(sourcePath, csharp);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        `$refs='System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies $refs; $method=[HuntInteractiveGmailOAuthSealer].GetMethod('RefreshResponseUnavailable',[Reflection.BindingFlags]'NonPublic,Static'); if($null -eq $method) { exit 91 }; function IsUnavailable($status,$http) { return $method.Invoke($null,@([Net.WebExceptionStatus]$status,$http)) }; if(-not (IsUnavailable 'ConnectFailure' 0) -or -not (IsUnavailable 'Timeout' 0) -or -not (IsUnavailable 'ProtocolError' 408) -or -not (IsUnavailable 'ProtocolError' 429) -or -not (IsUnavailable 'ProtocolError' 500) -or -not (IsUnavailable 'ProtocolError' 503) -or (IsUnavailable 'ProtocolError' 400) -or (IsUnavailable 'ProtocolError' 401) -or (IsUnavailable 'ProtocolError' 403)) { exit 92 }; exit 0`,
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

    public string ProfileEmail(string accessValue, bool usedExistingGrant)
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

test("trusted grant flow preserves stored grants across invalid and transient refresh failures", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const fakes = String.raw`
public sealed class HuntRefreshRepairStore : IHuntGmailGrantStore
{
    public byte[] Value = Encoding.UTF8.GetBytes("stored-refresh");
    public byte[] LastRead;
    public int Reads;
    public int Writes;
    public int Deletes;

    public byte[] Read(string target)
    {
        Reads++;
        LastRead = (byte[])Value.Clone();
        return LastRead;
    }

    public void Write(string target, byte[] value) { Writes++; }
    public bool Delete(string target) { Deletes++; return true; }
}

public sealed class HuntRefreshRepairOAuth : IHuntGmailOAuthClient
{
    public string Scenario;
    public int InteractiveCalls;
    public int RefreshCalls;
    public int ProfileCalls;

    public HuntRefreshRepairOAuth(string scenario) { Scenario = scenario; }

    public HuntGmailToken AuthorizeInteractive(string clientId, string clientSecret, string loginHint)
    {
        InteractiveCalls++;
        throw new InvalidOperationException();
    }

    public HuntGmailToken Refresh(string clientId, string clientSecret, byte[] refreshValue)
    {
        RefreshCalls++;
        if (Scenario == "invalid") throw new InvalidOperationException();
        if (RefreshCalls == 1) throw new HuntGmailRefreshUnavailableException();
        return new HuntGmailToken {
            AccessValue = "refreshed-access",
            RefreshValue = null,
            ExpiresIn = 3600,
            ReceivedAt = DateTimeOffset.Parse("2026-08-01T12:00:00.000Z")
        };
    }

    public string ProfileEmail(string accessValue, bool usedExistingGrant)
    {
        ProfileCalls++;
        return "person@example.invalid";
    }
}
`;
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-refresh-repair-"));
  try {
    const sourcePath = join(root, "helper.cs");
    const outputPath = join(root, "result.json");
    await writeFile(sourcePath, `${csharp}\n${fakes}`);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        `$refs='System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies $refs; $method=[HuntInteractiveGmailOAuthSealer].GetMethod('AcquireToken',[Reflection.BindingFlags]'NonPublic,Static'); if($null -eq $method) { exit 101 }; function Cleared($value) { if($null -eq $value) { return $false }; foreach($item in $value) { if($item -ne 0) { return $false } }; return $true }; function InvokeAcquire($store,$oauth) { try { $token=$method.Invoke($null,@('1234567890-example1.apps.googleusercontent.com','client-secret','person@example.invalid',$store,$oauth)); $token.Clear(); return 0 } catch { $inner=$_.Exception.InnerException; if($null -ne $inner -and $null -ne $inner.GetType().GetProperty('ExitCode')) { return $inner.ExitCode }; return 99 } }; $transientStore=[HuntRefreshRepairStore]::new(); $transientOauth=[HuntRefreshRepairOAuth]::new('unavailable_once'); $first=InvokeAcquire $transientStore $transientOauth; $firstReadCleared=Cleared $transientStore.LastRead; $second=InvokeAcquire $transientStore $transientOauth; $invalidStore=[HuntRefreshRepairStore]::new(); $invalidOauth=[HuntRefreshRepairOAuth]::new('invalid'); $invalid=InvokeAcquire $invalidStore $invalidOauth; $output=[pscustomobject]@{ transient=[pscustomobject]@{ first=$first; second=$second; interactive=$transientOauth.InteractiveCalls; refresh=$transientOauth.RefreshCalls; profile=$transientOauth.ProfileCalls; writes=$transientStore.Writes; deletes=$transientStore.Deletes; firstReadCleared=$firstReadCleared; preserved=([Text.Encoding]::UTF8.GetString($transientStore.Value) -eq 'stored-refresh') }; invalid=[pscustomobject]@{ exitCode=$invalid; interactive=$invalidOauth.InteractiveCalls; refresh=$invalidOauth.RefreshCalls; profile=$invalidOauth.ProfileCalls; writes=$invalidStore.Writes; deletes=$invalidStore.Deletes; readCleared=(Cleared $invalidStore.LastRead); preserved=([Text.Encoding]::UTF8.GetString($invalidStore.Value) -eq 'stored-refresh') } }; $utf8=New-Object Text.UTF8Encoding($false); [IO.File]::WriteAllText($env:HUNT_TEST_OUTPUT,($output | ConvertTo-Json -Depth 5 -Compress),$utf8); exit 0`,
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
          HUNT_TEST_OUTPUT: outputPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
      transient: {
        first: 12,
        second: 0,
        interactive: 0,
        refresh: 2,
        profile: 1,
        writes: 0,
        deletes: 0,
        firstReadCleared: true,
        preserved: true,
      },
      invalid: {
        exitCode: 11,
        interactive: 0,
        refresh: 1,
        profile: 0,
        writes: 0,
        deletes: 0,
        readCleared: true,
        preserved: true,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted grant flow classifies post-refresh profile failures without losing the grant", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const fakes = String.raw`
public sealed class HuntProfileRepairStore : IHuntGmailGrantStore
{
    public byte[] Value = Encoding.UTF8.GetBytes("stored-refresh");
    public int Reads;
    public int Writes;
    public int Deletes;

    public byte[] Read(string target) { Reads++; return (byte[])Value.Clone(); }
    public void Write(string target, byte[] value) { Writes++; }
    public bool Delete(string target) { Deletes++; return true; }
}

public sealed class HuntProfileRepairOAuth : IHuntGmailOAuthClient
{
    public string Scenario;
    public int InteractiveCalls;
    public int RefreshCalls;
    public int ProfileCalls;
    public bool LastProfileUsedGrant;

    public HuntProfileRepairOAuth(string scenario) { Scenario = scenario; }

    public HuntGmailToken AuthorizeInteractive(string clientId, string clientSecret, string loginHint)
    {
        InteractiveCalls++;
        throw new InvalidOperationException();
    }

    public HuntGmailToken Refresh(string clientId, string clientSecret, byte[] refreshValue)
    {
        RefreshCalls++;
        return new HuntGmailToken {
            AccessValue = "refreshed-access",
            RefreshValue = null,
            ExpiresIn = 3600,
            ReceivedAt = DateTimeOffset.Parse("2026-08-01T12:00:00.000Z")
        };
    }

    public string ProfileEmail(string accessValue, bool usedExistingGrant)
    {
        ProfileCalls++;
        LastProfileUsedGrant = usedExistingGrant;
        if (Scenario == "unavailable_once" && ProfileCalls == 1)
            throw new HuntGmailRefreshUnavailableException();
        if (Scenario == "invalid") throw new InvalidOperationException();
        if (Scenario == "mismatch") return "other@example.invalid";
        return "person@example.invalid";
    }
}
`;
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-profile-repair-"));
  try {
    const sourcePath = join(root, "helper.cs");
    const outputPath = join(root, "result.json");
    await writeFile(sourcePath, `${csharp}\n${fakes}`);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        `$refs='System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies $refs; $method=[HuntInteractiveGmailOAuthSealer].GetMethod('AcquireToken',[Reflection.BindingFlags]'NonPublic,Static'); if($null -eq $method) { exit 111 }; function InvokeAcquire($store,$oauth) { try { $token=$method.Invoke($null,@('1234567890-example1.apps.googleusercontent.com','client-secret','person@example.invalid',$store,$oauth)); $token.Clear(); return 0 } catch { $inner=$_.Exception.InnerException; if($null -ne $inner -and $null -ne $inner.GetType().GetProperty('ExitCode')) { return $inner.ExitCode }; return 99 } }; function Case($scenario) { $store=[HuntProfileRepairStore]::new(); $oauth=[HuntProfileRepairOAuth]::new($scenario); $exitCode=InvokeAcquire $store $oauth; return [pscustomobject]@{ exitCode=$exitCode; interactive=$oauth.InteractiveCalls; refresh=$oauth.RefreshCalls; profile=$oauth.ProfileCalls; profileUsedGrant=$oauth.LastProfileUsedGrant; writes=$store.Writes; deletes=$store.Deletes; preserved=([Text.Encoding]::UTF8.GetString($store.Value) -eq 'stored-refresh') } }; $transientStore=[HuntProfileRepairStore]::new(); $transientOauth=[HuntProfileRepairOAuth]::new('unavailable_once'); $first=InvokeAcquire $transientStore $transientOauth; $second=InvokeAcquire $transientStore $transientOauth; $output=[pscustomobject]@{ transient=[pscustomobject]@{ first=$first; second=$second; interactive=$transientOauth.InteractiveCalls; refresh=$transientOauth.RefreshCalls; profile=$transientOauth.ProfileCalls; profileUsedGrant=$transientOauth.LastProfileUsedGrant; writes=$transientStore.Writes; deletes=$transientStore.Deletes; preserved=([Text.Encoding]::UTF8.GetString($transientStore.Value) -eq 'stored-refresh') }; invalid=(Case 'invalid'); mismatch=(Case 'mismatch') }; $utf8=New-Object Text.UTF8Encoding($false); [IO.File]::WriteAllText($env:HUNT_TEST_OUTPUT,($output | ConvertTo-Json -Depth 5 -Compress),$utf8); exit 0`,
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
          HUNT_TEST_OUTPUT: outputPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const failure = {
      interactive: 0,
      refresh: 1,
      profile: 1,
      profileUsedGrant: true,
      writes: 0,
      deletes: 0,
      preserved: true,
    };
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
      transient: {
        first: 12,
        second: 0,
        interactive: 0,
        refresh: 2,
        profile: 2,
        profileUsedGrant: true,
        writes: 0,
        deletes: 0,
        preserved: true,
      },
      invalid: { exitCode: 11, ...failure },
      mismatch: { exitCode: 11, ...failure },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted revocation flow covers missing, success, provider-invalid, transient, and malformed grants", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const fakes = String.raw`
public sealed class HuntRevokeStore : IHuntGmailGrantStore
{
    public byte[] Value;
    public byte[] LastRead;
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

    public void Write(string target, byte[] value) { Writes++; }

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

public sealed class HuntRevokeClient : IHuntGmailGrantRevocationClient
{
    public string Scenario;
    public int Calls;
    public byte[] LastGrant;

    public HuntRevokeClient(string scenario) { Scenario = scenario; }

    public void Revoke(byte[] grant)
    {
        Calls++;
        LastGrant = grant;
        if (Scenario == "transient") throw new HuntGmailRefreshUnavailableException();
        if (Scenario == "invalid") throw new InvalidOperationException();
    }
}
`;
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-revoke-flow-"));
  try {
    const sourcePath = join(root, "helper.cs");
    const outputPath = join(root, "result.json");
    await writeFile(sourcePath, `${csharp}\n${fakes}`);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        `$refs='System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies $refs; $method=[HuntInteractiveGmailOAuthSealer].GetMethod('RevokeGrant',[Reflection.BindingFlags]'NonPublic,Static'); if($null -eq $method) { exit 121 }; function Cleared($value) { if($null -eq $value) { return $false }; foreach($item in $value) { if($item -ne 0) { return $false } }; return $true }; function Case($scenario,$size) { $store=[HuntRevokeStore]::new(); if($size -gt 0) { $store.Value=[Text.Encoding]::ASCII.GetBytes('r'*$size) }; $client=[HuntRevokeClient]::new($scenario); $outcome=$false; $exitCode=0; try { $outcome=$method.Invoke($null,@('1234567890-example1.apps.googleusercontent.com','person@example.invalid',$store,$client)) } catch { $inner=$_.Exception.InnerException; $exitCode=if($null -ne $inner -and $null -ne $inner.GetType().GetProperty('ExitCode')) { $inner.ExitCode } else { 99 } }; return [pscustomobject]@{ scenario=$scenario; exitCode=$exitCode; outcome=$outcome; calls=$client.Calls; reads=$store.Reads; writes=$store.Writes; deletes=$store.Deletes; readCleared=(Cleared $store.LastRead); clientViewCleared=(Cleared $client.LastGrant); preserved=($null -ne $store.Value); opaque=($store.LastTarget -match '^Hunt/C3/GmailRefresh/v1/[0-9a-f]{64}$' -and -not $store.LastTarget.Contains('person')) } }; $output=@((Case 'missing' 0),(Case 'success' 14),(Case 'provider_invalid' 14),(Case 'transient' 14),(Case 'invalid' 14),(Case 'malformed' 513)); $utf8=New-Object Text.UTF8Encoding($false); [IO.File]::WriteAllText($env:HUNT_TEST_OUTPUT,($output | ConvertTo-Json -Depth 5 -Compress),$utf8); exit 0`,
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
          HUNT_TEST_OUTPUT: outputPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), [
      { scenario: "missing", exitCode: 0, outcome: false, calls: 0, reads: 1, writes: 0, deletes: 0, readCleared: false, clientViewCleared: false, preserved: false, opaque: true },
      { scenario: "success", exitCode: 0, outcome: true, calls: 1, reads: 1, writes: 0, deletes: 1, readCleared: true, clientViewCleared: true, preserved: false, opaque: true },
      { scenario: "provider_invalid", exitCode: 0, outcome: true, calls: 1, reads: 1, writes: 0, deletes: 1, readCleared: true, clientViewCleared: true, preserved: false, opaque: true },
      { scenario: "transient", exitCode: 12, outcome: false, calls: 1, reads: 1, writes: 0, deletes: 0, readCleared: true, clientViewCleared: true, preserved: true, opaque: true },
      { scenario: "invalid", exitCode: 11, outcome: false, calls: 1, reads: 1, writes: 0, deletes: 0, readCleared: true, clientViewCleared: true, preserved: true, opaque: true },
      { scenario: "malformed", exitCode: 11, outcome: false, calls: 0, reads: 1, writes: 0, deletes: 0, readCleared: true, clientViewCleared: false, preserved: true, opaque: true },
    ]);
    const revokeBlock = /private static bool RevokeGrant[\s\S]*?private static bool DeleteGrant/u
      .exec(source)?.[0] ?? "";
    assert.doesNotMatch(revokeBlock, /Process\.Start|Authorize|ProfileEmail/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lookup revocation needs no account bytes and handles absent or rejected lookup state exactly", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const fakes = String.raw`
public sealed class HuntLookupRevokeStore : IHuntGmailGrantStore
{
    public Dictionary<string, byte[]> Values = new Dictionary<string, byte[]>();
    public int Deletes;
    public byte[] Read(string target)
    {
        byte[] value;
        return Values.TryGetValue(target, out value) ? (byte[])value.Clone() : null;
    }
    public void Write(string target, byte[] value) { Values[target] = (byte[])value.Clone(); }
    public bool Delete(string target)
    {
        Deletes++;
        byte[] value;
        if (!Values.TryGetValue(target, out value)) return false;
        Array.Clear(value, 0, value.Length);
        Values.Remove(target);
        return true;
    }
}

public sealed class HuntLookupRevoker : IHuntGmailGrantRevocationClient
{
    public bool Transient;
    public int Calls;
    public byte[] LastGrant;
    public void Revoke(byte[] grant)
    {
        Calls++;
        LastGrant = grant;
        if (Transient) throw new HuntGmailRefreshUnavailableException();
    }
}
`;
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-lookup-revoke-"));
  try {
    const sourcePath = join(root, "helper.cs");
    await writeFile(sourcePath, `${csharp}\n${fakes}`);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        `$refs='System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies $refs; $flags=[Reflection.BindingFlags]'NonPublic,Static'; $type=[HuntInteractiveGmailOAuthSealer]; $revoke=$type.GetMethod('RevokeGrantFromLookup',$flags); $lookupTarget=$type.GetMethod('LookupTarget',$flags); if($null -eq $revoke -or $null -eq $lookupTarget) { exit 122 }; $client='1234567890-example1.apps.googleusercontent.com'; $recipient='recipient_abcdefghijklmnop'; $lookup=[string]$lookupTarget.Invoke($null,@($client,$recipient)); $locator='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; $grant='Hunt/C3/GmailRefresh/v1/'+$locator; function InvokeRevoke($store,$client) { try { $value=$revoke.Invoke($null,@($script:client,$script:recipient,$store,$client)); return [pscustomobject]@{ code=0; value=$value } } catch { $inner=$_.Exception.InnerException; $code=if($null -ne $inner -and $null -ne $inner.GetType().GetProperty('ExitCode')) { $inner.ExitCode } else { 99 }; return [pscustomobject]@{ code=$code; value=$false } } }; $absent=[HuntLookupRevokeStore]::new(); $absentClient=[HuntLookupRevoker]::new(); $a=InvokeRevoke $absent $absentClient; if($a.code -ne 0 -or $a.value -or $absentClient.Calls -ne 0 -or $absent.Deletes -ne 0) { exit 123 }; $success=[HuntLookupRevokeStore]::new(); $success.Values[$lookup]=[Text.Encoding]::ASCII.GetBytes($locator); $success.Values[$grant]=[Text.Encoding]::UTF8.GetBytes('stored-refresh'); $successClient=[HuntLookupRevoker]::new(); $s=InvokeRevoke $success $successClient; if($s.code -ne 0 -or -not $s.value -or $successClient.Calls -ne 1 -or $success.Values.Count -ne 0 -or $success.Deletes -ne 2) { exit 124 }; foreach($item in $successClient.LastGrant) { if($item -ne 0) { exit 125 } }; $malformed=[HuntLookupRevokeStore]::new(); $malformed.Values[$lookup]=[Text.Encoding]::ASCII.GetBytes(('z'*64)); $malformedClient=[HuntLookupRevoker]::new(); $m=InvokeRevoke $malformed $malformedClient; if($m.code -ne 11 -or $malformed.Values.Count -ne 0 -or $malformedClient.Calls -ne 0) { exit 126 }; $missing=[HuntLookupRevokeStore]::new(); $missing.Values[$lookup]=[Text.Encoding]::ASCII.GetBytes($locator); $missingClient=[HuntLookupRevoker]::new(); $g=InvokeRevoke $missing $missingClient; if($g.code -ne 11 -or $missing.Values.Count -ne 0 -or $missingClient.Calls -ne 0) { exit 127 }; $transient=[HuntLookupRevokeStore]::new(); $transient.Values[$lookup]=[Text.Encoding]::ASCII.GetBytes($locator); $transient.Values[$grant]=[Text.Encoding]::UTF8.GetBytes('stored-refresh'); $transientClient=[HuntLookupRevoker]::new(); $transientClient.Transient=$true; $t=InvokeRevoke $transient $transientClient; if($t.code -ne 12 -or $transient.Values.Count -ne 2 -or $transient.Deletes -ne 0 -or $transientClient.Calls -ne 1) { exit 128 }; foreach($item in $transientClient.LastGrant) { if($item -ne 0) { exit 129 } }; exit 0`,
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

test("trusted revocation helper accepts only the exact provider invalid-token response", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts",
    "utf8",
  );
  const csharp = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1] ?? "";
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-revoke-protocol-"));
  try {
    const sourcePath = join(root, "helper.cs");
    await writeFile(sourcePath, csharp);
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command",
        `$refs='System.Security.dll','System.Web.dll','System.Web.Extensions.dll'; Add-Type -Path $env:HUNT_TEST_SOURCE -ReferencedAssemblies $refs; $flags=[Reflection.BindingFlags]'NonPublic,Static'; $exact=[HuntInteractiveGmailOAuthSealer].GetMethod('ExactObject',$flags); $invalid=[HuntInteractiveGmailOAuthSealer].GetMethod('ExactProviderInvalidToken',$flags); if($null -eq $exact -or $null -eq $invalid) { exit 131 }; function IsInvalid($json) { $value=$exact.Invoke($null,@($json)); return $invalid.Invoke($null,@($value)) }; if(-not (IsInvalid '{"error":"invalid_token"}') -or (IsInvalid '{"error":"invalid_request"}') -or (IsInvalid '{"error":"invalid_token","extra":true}')) { exit 132 }; exit 0`,
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
    assert.match(source, /RevocationEndpoint = "https:\/\/oauth2\.googleapis\.com\/revoke"/u);
    const revokeToken = /private static void RevokeToken[\s\S]*?private static bool ProviderInvalidToken/u
      .exec(source)?.[0] ?? "";
    assert.match(revokeToken, /request\.Method = "POST"/u);
    assert.match(revokeToken, /request\.AllowAutoRedirect = false/u);
    assert.match(revokeToken, /ReadBounded\(response\.GetResponseStream\(\), 4096\)/u);
    assert.doesNotMatch(revokeToken, /Process\.Start/u);
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
