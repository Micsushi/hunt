import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const PATH_BOUND = 32 * 1024;
const INPUT_MAGIC = Buffer.from("HARP", "ascii");
const OUTPUT = Buffer.from("HARD\x01", "binary");

const EXACT_RECORD_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class HuntExactRecordAclProtector
{
    public static void Run()
    {
        BinaryReader reader = new BinaryReader(Console.OpenStandardInput());
        byte[] magic = reader.ReadBytes(4);
        if (magic.Length != 4 || magic[0] != 72 || magic[1] != 65 || magic[2] != 82 || magic[3] != 80)
            throw new InvalidDataException();
        if (reader.ReadByte() != 1) throw new InvalidDataException();
        int length = reader.ReadInt32();
        if (length < 1 || length > 32768) throw new InvalidDataException();
        byte[] pathBytes = reader.ReadBytes(length);
        if (pathBytes.Length != length || reader.BaseStream.ReadByte() != -1)
            throw new InvalidDataException();
        string path = new UTF8Encoding(false, true).GetString(pathBytes);
        Array.Clear(pathBytes, 0, pathBytes.Length);
        Array.Clear(magic, 0, magic.Length);

        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            throw new InvalidDataException();
        SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
        SecurityIdentifier system = new SecurityIdentifier("S-1-5-18");
        FileSecurity acl = new FileSecurity();
        acl.SetOwner(current);
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(current, FileSystemRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, AccessControlType.Allow));
        File.SetAccessControl(path, acl);

        Stream output = Console.OpenStandardOutput();
        output.Write(new byte[] { 72, 65, 82, 68, 1 }, 0, 5);
        output.Flush();
        path = null;
    }
}
'@
Add-Type -TypeDefinition $source
[HuntExactRecordAclProtector]::Run()
`;

export interface ExactRecordAclProtector {
  protect(path: string, signal: AbortSignal): Promise<void>;
}

export interface WindowsExactRecordAclProtectorOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
}

export class WindowsExactRecordAclProtector implements ExactRecordAclProtector {
  readonly #executable: string;
  readonly #timeoutMs: number;

  constructor(options: WindowsExactRecordAclProtectorOptions = {}) {
    this.#executable = options.executable ??
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async protect(path: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("exact record ACL protection cancelled");
    if (!safeFile(path)) throw new Error("exact record ACL protection failed");
    const pathBytes = Buffer.from(path, "utf8");
    if (pathBytes.byteLength < 1 || pathBytes.byteLength > PATH_BOUND) {
      pathBytes.fill(0);
      throw new Error("exact record ACL protection failed");
    }
    const input = Buffer.allocUnsafe(9 + pathBytes.byteLength);
    INPUT_MAGIC.copy(input, 0);
    input.writeUInt8(1, 4);
    input.writeUInt32LE(pathBytes.byteLength, 5);
    input.set(pathBytes, 9);
    pathBytes.fill(0);
    try {
      const result = spawnSync(
        this.#executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          EXACT_RECORD_ACL_SCRIPT,
        ],
        {
          input,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
          timeout: this.#timeoutMs,
          maxBuffer: 64,
          encoding: null,
          env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
        },
      );
      if (
        result.error !== undefined ||
        result.signal !== null ||
        result.status !== 0 ||
        !Buffer.isBuffer(result.stdout) ||
        !result.stdout.equals(OUTPUT)
      ) {
        throw new Error("exact record ACL protection failed");
      }
      result.stdout.fill(0);
    } catch (error) {
      if (error instanceof Error && error.message === "exact record ACL protection failed") {
        throw error;
      }
      throw new Error("exact record ACL protection failed");
    } finally {
      input.fill(0);
    }
  }
}

function safeFile(path: string): boolean {
  try {
    return isAbsolute(path) && normalize(path) === path &&
      !lstatSync(path).isSymbolicLink() && !lstatSync(path).isDirectory() &&
      comparable(realpathSync.native(path)) === comparable(resolve(path));
  } catch {
    return false;
  }
}

function comparable(path: string): string {
  const value = normalize(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}
