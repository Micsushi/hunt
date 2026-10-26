import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runS2GmailGrantLocalForgetCli,
  runS2GmailGrantRevokeCli,
  type GmailGrantLocalForgetOperation,
  type GmailGrantRevokeOperation,
} from "../../src/composition/s2-gmail-bootstrap-cli.ts";

const success = {
  ok: true,
  value: { schemaVersion: 1, kind: "gmail_refresh_grant_revoked" },
} as const;

const forgetSuccess = {
  ok: true,
  value: { schemaVersion: 1, kind: "gmail_refresh_grant_forgotten" },
} as const;

test("revoke CLI loads exactly two external files and forwards no secret surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-revoke-cli-"));
  try {
    const ownerPath = join(root, "owner.json");
    const bootstrapPath = join(root, "gmail.json");
    await writeFile(ownerPath, '{"schemaVersion":1}');
    await writeFile(bootstrapPath, '{"schemaVersion":1,"desktopClientId":"safe-client"}');
    let calls = 0;
    const operation: GmailGrantRevokeOperation = async (owner, bootstrap, context) => {
      calls += 1;
      assert.deepEqual(owner, { schemaVersion: 1 });
      assert.deepEqual(bootstrap, { schemaVersion: 1, desktopClientId: "safe-client" });
      assert.equal(context.ownerConfigPath, ownerPath);
      assert.equal(context.bootstrapInputPath, bootstrapPath);
      return success;
    };
    assert.deepEqual(await runS2GmailGrantRevokeCli(
      ["--config", ownerPath, "--gmail-bootstrap", bootstrapPath],
      { PATH: "safe" },
      { forbiddenRoots: [process.cwd()], operation },
    ), success);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revoke CLI rejects private arguments and environment before operation", async () => {
  let calls = 0;
  const operation: GmailGrantRevokeOperation = async () => {
    calls += 1;
    return success;
  };
  for (const [arguments_, environment] of [
    [["--token", "private"], {}],
    [["--email", "private@example.invalid"], {}],
    [["--config", "relative", "--gmail-bootstrap", "relative"], {}],
    [["--config", "missing", "--gmail-bootstrap", "missing"], {
      HUNT_GMAIL_REFRESH_TOKEN: "private",
    }],
  ] as const) {
    assert.deepEqual(await runS2GmailGrantRevokeCli(
      arguments_,
      environment,
      { forbiddenRoots: [process.cwd()], operation },
    ), { ok: false, error: { code: "gmail_bootstrap_input_invalid" } });
  }
  assert.equal(calls, 0);
});

test("local-forget CLI keeps the same two-file value-free surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-forget-cli-"));
  try {
    const ownerPath = join(root, "owner.json");
    const bootstrapPath = join(root, "gmail.json");
    await writeFile(ownerPath, '{"schemaVersion":1}');
    await writeFile(bootstrapPath, '{"schemaVersion":1,"desktopClientId":"safe-client"}');
    let calls = 0;
    const operation: GmailGrantLocalForgetOperation = async (_owner, _bootstrap, context) => {
      calls += 1;
      assert.equal(context.ownerConfigPath, ownerPath);
      assert.equal(context.bootstrapInputPath, bootstrapPath);
      return forgetSuccess;
    };
    assert.deepEqual(await runS2GmailGrantLocalForgetCli(
      ["--config", ownerPath, "--gmail-bootstrap", bootstrapPath],
      { PATH: "safe" },
      { forbiddenRoots: [process.cwd()], operation },
    ), forgetSuccess);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("thin revoke script and package command stay value-free", async () => {
  const privateValue = "sentinel-private-refresh-token";
  const result = spawnSync(
    process.execPath,
    ["scripts/revoke-s2-gmail-grant.ts", "--token", privateValue],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    '{"ok":false,"error":{"code":"gmail_bootstrap_input_invalid"}}\n',
  );
  assert.equal(`${result.stdout}${result.stderr}`.includes(privateValue), false);
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts["revoke:s2-gmail-grant"],
    "node scripts/revoke-s2-gmail-grant.ts",
  );
  assert.equal(
    packageJson.scripts["forget:s2-gmail-grant"],
    "node scripts/forget-s2-gmail-grant.ts",
  );
});
