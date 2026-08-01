import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WindowsCurrentUserAclAdmission,
  type WindowsAclProcess,
} from "../../../src/live/preflight/private/windows-acl.ts";

const USER = "S-1-5-21-111-222-333-1001";
const SYSTEM = "S-1-5-18";
const USERS = "S-1-5-32-545";
const EVERYONE = "S-1-1-0";
const FULL_CONTROL = 2_032_127;

interface Ace {
  readonly sid: string;
  readonly allow: boolean;
  readonly inherited?: boolean;
  readonly rights?: number;
}

interface Entry {
  readonly status?: number;
  readonly owner?: string;
  readonly protectedDacl?: boolean;
  readonly aces?: readonly Ace[];
}

class ReplyProcess implements WindowsAclProcess {
  readonly #reply: Uint8Array | Error;
  calls = 0;
  lastInput?: Uint8Array;

  constructor(reply: Uint8Array | Error) {
    this.#reply = reply;
  }

  run(input: Uint8Array): Uint8Array {
    this.calls += 1;
    this.lastInput = input.slice();
    if (this.#reply instanceof Error) throw this.#reply;
    return this.#reply;
  }
}

function reply(entries: readonly Entry[], currentUser = USER): Uint8Array {
  const chunks: Buffer[] = [Buffer.from("HACL"), Buffer.from([1])];
  string(chunks, currentUser);
  int(chunks, entries.length);
  for (const entry of entries) {
    chunks.push(Buffer.from([entry.status ?? 0]));
    if ((entry.status ?? 0) !== 0) continue;
    string(chunks, entry.owner ?? USER);
    chunks.push(Buffer.from([entry.protectedDacl === false ? 0 : 1]));
    int(chunks, entry.aces?.length ?? 1);
    for (const ace of entry.aces ?? [{ sid: USER, allow: true }]) {
      string(chunks, ace.sid);
      chunks.push(Buffer.from([ace.allow ? 1 : 2, ace.inherited === true ? 1 : 0]));
      long(chunks, ace.rights ?? FULL_CONTROL);
    }
  }
  return Buffer.concat(chunks);
}

function string(chunks: Buffer[], value: string): void {
  const bytes = Buffer.from(value, "utf8");
  int(chunks, bytes.byteLength);
  chunks.push(bytes);
}

function int(chunks: Buffer[], value: number): void {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  chunks.push(bytes);
}

function long(chunks: Buffer[], value: number): void {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(BigInt(value));
  chunks.push(bytes);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hunt-acl-admission-"));
  const paths = {
    runtime: join(root, "runtime"),
    secrets: join(root, "secrets"),
    evidence: join(root, "evidence"),
    ownerConfig: join(root, "owner-inputs.json"),
    accountRecord: join(root, "account.s2secret"),
    gmailRecord: join(root, "gmail.s2secret"),
  };
  for (const path of [paths.runtime, paths.secrets, paths.evidence]) mkdirSync(path);
  for (const path of [paths.ownerConfig, paths.accountRecord, paths.gmailRecord]) writeFileSync(path, "x");
  return { root, paths };
}

test("admits current-user-owned protected ACLs and permits only current user and SYSTEM allows", () => {
  const record = fixture();
  try {
    const process = new ReplyProcess(reply(Array.from({ length: 6 }, () => ({
      aces: [
        { sid: USER, allow: true },
        { sid: SYSTEM, allow: true },
        { sid: EVERYONE, allow: false },
      ],
    }))));
    const admission = new WindowsCurrentUserAclAdmission({ process });

    assert.deepEqual(admission.admit(record.paths), { ok: true });
    assert.equal(process.calls, 1);
    assert.equal(
      process.lastInput !== undefined &&
        Buffer.from(process.lastInput).includes(Buffer.from(record.paths.runtime)),
      true,
    );
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("rejects shared, inherited, unprotected, and wrong-owner ACLs with value-free outcomes", () => {
  const record = fixture();
  try {
    const cases: readonly [Entry, string][] = [
      [{ aces: [{ sid: USERS, allow: true }] }, "other_principal"],
      [{ aces: [{ sid: EVERYONE, allow: true }] }, "other_principal"],
      [{ aces: [{ sid: USER, allow: true, inherited: true }] }, "inherited_access"],
      [{ protectedDacl: false }, "unprotected_dacl"],
      [{ owner: SYSTEM }, "wrong_owner"],
      [{ aces: [{ sid: USER, allow: true, rights: 1 }] }, "current_user_access"],
    ];
    for (const [entry, reason] of cases) {
      const process = new ReplyProcess(reply([entry, {}, {}, {}, {}, {}]));
      const result = new WindowsCurrentUserAclAdmission({ process }).admit(record.paths);
      assert.deepEqual(result, {
        ok: false,
        failure: { target: "runtime_root", reason },
      });
      assert.equal(JSON.stringify(result).includes(record.paths.runtime), false);
    }
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("fails closed for timeout, malformed output, helper unavailability, and helper-reported reparse", () => {
  const record = fixture();
  try {
    const cases: readonly [Uint8Array | Error, string][] = [
      [new Error("timeout"), "helper_failed"],
      [Buffer.from("malformed"), "helper_failed"],
      [new Error("ENOENT"), "helper_failed"],
      [reply([{ status: 1 }, {}, {}, {}, {}, {}]), "reparse"],
    ];
    for (const [response, reason] of cases) {
      const result = new WindowsCurrentUserAclAdmission({
        process: new ReplyProcess(response),
      }).admit(record.paths);
      assert.deepEqual(result, {
        ok: false,
        failure: { target: "runtime_root", reason },
      });
    }
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("rejects local reparse targets before invoking the helper", () => {
  const record = fixture();
  try {
    const linkedRuntime = join(record.root, "runtime-link");
    symlinkSync(record.paths.runtime, linkedRuntime, "junction");
    const process = new ReplyProcess(reply(Array.from({ length: 6 }, () => ({}))));
    const result = new WindowsCurrentUserAclAdmission({ process }).admit({
      ...record.paths,
      runtime: linkedRuntime,
    });
    assert.deepEqual(result, {
      ok: false,
      failure: { target: "runtime_root", reason: "reparse" },
    });
    assert.equal(process.calls, 0);
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("maps owner config and existing secret record failures to their exact private targets", () => {
  const record = fixture();
  try {
    for (const [index, target] of [
      [3, "owner_config"],
      [4, "secret_record"],
      [5, "secret_record"],
    ] as const) {
      const entries = Array.from({ length: 6 }, () => ({} as Entry));
      entries[index] = { owner: SYSTEM };
      assert.deepEqual(
        new WindowsCurrentUserAclAdmission({ process: new ReplyProcess(reply(entries)) })
          .admit(record.paths),
        { ok: false, failure: { target, reason: "wrong_owner" } },
      );
    }
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("the native helper admits only synthetic protected current-user fixtures", () => {
  const record = fixture();
  try {
    protectForCurrentUser(record.paths);
    assert.deepEqual(new WindowsCurrentUserAclAdmission().admit(record.paths), {
      ok: true,
    });
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("the native process boundary fails closed on startup timeout and unavailable helper", () => {
  const record = fixture();
  try {
    for (const admission of [
      new WindowsCurrentUserAclAdmission({ timeoutMs: 1 }),
      new WindowsCurrentUserAclAdmission({ executable: join(record.root, "missing-helper.exe") }),
    ]) {
      assert.deepEqual(admission.admit(record.paths), {
        ok: false,
        failure: { target: "runtime_root", reason: "helper_failed" },
      });
    }
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

function protectForCurrentUser(paths: ReturnType<typeof fixture>["paths"]): void {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($index in 0..2) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($current, 'FullControl', $inherit, $propagation, $allow))
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', $inherit, $propagation, $allow))
  [System.IO.Directory]::SetAccessControl($paths[$index], $acl)
}
foreach ($index in 3..5) {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($current, 'FullControl', 'Allow'))
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', 'Allow'))
  [System.IO.File]::SetAccessControl($paths[$index], $acl)
}
`;
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    {
      input: JSON.stringify([
        paths.runtime,
        paths.secrets,
        paths.evidence,
        paths.ownerConfig,
        paths.accountRecord,
        paths.gmailRecord,
      ]),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0);
}
