import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WindowsExactRecordAclProtector } from "../../src/secrets/windows-dpapi/private/exact-record-acl-protector.ts";

test("protects one synthetic file for direct current-user and SYSTEM access", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-record-acl-"));
  try {
    const path = join(root, "record.s2secret");
    await writeFile(path, "synthetic");
    await new WindowsExactRecordAclProtector().protect(
      path,
      new AbortController().signal,
    );
    const script = String.raw`
$acl = Get-Acl -LiteralPath ([Console]::In.ReadToEnd())
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.Access | ForEach-Object { [pscustomobject]@{
  sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  allow = $_.AccessControlType.ToString()
  inherited = $_.IsInherited
  rights = [long]$_.FileSystemRights
} })
[pscustomobject]@{
  owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  current = $current
  protected = $acl.AreAccessRulesProtected
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
`;
    const result = spawnSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        input: path,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0);
    const value = JSON.parse(result.stdout);
    assert.equal(value.owner, value.current);
    assert.equal(value.protected, true);
    const rules = Array.isArray(value.rules) ? value.rules : [value.rules];
    assert.deepEqual(
      rules.map((rule: { sid: string }) => rule.sid).sort(),
      [value.current, "S-1-5-18"].sort(),
    );
    assert.equal(rules.every((rule: { allow: string }) => rule.allow === "Allow"), true);
    assert.equal(rules.every((rule: { inherited: boolean }) => rule.inherited === false), true);
    assert.equal(rules.every((rule: { rights: number }) => rule.rights === 2_032_127), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects missing, reparse, cancelled, and unavailable-helper targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-record-acl-deny-"));
  try {
    await assert.rejects(
      new WindowsExactRecordAclProtector().protect(
        join(root, "missing.s2secret"),
        new AbortController().signal,
      ),
      /exact record ACL protection failed/u,
    );
    const path = join(root, "record.s2secret");
    await writeFile(path, "synthetic");
    await assert.rejects(
      new WindowsExactRecordAclProtector().protect(path, AbortSignal.abort()),
      /exact record ACL protection cancelled/u,
    );
    await assert.rejects(
      new WindowsExactRecordAclProtector({ executable: join(root, "missing.exe") })
        .protect(path, new AbortController().signal),
      /exact record ACL protection failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
