import { spawn } from "node:child_process";

const DEFAULT_BOUND = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const INPUT_MAGIC = Buffer.from("HACI", "ascii");
const OUTPUT_MAGIC = Buffer.from("HACS", "ascii");

const INTERACTIVE_ACCOUNT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using System.Text;

public static class HuntInteractiveAccountSealer
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

    public static void Run(string email, SecureString securePassword)
    {
        byte[] entropy = ReadEntropy();
        byte[] emailBytes = null;
        byte[] passwordBytes = null;
        byte[] bundle = null;
        byte[] sealedValue = null;
        IntPtr passwordPointer = IntPtr.Zero;
        string password = null;
        try
        {
            if (String.IsNullOrWhiteSpace(email) || securePassword == null || securePassword.Length < 1)
                throw new InvalidDataException();
            emailBytes = new UTF8Encoding(false, true).GetBytes(email);
            if (emailBytes.Length < 1 || emailBytes.Length > 320) throw new InvalidDataException();
            passwordPointer = Marshal.SecureStringToBSTR(securePassword);
            password = Marshal.PtrToStringBSTR(passwordPointer);
            passwordBytes = new UTF8Encoding(false, true).GetBytes(password);
            if (passwordBytes.Length < 1 || passwordBytes.Length > 4096) throw new InvalidDataException();

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
            Stream output = Console.OpenStandardOutput();
            BinaryWriter writer = new BinaryWriter(output);
            writer.Write(OutputMagic);
            writer.Write((byte)1);
            writer.Write(sealedValue.Length);
            writer.Write(sealedValue);
            writer.Flush();
        }
        finally
        {
            if (passwordPointer != IntPtr.Zero) Marshal.ZeroFreeBSTR(passwordPointer);
            password = null;
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
$credential = Get-Credential -Message 'Enter the Workday account email and password for this Hunt journey'
if ($null -eq $credential) { exit 2 }
[HuntInteractiveAccountSealer]::Run($credential.UserName, $credential.Password)
`;

export interface InteractiveAccountProcess {
  run(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
}

export interface WindowsInteractiveAccountSealerOptions {
  readonly process?: InteractiveAccountProcess;
  readonly executable?: string;
  readonly maxCiphertextBytes?: number;
  readonly timeoutMs?: number;
}

export class WindowsInteractiveAccountSealer {
  readonly #process: InteractiveAccountProcess;
  readonly #bound: number;

  constructor(options: WindowsInteractiveAccountSealerOptions = {}) {
    this.#bound = options.maxCiphertextBytes ?? DEFAULT_BOUND;
    this.#process = options.process ?? new PowerShellInteractiveAccountProcess({
      executable: options.executable,
      maxOutputBytes: this.#bound + 9,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async seal(entropy: Readonly<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw new Error("account credential sealing cancelled");
    if (entropy.byteLength < 1 || entropy.byteLength > DEFAULT_BOUND) {
      throw new Error("account credential sealing failed");
    }
    const input = Buffer.allocUnsafe(9 + entropy.byteLength);
    INPUT_MAGIC.copy(input, 0);
    input.writeUInt8(1, 4);
    input.writeUInt32LE(entropy.byteLength, 5);
    input.set(entropy, 9);
    try {
      const framed = await this.#process.run(input, signal);
      try {
        return parseFramedCiphertext(framed, this.#bound);
      } finally {
        framed.fill(0);
      }
    } catch (error) {
      throw new Error(
        signal.aborted || isCancelled(error)
          ? "account credential sealing cancelled"
          : "account credential sealing failed",
      );
    } finally {
      input.fill(0);
    }
  }
}

interface PowerShellInteractiveAccountProcessOptions {
  readonly executable?: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

class PowerShellInteractiveAccountProcess implements InteractiveAccountProcess {
  readonly #executable: string;
  readonly #maxOutputBytes: number;
  readonly #timeoutMs: number;

  constructor(options: PowerShellInteractiveAccountProcessOptions) {
    this.#executable = options.executable ??
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    this.#maxOutputBytes = options.maxOutputBytes;
    this.#timeoutMs = options.timeoutMs;
  }

  run(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.#executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-STA",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          INTERACTIVE_ACCOUNT_SCRIPT,
        ],
        {
          shell: false,
          windowsHide: false,
          stdio: ["pipe", "pipe", "ignore"],
          env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
        },
      );
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
        finish(new Error("account credential sealing cancelled"));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("account credential sealing cancelled"));
      }, this.#timeoutMs);
      signal.addEventListener("abort", cancel, { once: true });
      child.once("error", () => finish(new Error("account credential sealing failed")));
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > this.#maxOutputBytes) {
          chunk.fill(0);
          child.kill();
          finish(new Error("account credential sealing failed"));
          return;
        }
        chunks.push(Buffer.from(chunk));
        chunk.fill(0);
      });
      child.once("close", (code) => {
        if (code === 2) {
          finish(new Error("account credential sealing cancelled"));
          return;
        }
        if (code !== 0 || size < 1) {
          finish(new Error("account credential sealing failed"));
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
    throw new TypeError("account credential sealing failed");
  }
  const length = input.readUInt32LE(5);
  if (length < 1 || length > bound || input.byteLength !== 9 + length) {
    throw new TypeError("account credential sealing failed");
  }
  return new Uint8Array(input.subarray(9));
}

function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === "account credential sealing cancelled";
}
