import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const DEFAULT_BOUND = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const INPUT_MAGIC = Buffer.from("HACI", "ascii");
const OUTPUT_MAGIC = Buffer.from("HACS", "ascii");

const LEGACY_V2_ACCOUNT_SCRIPT = String.raw`
& {
param([string]$sourcePath, [string]$expectedSha256)
$ErrorActionPreference = 'Stop'
if (-not [System.IO.Path]::IsPathRooted($sourcePath)) { exit 31 }
$actualSha256 = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -cne $expectedSha256) { exit 32 }
$legacySource = [System.IO.File]::ReadAllText($sourcePath, [System.Text.Encoding]::UTF8)
$emailMatch = [regex]::Match($legacySource, 'DEFAULT_ACCOUNT_EMAIL\s*=\s*"([^"\\\r\n]{1,320})"\s*;', 'CultureInvariant')
$passwordMatch = [regex]::Match($legacySource, 'DEFAULT_ACCOUNT_PASSWORD\s*=.*?\|\|\s*"([^"\\\r\n]{1,4096})"\s*;', 'Singleline,CultureInvariant')
if (-not $emailMatch.Success -or -not $passwordMatch.Success) { exit 33 }

$source = @'
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

public static class HuntLegacyV2AccountSealer
{
    private static readonly byte[] InputMagic = new byte[] { 72, 65, 67, 73 };
    private static readonly byte[] OutputMagic = new byte[] { 72, 65, 67, 83 };
    private static readonly byte[] BundleMagic = new byte[] { 72, 65, 67, 66 };

    private static byte[] ReadEntropy()
    {
        BinaryReader reader = new BinaryReader(Console.OpenStandardInput());
        byte[] magic = reader.ReadBytes(4);
        if (magic.Length != 4) throw new EndOfStreamException();
        for (int i = 0; i < 4; i++) if (magic[i] != InputMagic[i]) throw new InvalidDataException();
        if (reader.ReadByte() != 1) throw new InvalidDataException();
        int length = reader.ReadInt32();
        if (length < 1 || length > 1048576) throw new InvalidDataException();
        byte[] entropy = reader.ReadBytes(length);
        if (entropy.Length != length || reader.BaseStream.ReadByte() != -1) throw new InvalidDataException();
        Array.Clear(magic, 0, magic.Length);
        return entropy;
    }

    private static void WriteSection(BinaryWriter writer, byte tag, byte[] value)
    {
        writer.Write(tag);
        writer.Write(value.Length);
        writer.Write(value);
    }

    public static void Run(string email, string password)
    {
        byte[] entropy = ReadEntropy();
        byte[] emailBytes = null;
        byte[] passwordBytes = null;
        byte[] bundle = null;
        byte[] sealedValue = null;
        try
        {
            emailBytes = new UTF8Encoding(false, true).GetBytes(email);
            passwordBytes = new UTF8Encoding(false, true).GetBytes(password);
            if (emailBytes.Length < 1 || emailBytes.Length > 320 || passwordBytes.Length < 1 || passwordBytes.Length > 4096)
                throw new InvalidDataException();
            MemoryStream bundleStream = new MemoryStream();
            BinaryWriter bundleWriter = new BinaryWriter(bundleStream);
            bundleWriter.Write(BundleMagic);
            bundleWriter.Write((byte)1);
            bundleWriter.Write((byte)2);
            WriteSection(bundleWriter, 1, emailBytes);
            WriteSection(bundleWriter, 2, passwordBytes);
            bundleWriter.Flush();
            bundle = bundleStream.ToArray();
            Array.Clear(bundleStream.GetBuffer(), 0, (int)bundleStream.Length);
            bundleWriter.Dispose();
            bundleStream.Dispose();
            sealedValue = ProtectedData.Protect(bundle, entropy, DataProtectionScope.CurrentUser);
            BinaryWriter writer = new BinaryWriter(Console.OpenStandardOutput());
            writer.Write(OutputMagic);
            writer.Write((byte)1);
            writer.Write(sealedValue.Length);
            writer.Write(sealedValue);
            writer.Flush();
        }
        finally
        {
            if (sealedValue != null) Array.Clear(sealedValue, 0, sealedValue.Length);
            if (bundle != null) Array.Clear(bundle, 0, bundle.Length);
            if (passwordBytes != null) Array.Clear(passwordBytes, 0, passwordBytes.Length);
            if (emailBytes != null) Array.Clear(emailBytes, 0, emailBytes.Length);
            Array.Clear(entropy, 0, entropy.Length);
        }
    }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Security.dll'
try {
    [HuntLegacyV2AccountSealer]::Run($emailMatch.Groups[1].Value, $passwordMatch.Groups[1].Value)
} finally {
    $legacySource = $null
    $emailMatch = $null
    $passwordMatch = $null
}
}
`.trim();

export interface LegacyV2AccountProcess {
  run(
    input: Uint8Array,
    sourcePath: string,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface WindowsLegacyV2AccountSealerOptions {
  readonly sourcePath: string;
  readonly expectedSha256: string;
  readonly process?: LegacyV2AccountProcess;
  readonly executable?: string;
  readonly maxCiphertextBytes?: number;
  readonly timeoutMs?: number;
}

export class WindowsLegacyV2AccountSealer {
  readonly #sourcePath: string;
  readonly #expectedSha256: string;
  readonly #process: LegacyV2AccountProcess;
  readonly #bound: number;

  constructor(options: WindowsLegacyV2AccountSealerOptions) {
    if (!isAbsolute(options.sourcePath) || !/^[0-9a-f]{64}$/u.test(options.expectedSha256)) {
      throw new TypeError("legacy v2 account migration invalid");
    }
    this.#sourcePath = options.sourcePath;
    this.#expectedSha256 = options.expectedSha256;
    this.#bound = options.maxCiphertextBytes ?? DEFAULT_BOUND;
    this.#process = options.process ?? new PowerShellLegacyV2AccountProcess({
      executable: options.executable,
      maxOutputBytes: this.#bound + 9,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async seal(entropy: Readonly<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted || entropy.byteLength < 1 || entropy.byteLength > DEFAULT_BOUND) {
      throw new Error("legacy v2 account migration failed");
    }
    const input = Buffer.allocUnsafe(9 + entropy.byteLength);
    INPUT_MAGIC.copy(input, 0);
    input.writeUInt8(1, 4);
    input.writeUInt32LE(entropy.byteLength, 5);
    input.set(entropy, 9);
    try {
      const framed = await this.#process.run(
        input,
        this.#sourcePath,
        this.#expectedSha256,
        signal,
      );
      try {
        return parseFramedCiphertext(framed, this.#bound);
      } finally {
        framed.fill(0);
      }
    } catch {
      throw new Error("legacy v2 account migration failed");
    } finally {
      input.fill(0);
    }
  }
}

interface PowerShellLegacyV2AccountProcessOptions {
  readonly executable?: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

class PowerShellLegacyV2AccountProcess implements LegacyV2AccountProcess {
  readonly #executable: string;
  readonly #maxOutputBytes: number;
  readonly #timeoutMs: number;

  constructor(options: PowerShellLegacyV2AccountProcessOptions) {
    this.#executable = options.executable ??
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    this.#maxOutputBytes = options.maxOutputBytes;
    this.#timeoutMs = options.timeoutMs;
  }

  run(
    input: Uint8Array,
    sourcePath: string,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        LEGACY_V2_ACCOUNT_SCRIPT,
        sourcePath,
        expectedSha256,
      ], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error?: Error, value?: Uint8Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        for (const chunk of chunks) chunk.fill(0);
        if (error !== undefined) reject(error);
        else resolve(value!);
      };
      const cancel = () => {
        child.kill();
        finish(new Error("legacy v2 account migration failed"));
      };
      const timer = setTimeout(cancel, this.#timeoutMs);
      signal.addEventListener("abort", cancel, { once: true });
      child.once("error", cancel);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > this.#maxOutputBytes) {
          chunk.fill(0);
          cancel();
          return;
        }
        chunks.push(Buffer.from(chunk));
        chunk.fill(0);
      });
      child.once("close", (code) => {
        if (code !== 0 || size < 1) {
          finish(new Error("legacy v2 account migration failed"));
          return;
        }
        const output = Buffer.concat(chunks);
        const value = new Uint8Array(output);
        output.fill(0);
        finish(undefined, value);
      });
      child.stdin.once("error", () => undefined);
      child.stdin.end(input);
    });
  }
}

function parseFramedCiphertext(value: Uint8Array, bound: number): Uint8Array {
  const input = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (
    input.byteLength < 10 ||
    !input.subarray(0, 4).equals(OUTPUT_MAGIC) ||
    input.readUInt8(4) !== 1
  ) {
    throw new TypeError("legacy v2 account migration failed");
  }
  const length = input.readUInt32LE(5);
  if (length < 1 || length > bound || input.byteLength !== 9 + length) {
    throw new TypeError("legacy v2 account migration failed");
  }
  return new Uint8Array(input.subarray(9));
}
