import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve(import.meta.dirname, "../../scripts/import-job-fill-backup.ts");
const backup = JSON.stringify({ records: [{ fieldName: "First Name", answer: "Synthetic" }] });

test("import CLI refuses repositories, junctions and overwrites while allowing private output", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-import-test-"));
  try {
    const input = join(root, "backup.json");
    await writeFile(input, backup);
    const run = (output: string) => spawnSync(process.execPath,
      [script, "--input", input, "--output", output], { encoding: "utf8", windowsHide: true });
    const repository = join(root, "other-checkout");
    await mkdir(repository);
    await writeFile(join(repository, ".git"), "gitdir: synthetic");
    assert.notEqual(run(join(repository, "private")).status, 0);
    const alias = join(root, "external-junction");
    await symlink(repository, alias, process.platform === "win32" ? "junction" : "dir");
    assert.notEqual(run(join(alias, "private")).status, 0);
    assert.deepEqual(await readdir(repository), [".git"]);
    const output = join(root, "private");
    const accepted = run(output);
    assert.equal(accepted.status, 0, accepted.stderr);
    const original = await readFile(join(output, "application-profile.json"), "utf8");
    assert.equal(JSON.parse(original).facts[0].value, "Synthetic");
    assert.notEqual(run(output).status, 0);
    assert.equal(await readFile(join(output, "application-profile.json"), "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protection failure writes no applicant data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hunt-import-denied-"));
  const previousArgs = process.argv;
  try {
    const input = join(root, "backup.json");
    const output = join(root, "private");
    await writeFile(input, backup);
    t.mock.module("../../src/composition/private/s2-run-storage.ts", {
      namedExports: { protectStage2StoragePaths: async () => { throw new Error("protection denied"); } },
    });
    process.argv = [process.execPath, script, "--input", input, "--output", output];
    await assert.rejects(import("../../scripts/import-job-fill-backup.ts"), /protection denied/u);
    assert.deepEqual(await readdir(output), []);
  } finally {
    process.argv = previousArgs;
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});
