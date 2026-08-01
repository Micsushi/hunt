import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WindowsInteractiveAccountSealer,
  type InteractiveAccountProcess,
} from "../../src/secrets/windows-dpapi/private/interactive-account-sealer.ts";

class ReplyProcess implements InteractiveAccountProcess {
  readonly #reply: Uint8Array | Error;
  input?: Uint8Array;
  observedMagic?: string;

  constructor(reply: Uint8Array | Error) {
    this.#reply = reply;
  }

  async run(input: Uint8Array): Promise<Uint8Array> {
    this.input = input;
    this.observedMagic = Buffer.from(input.subarray(0, 4)).toString("ascii");
    if (this.#reply instanceof Error) throw this.#reply;
    return this.#reply;
  }
}

function reply(ciphertext: readonly number[]): Uint8Array {
  const output = Buffer.alloc(9 + ciphertext.length);
  output.write("HACS", 0, "ascii");
  output.writeUInt8(1, 4);
  output.writeUInt32LE(ciphertext.length, 5);
  output.set(ciphertext, 9);
  return output;
}

test("accepts one bounded framed ciphertext and clears helper input", async () => {
  const process = new ReplyProcess(reply([17, 19, 23, 29]));
  const entropy = Uint8Array.from([31, 37, 41]);
  const sealed = await new WindowsInteractiveAccountSealer({ process }).seal(
    entropy,
    new AbortController().signal,
  );

  assert.deepEqual([...sealed], [17, 19, 23, 29]);
  assert.equal(process.observedMagic, "HACI");
  assert.equal(process.input?.every((value) => value === 0), true);
  assert.deepEqual([...entropy], [31, 37, 41]);
});

test("fails closed on cancellation, helper failure, and malformed or oversized output", async () => {
  const active = new AbortController().signal;
  const cases = [
    new ReplyProcess(new Error("synthetic helper failure")),
    new ReplyProcess(Buffer.from("malformed")),
    new ReplyProcess(reply([])),
    new ReplyProcess(reply(new Array(65).fill(1))),
  ];
  for (const process of cases) {
    await assert.rejects(
      new WindowsInteractiveAccountSealer({ process, maxCiphertextBytes: 64 })
        .seal(Uint8Array.from([43]), active),
      /account credential sealing failed/u,
    );
  }
  await assert.rejects(
    new WindowsInteractiveAccountSealer({ process: new ReplyProcess(reply([1])) })
      .seal(Uint8Array.from([47]), AbortSignal.abort()),
    /account credential sealing cancelled/u,
  );
});

test("production helper uses constant visible secure UI and a bounded binary-only process", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-account-sealer.ts",
    "utf8",
  );
  assert.match(source, /const INTERACTIVE_ACCOUNT_SCRIPT = String\.raw/u);
  assert.match(source, /Get-Credential/u);
  assert.match(source, /DataProtectionScope\.CurrentUser/u);
  assert.match(source, /windowsHide:\s*false/u);
  assert.match(source, /shell:\s*false/u);
  assert.match(source, /stdio:\s*\["pipe",\s*"pipe",\s*"ignore"\]/u);
  assert.doesNotMatch(source, /process\.env/u);
  assert.doesNotMatch(source, /Read-Host|Console\.ReadLine/u);
  assert.doesNotMatch(
    source,
    /Write-(?:Output|Error|Host)|console\.(?:log|error)|stderr:/iu,
  );
  assert.match(source, /BundleMagic = new byte\[\] \{ 72, 65, 67, 66 \}/u);
  assert.match(source, /WriteSection\(bundleWriter, 1, emailBytes\)/u);
  assert.match(source, /WriteSection\(bundleWriter, 2, passwordBytes\)/u);
});

test("the embedded trusted helper compiles without starting credential UI", async () => {
  const source = await readFile(
    "src/secrets/windows-dpapi/private/interactive-account-sealer.ts",
    "utf8",
  );
  const match = /\$source = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source);
  assert.notEqual(match, null);
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$source=[Console]::In.ReadToEnd(); Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Security.dll'",
    ],
    {
      input: match?.[1] ?? "",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0);
});
