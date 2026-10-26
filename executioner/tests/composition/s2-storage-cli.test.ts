import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { parseStage2StorageCliArgs } from "../../src/composition/s2-storage-cli.ts";

const root = resolve("C:\\protected\\hunt-c3-storage");
const config = resolve(root, "transient", "run_20260803_abcdefghijklmnop", "owner-input.json");
const evidence = resolve(root, "retained", "run_20260803_abcdefghijklmnop", "evidence");

test("storage CLI exposes prepare, finalize, discard, inventory, list, rebuild, and bounded sweep without caller-managed run IDs", () => {
  assert.deepEqual(parseStage2StorageCliArgs(["prepare", "--storage-root", root]), {
    command: "prepare",
    storageRoot: root,
  });
  assert.deepEqual(parseStage2StorageCliArgs([
    "finalize",
    "--storage-root",
    root,
    "--config",
    config,
    "--evidence-root",
    evidence,
  ]), {
    command: "finalize",
    storageRoot: root,
    ownerConfigPath: config,
    evidenceRoot: evidence,
  });
  assert.deepEqual(parseStage2StorageCliArgs([
    "discard",
    "--storage-root",
    root,
    "--config",
    config,
    "--evidence-root",
    evidence,
  ]), {
    command: "discard",
    storageRoot: root,
    ownerConfigPath: config,
    evidenceRoot: evidence,
  });
  for (const command of ["inventory", "list", "rebuild", "sweep"] as const) {
    assert.deepEqual(parseStage2StorageCliArgs([command, "--storage-root", root]), {
      command,
      storageRoot: root,
    });
  }
});

test("storage CLI rejects relative, duplicate, unknown, and caller-selected run identity arguments", () => {
  for (const values of [
    ["prepare", "--storage-root", "relative"],
    ["prepare", "--storage-root", root, "--run-key", "remember-me"],
    ["list", "--storage-root", root, "--storage-root", root],
    ["delete", "--storage-root", root],
    ["finalize", "--storage-root", root, "--config", config],
  ]) {
    assert.throws(() => parseStage2StorageCliArgs(values), /invalid Stage 2 storage arguments/u);
  }
});
