import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INPUT_BOUND = 32 * 1024;
const DEFAULT_OUTPUT_BOUND = 64 * 1024;
const FULL_CONTROL = 2_032_127n;
const SYSTEM_SID = "S-1-5-18";
const SID_PATTERN = /^S-1-(?:\d+)(?:-\d+)+$/u;

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.IO;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;

public static class HuntWindowsCurrentUserAcl
{
    private static string ReadString(BinaryReader reader)
    {
        int length = reader.ReadInt32();
        if (length < 1 || length > 32768) throw new InvalidDataException();
        byte[] bytes = reader.ReadBytes(length);
        if (bytes.Length != length) throw new EndOfStreamException();
        string value = new UTF8Encoding(false, true).GetString(bytes);
        Array.Clear(bytes, 0, bytes.Length);
        return value;
    }

    private static void WriteString(BinaryWriter writer, string value)
    {
        byte[] bytes = new UTF8Encoding(false, true).GetBytes(value);
        writer.Write(bytes.Length);
        writer.Write(bytes);
        Array.Clear(bytes, 0, bytes.Length);
    }

    public static void Run()
    {
        BinaryReader reader = new BinaryReader(Console.OpenStandardInput());
        int count = reader.ReadInt32();
        if (count < 1 || count > 16) throw new InvalidDataException();
        string[] paths = new string[count];
        for (int i = 0; i < count; i++) paths[i] = ReadString(reader);
        if (reader.BaseStream.ReadByte() != -1) throw new InvalidDataException();

        BinaryWriter writer = new BinaryWriter(Console.OpenStandardOutput());
        writer.Write(new byte[] { 72, 65, 67, 76 });
        writer.Write((byte)1);
        SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
        WriteString(writer, current.Value);
        writer.Write(count);

        for (int i = 0; i < count; i++)
        {
            try
            {
                string path = paths[i];
                FileAttributes attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                {
                    writer.Write((byte)1);
                    continue;
                }
                bool directory = (attributes & FileAttributes.Directory) != 0;
                FileSystemSecurity security = directory
                    ? (FileSystemSecurity)Directory.GetAccessControl(path)
                    : (FileSystemSecurity)File.GetAccessControl(path);
                SecurityIdentifier owner = (SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier));
                writer.Write((byte)0);
                WriteString(writer, owner.Value);
                writer.Write(security.AreAccessRulesProtected);
                AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
                writer.Write(rules.Count);
                foreach (FileSystemAccessRule rule in rules)
                {
                    SecurityIdentifier identity = (SecurityIdentifier)rule.IdentityReference;
                    WriteString(writer, identity.Value);
                    writer.Write((byte)(rule.AccessControlType == AccessControlType.Allow ? 1 : 2));
                    writer.Write(rule.IsInherited);
                    writer.Write((long)rule.FileSystemRights);
                }
            }
            catch
            {
                writer.Write((byte)2);
            }
        }
        writer.Flush();
        Array.Clear(paths, 0, paths.Length);
    }
}
'@
Add-Type -TypeDefinition $source
[HuntWindowsCurrentUserAcl]::Run()
`;

export type WindowsAclTarget =
  | "runtime_root"
  | "secret_root"
  | "evidence_root"
  | "owner_config"
  | "oauth_client_config"
  | "sender_policy_config"
  | "secret_record";

export type WindowsAclFailureReason =
  | "helper_failed"
  | "reparse"
  | "wrong_owner"
  | "unprotected_dacl"
  | "inherited_access"
  | "other_principal"
  | "current_user_access";

export type WindowsAclAdmissionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failure: {
        readonly target: WindowsAclTarget;
        readonly reason: WindowsAclFailureReason;
      };
    };

export interface WindowsAclAdmissionPaths {
  readonly runtime: string;
  readonly secrets: string;
  readonly evidence: string;
  readonly ownerConfig: string;
  readonly oauthClientConfig?: string;
  readonly senderPolicyConfig?: string;
  readonly accountRecord?: string;
  readonly gmailRecord?: string;
}

export interface WindowsAclProcess {
  run(input: Uint8Array): Uint8Array;
}

export interface WindowsCurrentUserAclAdmissionOptions {
  readonly process?: WindowsAclProcess;
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
}

interface TargetPath {
  readonly target: WindowsAclTarget;
  readonly path: string;
  readonly directory: boolean;
}

interface ParsedAce {
  readonly sid: string;
  readonly allow: boolean;
  readonly inherited: boolean;
  readonly rights: bigint;
}

interface ParsedEntry {
  readonly status: number;
  readonly owner?: string;
  readonly protectedDacl?: boolean;
  readonly aces?: readonly ParsedAce[];
}

interface ParsedReply {
  readonly currentUserSid: string;
  readonly entries: readonly ParsedEntry[];
}

export class WindowsCurrentUserAclAdmission {
  readonly #process: WindowsAclProcess;
  readonly #maxInputBytes: number;

  constructor(options: WindowsCurrentUserAclAdmissionOptions = {}) {
    const maxInputBytes = options.maxInputBytes ?? DEFAULT_INPUT_BOUND;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BOUND;
    this.#maxInputBytes = maxInputBytes;
    this.#process = options.process ?? new PowerShellAclProcess({
      executable: options.executable,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes,
    });
  }

  admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult {
    const targets = targetPaths(paths);
    for (const target of targets) {
      if (!safeLocalTarget(target)) return denied(target.target, "reparse");
    }

    let reply: ParsedReply;
    try {
      const input = encodePaths(targets.map(({ path }) => path), this.#maxInputBytes);
      const output = this.#process.run(input);
      reply = parseReply(output, targets.length);
    } catch {
      return denied("runtime_root", "helper_failed");
    }

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const entry = reply.entries[index];
      if (target === undefined || entry === undefined) {
        return denied("runtime_root", "helper_failed");
      }
      const result = evaluateEntry(target.target, entry, reply.currentUserSid);
      if (!result.ok) return result;
    }
    return Object.freeze({ ok: true });
  }
}

interface PowerShellAclProcessOptions {
  readonly executable?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

class PowerShellAclProcess implements WindowsAclProcess {
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: PowerShellAclProcessOptions) {
    this.#executable = options.executable ??
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    this.#timeoutMs = options.timeoutMs;
    this.#maxOutputBytes = options.maxOutputBytes;
  }

  run(input: Uint8Array): Uint8Array {
    const payload = Buffer.from(input);
    const result = (() => {
      try {
        return spawnSync(
          this.#executable,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            WINDOWS_ACL_SCRIPT,
          ],
          {
            input: payload,
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "ignore"],
            timeout: this.#timeoutMs,
            maxBuffer: this.#maxOutputBytes,
            encoding: null,
          },
        );
      } finally {
        payload.fill(0);
      }
    })();
    if (
      result.error !== undefined ||
      result.signal !== null ||
      result.status !== 0 ||
      !Buffer.isBuffer(result.stdout) ||
      result.stdout.byteLength < 1 ||
      result.stdout.byteLength > this.#maxOutputBytes
    ) {
      throw new Error("Windows ACL helper failed");
    }
    return new Uint8Array(result.stdout);
  }
}

function targetPaths(paths: WindowsAclAdmissionPaths): TargetPath[] {
  const targets: TargetPath[] = [
    { target: "runtime_root", path: paths.runtime, directory: true },
    { target: "secret_root", path: paths.secrets, directory: true },
    { target: "evidence_root", path: paths.evidence, directory: true },
    { target: "owner_config", path: paths.ownerConfig, directory: false },
  ];
  if (paths.oauthClientConfig !== undefined) {
    targets.push({
      target: "oauth_client_config",
      path: paths.oauthClientConfig,
      directory: false,
    });
  }
  if (paths.senderPolicyConfig !== undefined) {
    targets.push({
      target: "sender_policy_config",
      path: paths.senderPolicyConfig,
      directory: false,
    });
  }
  if (paths.accountRecord !== undefined) {
    targets.push({ target: "secret_record", path: paths.accountRecord, directory: false });
  }
  if (paths.gmailRecord !== undefined) {
    targets.push({ target: "secret_record", path: paths.gmailRecord, directory: false });
  }
  return targets;
}

function safeLocalTarget(target: TargetPath): boolean {
  try {
    if (
      !isAbsolute(target.path) ||
      normalize(target.path) !== target.path ||
      !existsSync(target.path) ||
      lstatSync(target.path).isSymbolicLink() ||
      statSync(target.path).isDirectory() !== target.directory ||
      comparable(realpathSync.native(target.path)) !== comparable(resolve(target.path))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function evaluateEntry(
  target: WindowsAclTarget,
  entry: ParsedEntry,
  currentUserSid: string,
): WindowsAclAdmissionResult {
  if (entry.status === 1) return denied(target, "reparse");
  if (entry.status !== 0 || entry.owner === undefined || entry.aces === undefined) {
    return denied(target, "helper_failed");
  }
  if (entry.owner !== currentUserSid) return denied(target, "wrong_owner");
  if (entry.protectedDacl !== true) return denied(target, "unprotected_dacl");

  let currentUserFullControl = false;
  for (const ace of entry.aces) {
    if (!ace.allow) continue;
    if (ace.inherited) return denied(target, "inherited_access");
    if (ace.sid !== currentUserSid && ace.sid !== SYSTEM_SID) {
      return denied(target, "other_principal");
    }
    if (ace.sid === currentUserSid && (ace.rights & FULL_CONTROL) === FULL_CONTROL) {
      currentUserFullControl = true;
    }
  }
  return currentUserFullControl
    ? Object.freeze({ ok: true })
    : denied(target, "current_user_access");
}

function encodePaths(paths: readonly string[], bound: number): Uint8Array {
  const chunks: Buffer[] = [];
  const count = Buffer.alloc(4);
  count.writeInt32LE(paths.length);
  chunks.push(count);
  for (const path of paths) {
    const bytes = Buffer.from(path, "utf8");
    if (bytes.byteLength < 1 || bytes.byteLength > DEFAULT_INPUT_BOUND) {
      throw new RangeError("Windows ACL helper input is invalid");
    }
    const length = Buffer.alloc(4);
    length.writeInt32LE(bytes.byteLength);
    chunks.push(length, bytes);
  }
  const input = Buffer.concat(chunks);
  if (input.byteLength > bound) throw new RangeError("Windows ACL helper input is invalid");
  return input;
}

function parseReply(value: Uint8Array, expectedCount: number): ParsedReply {
  const reader = new BinaryReader(value);
  if (reader.bytes(4).toString("ascii") !== "HACL" || reader.byte() !== 1) {
    throw new TypeError("invalid Windows ACL helper reply");
  }
  const currentUserSid = reader.string();
  if (!SID_PATTERN.test(currentUserSid) || reader.int() !== expectedCount) {
    throw new TypeError("invalid Windows ACL helper reply");
  }
  const entries: ParsedEntry[] = [];
  for (let index = 0; index < expectedCount; index += 1) {
    const status = reader.byte();
    if (status === 1 || status === 2) {
      entries.push({ status });
      continue;
    }
    if (status !== 0) throw new TypeError("invalid Windows ACL helper reply");
    const owner = reader.string();
    const protectedDacl = reader.byte() === 1;
    const aceCount = reader.int();
    if (!SID_PATTERN.test(owner) || aceCount < 0 || aceCount > 256) {
      throw new TypeError("invalid Windows ACL helper reply");
    }
    const aces: ParsedAce[] = [];
    for (let aceIndex = 0; aceIndex < aceCount; aceIndex += 1) {
      const sid = reader.string();
      const access = reader.byte();
      const inherited = reader.byte();
      const rights = reader.long();
      if (!SID_PATTERN.test(sid) || (access !== 1 && access !== 2) || inherited > 1 || rights < 0n) {
        throw new TypeError("invalid Windows ACL helper reply");
      }
      aces.push({ sid, allow: access === 1, inherited: inherited === 1, rights });
    }
    entries.push({ status, owner, protectedDacl, aces });
  }
  if (!reader.done()) throw new TypeError("invalid Windows ACL helper reply");
  return { currentUserSid, entries };
}

class BinaryReader {
  readonly #value: Buffer;
  #offset = 0;

  constructor(value: Uint8Array) {
    this.#value = Buffer.from(value);
  }

  byte(): number {
    this.#require(1);
    const result = this.#value.readUInt8(this.#offset);
    this.#offset += 1;
    return result;
  }

  int(): number {
    this.#require(4);
    const result = this.#value.readInt32LE(this.#offset);
    this.#offset += 4;
    return result;
  }

  long(): bigint {
    this.#require(8);
    const result = this.#value.readBigInt64LE(this.#offset);
    this.#offset += 8;
    return result;
  }

  string(): string {
    const length = this.int();
    if (length < 1 || length > DEFAULT_OUTPUT_BOUND) {
      throw new TypeError("invalid Windows ACL helper reply");
    }
    return this.bytes(length).toString("utf8");
  }

  bytes(length: number): Buffer {
    this.#require(length);
    const result = this.#value.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  done(): boolean {
    return this.#offset === this.#value.byteLength;
  }

  #require(length: number): void {
    if (length < 0 || this.#offset + length > this.#value.byteLength) {
      throw new TypeError("invalid Windows ACL helper reply");
    }
  }
}

function comparable(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(
  target: WindowsAclTarget,
  reason: WindowsAclFailureReason,
): WindowsAclAdmissionResult {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({ target, reason }),
  });
}
