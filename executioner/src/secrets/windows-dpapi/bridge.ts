import { spawn } from "node:child_process";

const DEFAULT_BOUND = 1024 * 1024;

const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.IO;
using System.Security.Cryptography;

public static class HuntDpapiCurrentUserBridge
{
    public static void Run()
    {
        Stream input = Console.OpenStandardInput();
        BinaryReader reader = new BinaryReader(input);
        byte operation = reader.ReadByte();
        int entropyLength = reader.ReadInt32();
        if (entropyLength < 1 || entropyLength > 1048576) throw new InvalidDataException();
        byte[] entropy = reader.ReadBytes(entropyLength);
        if (entropy.Length != entropyLength) throw new EndOfStreamException();
        MemoryStream valueStream = new MemoryStream();
        byte[] chunk = new byte[8192];
        int total = 0;
        int read;
        while ((read = input.Read(chunk, 0, chunk.Length)) > 0)
        {
            total += read;
            if (total > 1048576) throw new InvalidDataException();
            valueStream.Write(chunk, 0, read);
        }
        byte[] value = valueStream.ToArray();
        byte[] result;
        if (operation == 1)
            result = ProtectedData.Protect(value, entropy, DataProtectionScope.CurrentUser);
        else if (operation == 2)
            result = ProtectedData.Unprotect(value, entropy, DataProtectionScope.CurrentUser);
        else
            throw new InvalidDataException();
        Stream output = Console.OpenStandardOutput();
        output.Write(result, 0, result.Length);
        output.Flush();
        Array.Clear(result, 0, result.Length);
        Array.Clear(value, 0, value.Length);
        Array.Clear(valueStream.GetBuffer(), 0, (int)valueStream.Length);
        valueStream.Dispose();
        Array.Clear(entropy, 0, entropy.Length);
        Array.Clear(chunk, 0, chunk.Length);
    }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Security.dll'
[HuntDpapiCurrentUserBridge]::Run()
`;

export interface WindowsDpapiBridgeOptions {
  readonly maxInputBytes?: number;
  readonly executable?: string;
}

export class WindowsDpapiBridge {
  readonly #maxInputBytes: number;
  readonly #executable: string;

  constructor(options: WindowsDpapiBridgeOptions = {}) {
    this.#maxInputBytes = options.maxInputBytes ?? DEFAULT_BOUND;
    this.#executable = options.executable ??
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  }

  protect(
    value: Readonly<Uint8Array>,
    entropy: Readonly<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.#run(1, value, entropy, signal);
  }

  unprotect(
    value: Readonly<Uint8Array>,
    entropy: Readonly<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.#run(2, value, entropy, signal);
  }

  async #run(
    operation: 1 | 2,
    value: Readonly<Uint8Array>,
    entropy: Readonly<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (
      value.byteLength < 1 ||
      entropy.byteLength < 1 ||
      value.byteLength > this.#maxInputBytes ||
      entropy.byteLength > this.#maxInputBytes
    ) {
      throw new RangeError("DPAPI input exceeds the configured bound");
    }
    if (signal?.aborted === true) throw signal.reason;

    const input = Buffer.allocUnsafe(5 + entropy.byteLength + value.byteLength);
    input.writeUInt8(operation, 0);
    input.writeInt32LE(entropy.byteLength, 1);
    input.set(entropy, 5);
    input.set(value, 5 + entropy.byteLength);

    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        const child = spawn(
          this.#executable,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            DPAPI_SCRIPT,
          ],
          {
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "ignore"],
          },
        );
        const output: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;

        const finish = (error?: Error, result?: Uint8Array) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          for (const chunk of output) chunk.fill(0);
          if (error !== undefined) reject(error);
          else resolve(result!);
        };
        const abort = () => {
          child.kill();
          finish(new Error("DPAPI operation cancelled"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        child.once("error", () => finish(new Error("DPAPI operation failed")));
        child.stdout.on("data", (chunk: Buffer) => {
          if (settled) {
            chunk.fill(0);
            return;
          }
          outputBytes += chunk.byteLength;
          if (outputBytes > this.#maxInputBytes) {
            chunk.fill(0);
            child.kill();
            finish(new Error("DPAPI operation failed"));
            return;
          }
          output.push(Buffer.from(chunk));
          chunk.fill(0);
        });
        child.once("close", (code) => {
          if (code !== 0 || outputBytes === 0) {
            finish(new Error("DPAPI operation failed"));
            return;
          }
          const result = Buffer.concat(output);
          finish(undefined, new Uint8Array(result));
          result.fill(0);
        });
        child.stdin.once("error", () => undefined);
        child.stdin.end(input);
      });
    } finally {
      input.fill(0);
    }
  }
}
