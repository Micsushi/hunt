import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Reviewed pure production slice only. A changed slice requires source review,
// not an automatic hash update. Never compile the full privileged helper here.
const reviewedPolicySha256 = "ea150848f5f2d2a8f3eb5ff96d094f51fb5472cab93680b337dd35770f544ff0";

async function policySource(): Promise<string> {
  const source = (await readFile("src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts", "utf8"))
    .replaceAll("\r\n", "\n");
  const slices = ["LookupTarget", "ValidRecipientBindingId", "ValidateClient", "Clear"].map((name) => {
    const matches = [...source.matchAll(new RegExp(`^    private static (?:string|bool|void) ${name}\\([^\\n]*\\)\\n    \\{.*?^    \\}`, "gms"))];
    assert.equal(matches.length, 1, `Expected one reviewed ${name} method`);
    return matches[0]![0];
  });
  for (const pattern of [
    /^    private sealed class FlowException : Exception\n    \{.*?^    \}/gms,
    /^    private const string Scope = "[^"]+";/gm,
  ]) {
    const matches = [...source.matchAll(pattern)];
    assert.equal(matches.length, 1);
    slices.push(matches[0]![0]);
  }
  const policy = slices.join("\n");
  assert.equal(createHash("sha256").update(policy).digest("hex"), reviewedPolicySha256,
    "Policy changed: inspect its side effects before updating the reviewed slice digest");
  assert.doesNotMatch(policy, /DllImport|InteropServices|Reflection|ProtectedData|CredRead|CredWrite|WebRequest|System\.IO|Process|TcpListener/u);
  return policy;
}

test("lookup policy is the exact reviewed pure production slice", async () => {
  assert.ok((await policySource()).includes("hunt-c3-gmail-refresh-lookup-v1"));
});

test("pure C# lookup policy preserves scope binding and recipient validation", {
  skip: process.platform !== "win32" ? "Native C# fixture requires Windows; not native-helper acceptance" : false,
}, async () => {
  const policy = await policySource();
  const root = await mkdtemp(join(tmpdir(), "hunt-pure-lookup-policy-"));
  try {
    const sourcePath = join(root, "LookupPolicy.cs");
    const executable = join(root, "LookupPolicy.exe");
    await writeFile(sourcePath, `using System;
using System.Text;
using System.Globalization;
using System.Security.Cryptography;
public static class LookupPolicyFixture {
${policy}
public static int Main() {
  string client = "1234567890-example1.apps.googleusercontent.com";
  string recipient = "recipient_abcdefghijklmnop";
  foreach (string invalid in new string[] { null, "recipient_short", recipient + ".", "Recipient_abcdefghijklmnop", "recipient_" + new string('a', 65), "recipient_abcdefghijklmnopé" }) {
    if (ValidRecipientBindingId(invalid)) return 1;
    try { LookupTarget(client, invalid); return 2; } catch (FlowException error) { if (error.ExitCode != 11) return 3; }
  }
  foreach (string invalid in new string[] { "short", new string('a', 201), "1234567890-example1.invalid" }) {
    try { LookupTarget(invalid, recipient); return 4; } catch (FlowException error) { if (error.ExitCode != 3) return 5; }
  }
  foreach (string valid in new string[] { recipient, "recipient_" + new string('a', 64), "recipient_ABCDefghijkl12_-" }) {
    if (!ValidRecipientBindingId(valid)) return 6;
    Console.WriteLine(LookupTarget(client, valid));
  }
  Console.WriteLine(LookupTarget("1234567890-example2.apps.googleusercontent.com", recipient));
  return 0;
}
}`);
    const options = { cwd: root, shell: false, windowsHide: true, encoding: "utf8" as const,
      timeout: 15_000, maxBuffer: 65536,
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", TEMP: root, TMP: root } };
    const compiled = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
      ["/nologo", "/target:exe", `/out:${executable}`, sourcePath], options);
    assert.equal(compiled.error, undefined);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(executable, [], options);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const recipients = ["recipient_abcdefghijklmnop", `recipient_${"a".repeat(64)}`, "recipient_ABCDefghijkl12_-", "recipient_abcdefghijklmnop"];
    const expected = recipients.map((recipient, index) => {
      const client = `1234567890-example${index === 3 ? 2 : 1}.apps.googleusercontent.com`;
      const digest = createHash("sha256").update(`hunt-c3-gmail-refresh-lookup-v1\0${client}\0${recipient}\0https://www.googleapis.com/auth/gmail.readonly`).digest("hex");
      return `Hunt/C3/GmailRefreshLookup/v1/${digest}`;
    });
    assert.deepEqual(result.stdout.trim().split(/\r?\n/u), expected);
    assert.doesNotMatch(result.stdout, /recipient|person|example|@/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
