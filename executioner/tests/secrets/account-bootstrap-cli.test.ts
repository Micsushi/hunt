import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runS2AccountBootstrapCli,
  type AccountBootstrapOperation,
} from "../../src/composition/s2-account-bootstrap-cli.ts";

const safeResult = {
  ok: true,
  value: {
    schemaVersion: 1,
    kind: "account_secret_provisioned",
    handleId: "secret_handle_0123456789abcdef0123456789abcdef",
  },
} as const;

test("loads one bounded external config and forwards no secret argument or environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-bootstrap-cli-"));
  try {
    const config = join(root, "owner-inputs.json");
    await writeFile(config, JSON.stringify({ schemaVersion: 1 }));
    let calls = 0;
    const operation: AccountBootstrapOperation = async (value, context) => {
      calls += 1;
      assert.deepEqual(value, { schemaVersion: 1 });
      assert.equal(context.ownerConfigPath, config);
      return safeResult;
    };
    assert.deepEqual(await runS2AccountBootstrapCli(
      ["--config", config],
      { PATH: "synthetic-safe" },
      { forbiddenRoots: [process.cwd()], operation },
    ), safeResult);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects secret flags or environment before reading config or prompting", async () => {
  let calls = 0;
  const operation: AccountBootstrapOperation = async () => {
    calls += 1;
    return safeResult;
  };
  for (const [args, environment] of [
    [["--email", "private@example.invalid"], {}],
    [["--password", "private"], {}],
    [["--token", "private"], {}],
    [["--config", "missing"], { HUNT_C3_ACCOUNT_EMAIL: "private@example.invalid" }],
    [["--config", "missing"], { HUNT_C3_TEST_ACCOUNT_PASSWORD: "private" }],
  ] as const) {
    assert.deepEqual(await runS2AccountBootstrapCli(
      args,
      environment,
      { forbiddenRoots: [process.cwd()], operation },
    ), { ok: false, error: { code: "bootstrap_input_invalid" } });
  }
  assert.equal(calls, 0);
});

test("thin provisioner emits only a value-free failure for secret arguments", () => {
  const privateValue = "sentinel-private-password";
  const result = spawnSync(
    process.execPath,
    ["scripts/provision-s2-account.ts", "--password", privateValue],
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
  assert.equal(result.stdout, '{"ok":false,"error":{"code":"bootstrap_input_invalid"}}\n');
  assert.equal(`${result.stdout}${result.stderr}`.includes(privateValue), false);
});

test("rejects relative, repository, symlink, oversized, and malformed config", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-bootstrap-cli-invalid-"));
  try {
    const malformed = join(root, "malformed.json");
    const oversized = join(root, "oversized.json");
    const linked = join(root, "linked.json");
    const linkedTarget = join(root, "linked-target");
    await writeFile(malformed, "{");
    await writeFile(oversized, "x".repeat(65 * 1024));
    await mkdir(linkedTarget);
    await symlink(linkedTarget, linked, "junction");
    const operation: AccountBootstrapOperation = async () => safeResult;
    for (const path of ["relative.json", process.cwd(), malformed, oversized, linked]) {
      assert.deepEqual(await runS2AccountBootstrapCli(
        ["--config", path],
        {},
        { forbiddenRoots: [process.cwd()], operation },
      ), { ok: false, error: { code: "bootstrap_input_invalid" } });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
