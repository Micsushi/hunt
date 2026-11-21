import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const PATH_BOUND = 32 * 1024;
const INPUT_MAGIC = Buffer.from("HARP", "ascii");
const OUTPUT = Buffer.from("HARD\x01", "binary");

const EXACT_RECORD_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$reader = [IO.BinaryReader]::new([Console]::OpenStandardInput())
if ([Text.Encoding]::ASCII.GetString($reader.ReadBytes(4)) -cne 'HARP' -or $reader.ReadByte() -ne 1) {
  throw 'Invalid record request'
}
$length = $reader.ReadInt32()
if ($length -lt 1 -or $length -gt 32768) { throw 'Invalid record length' }
$bytes = $reader.ReadBytes($length)
if ($bytes.Length -ne $length -or $reader.BaseStream.ReadByte() -ne -1) { throw 'Invalid record frame' }
try { $path = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) }
finally { [Array]::Clear($bytes, 0, $bytes.Length) }

$attributes = [IO.File]::GetAttributes($path)
if ($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) {
  throw 'Invalid record file'
}
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in $current, $system) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
}
[IO.File]::SetAccessControl($path, $acl)
$outputStream = [Console]::OpenStandardOutput()
$outputStream.Write([byte[]](72,65,82,68,1), 0, 5)
$outputStream.Flush()
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
