import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runS2GmailBootstrapCli,
  type GmailBootstrapOperation,
} from "../../src/composition/s2-gmail-bootstrap-cli.ts";

const success = {
  ok: true,
  value: {
    schemaVersion: 1,
    kind: "gmail_authorization_provisioned",
    handleId: "secret_handle_fedcba9876543210fedcba9876543210",
  },
} as const;

test("loads exactly two external bounded files and forwards no secret surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-gmail-cli-"));
  try {
    const ownerPath = join(root, "owner.json");
    const bootstrapPath = join(root, "gmail.json");
    await writeFile(ownerPath, '{"schemaVersion":1}');
    await writeFile(bootstrapPath, '{"schemaVersion":1,"installedClientConfigPath":"C:\\\\protected\\\\google.json"}');
    let calls = 0;
    const operation: GmailBootstrapOperation = async (owner, bootstrap, context) => {
      calls += 1;
      assert.deepEqual(owner, { schemaVersion: 1 });
      assert.deepEqual(bootstrap, {
        schemaVersion: 1,
        installedClientConfigPath: "C:\\protected\\google.json",
      });
      assert.equal(context.ownerConfigPath, ownerPath);
      assert.equal(context.bootstrapInputPath, bootstrapPath);
      return success;
    };
    assert.deepEqual(await runS2GmailBootstrapCli(
      ["--config", ownerPath, "--gmail-bootstrap", bootstrapPath],
      { PATH: "safe" },
      { forbiddenRoots: [process.cwd()], operation },
    ), success);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects secret arguments, secret environment, and unsafe paths before operation", async () => {
  let calls = 0;
  const operation: GmailBootstrapOperation = async () => {
    calls += 1;
    return success;
  };
  for (const [args, environment] of [
    [["--password", "private"], {}],
    [["--sender", "private@example.invalid"], {}],
    [["--token", "private"], {}],
    [["--config", "relative", "--gmail-bootstrap", "relative"], {}],
    [["--config", "missing", "--gmail-bootstrap", "missing"], { HUNT_GMAIL_CLIENT_SECRET: "private" }],
  ] as const) {
    assert.deepEqual(await runS2GmailBootstrapCli(
      args,
      environment,
      { forbiddenRoots: [process.cwd()], operation },
    ), { ok: false, error: { code: "gmail_bootstrap_input_invalid" } });
  }
  assert.equal(calls, 0);
});

test("thin script emits only a value-free failure for private arguments", () => {
  const privateValue = "sentinel-private-token";
  const result = spawnSync(
    process.execPath,
    ["scripts/provision-s2-gmail.ts", "--token", privateValue],
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
  assert.equal(result.stdout, '{"ok":false,"error":{"code":"gmail_bootstrap_input_invalid"}}\n');
  assert.equal(`${result.stdout}${result.stderr}`.includes(privateValue), false);
});
