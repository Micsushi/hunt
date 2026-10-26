import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const DEFAULT_BOUND = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const INPUT_MAGIC = Buffer.from("HACI", "ascii");
const OUTPUT_MAGIC = Buffer.from("HACS", "ascii");

const PINNED_ENV_ACCOUNT_SCRIPT = String.raw`
& {
$ErrorActionPreference = 'Stop'
$sourcePath = $env:HUNT_PINNED_ENV_SOURCE_PATH
$expectedSha256 = $env:HUNT_PINNED_ENV_SHA256
$env:HUNT_PINNED_ENV_SOURCE_PATH = $null
$env:HUNT_PINNED_ENV_SHA256 = $null
if ([string]::IsNullOrEmpty($sourcePath) -or [string]::IsNullOrEmpty($expectedSha256)) { exit 31 }
$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class HuntPinnedEnvAccountSealer
{
    private static readonly byte[] InputMagic = new byte[] { 72, 65, 67, 73 };
    private static readonly byte[] OutputMagic = new byte[] { 72, 65, 67, 83 };
    private static readonly byte[] BundleMagic = new byte[] { 72, 65, 67, 66 };
    private static readonly byte[] EmailPrefix = Encoding.ASCII.GetBytes("HUNT_C3_TEST_ACCOUNT_EMAIL=");
    private static readonly byte[] PasswordPrefix = Encoding.ASCII.GetBytes("HUNT_C3_TEST_ACCOUNT_PASSWORD=");

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle handle,
        StringBuilder path,
        uint pathLength,
        uint flags);

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

    private static string WithoutDevicePrefix(string path)
    {
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            return @"\\" + path.Substring(8);
        if (path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
            return path.Substring(4);
        return path;
    }

    private static void ValidateFinalPath(FileStream stream, string sourcePath)
    {
        StringBuilder finalPath = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(stream.SafeFileHandle, finalPath, 32768, 0);
        if (length < 1 || length >= 32768) throw new InvalidDataException();
        string expected = Path.GetFullPath(sourcePath);
        string actual = WithoutDevicePrefix(finalPath.ToString());
        if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException();
    }

    private static byte[] ReadAllBytes(string sourcePath)
    {
        FileAttributes attributes = File.GetAttributes(sourcePath);
        if ((attributes & FileAttributes.Directory) != 0 || (attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException();
        using (FileStream stream = new FileStream(
            sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.SequentialScan))
        {
            ValidateFinalPath(stream, sourcePath);
            if (stream.Length < 1 || stream.Length > 65536) throw new InvalidDataException();
            byte[] value = new byte[(int)stream.Length];
            int offset = 0;
            while (offset < value.Length)
            {
                int read = stream.Read(value, offset, value.Length - offset);
                if (read < 1) throw new EndOfStreamException();
                offset += read;
            }
            if (stream.ReadByte() != -1) throw new InvalidDataException();
            return value;
        }
    }

    private static byte[] ParseExpectedDigest(string value)
    {
        if (value == null || value.Length != 64) throw new InvalidDataException();
        byte[] digest = new byte[32];
        for (int i = 0; i < digest.Length; i++)
        {
            int high = Hex(value[i * 2]);
            int low = Hex(value[i * 2 + 1]);
            if (high < 0 || low < 0) throw new InvalidDataException();
            digest[i] = (byte)((high << 4) | low);
        }
        return digest;
    }

    private static int Hex(char value)
    {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        return -1;
    }

    private static bool StartsWith(byte[] source, int start, int end, byte[] prefix)
    {
        if (end - start < prefix.Length) return false;
        for (int i = 0; i < prefix.Length; i++)
            if (source[start + i] != prefix[i]) return false;
        return true;
    }

    private static byte[] ExtractUniqueValue(byte[] source, byte[] prefix, int maximumLength)
    {
        byte[] result = null;
        int count = 0;
        int start = 0;
        for (int cursor = 0; cursor <= source.Length; cursor++)
        {
            if (cursor != source.Length && source[cursor] != 10) continue;
            int end = cursor;
            if (end > start && source[end - 1] == 13) end--;
            if (StartsWith(source, start, end, prefix))
            {
                int length = end - start - prefix.Length;
                if (length < 1 || length > maximumLength || ++count != 1)
                    throw new InvalidDataException();
                result = new byte[length];
                Buffer.BlockCopy(source, start + prefix.Length, result, 0, length);
            }
            start = cursor + 1;
        }
        if (count != 1 || result == null) throw new InvalidDataException();
        new UTF8Encoding(false, true).GetCharCount(result);
        return result;
    }

    public static void Run(string sourcePath, string expectedSha256)
    {
        byte[] entropy = ReadEntropy();
        byte[] envBytes = null;
        byte[] expectedDigest = null;
        byte[] actualDigest = null;
        byte[] emailBytes = null;
        byte[] passwordBytes = null;
        byte[] bundle = null;
        byte[] sealedValue = null;
        try
        {
            if (!Path.IsPathRooted(sourcePath)) throw new InvalidDataException();
            envBytes = ReadAllBytes(sourcePath);
            expectedDigest = ParseExpectedDigest(expectedSha256);
            using (SHA256 sha256 = SHA256.Create()) actualDigest = sha256.ComputeHash(envBytes);
            int difference = 0;
            for (int i = 0; i < actualDigest.Length; i++) difference |= actualDigest[i] ^ expectedDigest[i];
            if (difference != 0) throw new InvalidDataException();
            emailBytes = ExtractUniqueValue(envBytes, EmailPrefix, 320);
            passwordBytes = ExtractUniqueValue(envBytes, PasswordPrefix, 4096);
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
            if (actualDigest != null) Array.Clear(actualDigest, 0, actualDigest.Length);
            if (expectedDigest != null) Array.Clear(expectedDigest, 0, expectedDigest.Length);
            if (envBytes != null) Array.Clear(envBytes, 0, envBytes.Length);
            Array.Clear(entropy, 0, entropy.Length);
        }
    }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Security.dll'
[HuntPinnedEnvAccountSealer]::Run($sourcePath, $expectedSha256)
}
`.trim();

export interface PinnedEnvAccountProcess {
  run(
    input: Uint8Array,
    sourcePath: string,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface WindowsPinnedEnvAccountSealerOptions {
  readonly sourcePath: string;
  readonly expectedSha256: string;
  readonly process?: PinnedEnvAccountProcess;
  readonly executable?: string;
  readonly maxCiphertextBytes?: number;
  readonly timeoutMs?: number;
}

export class WindowsPinnedEnvAccountSealer {
  readonly #sourcePath: string;
  readonly #expectedSha256: string;
  readonly #process: PinnedEnvAccountProcess;
  readonly #bound: number;

  constructor(options: WindowsPinnedEnvAccountSealerOptions) {
    if (!isAbsolute(options.sourcePath) || !/^[0-9a-f]{64}$/u.test(options.expectedSha256)) {
      throw new TypeError("pinned env account migration invalid");
    }
    this.#sourcePath = options.sourcePath;
    this.#expectedSha256 = options.expectedSha256;
    this.#bound = options.maxCiphertextBytes ?? DEFAULT_BOUND;
    this.#process = options.process ?? new PowerShellPinnedEnvAccountProcess({
      executable: options.executable,
      maxOutputBytes: this.#bound + 9,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async seal(entropy: Readonly<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted || entropy.byteLength < 1 || entropy.byteLength > DEFAULT_BOUND) {
      throw new Error("pinned env account migration failed");
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
      throw new Error("pinned env account migration failed");
    } finally {
      input.fill(0);
    }
  }
}

interface PowerShellPinnedEnvAccountProcessOptions {
  readonly executable?: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

class PowerShellPinnedEnvAccountProcess implements PinnedEnvAccountProcess {
  readonly #executable: string;
  readonly #maxOutputBytes: number;
  readonly #timeoutMs: number;

  constructor(options: PowerShellPinnedEnvAccountProcessOptions) {
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
        PINNED_ENV_ACCOUNT_SCRIPT,
      ], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          HUNT_PINNED_ENV_SOURCE_PATH: sourcePath,
          HUNT_PINNED_ENV_SHA256: expectedSha256,
        },
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
        finish(new Error("pinned env account migration failed"));
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
          finish(new Error("pinned env account migration failed"));
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
    throw new TypeError("pinned env account migration failed");
  }
  const length = input.readUInt32LE(5);
  if (length < 1 || length > bound || input.byteLength !== 9 + length) {
    throw new TypeError("pinned env account migration failed");
  }
  return new Uint8Array(input.subarray(9));
}
