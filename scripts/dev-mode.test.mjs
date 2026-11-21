import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  composeProfile,
  MODES,
  npmCommand,
  npmInvocation,
  parseMode,
} from "./dev-mode.mjs";

test("dev mode keeps the supported profiles explicit", () => {
  assert.deepEqual([...MODES].sort(), ["c0", "c1", "c2", "full", "ui"]);
  assert.equal(parseMode(), "ui");
  assert.equal(parseMode("full"), "full");
  assert.equal(composeProfile("c1"), "c1");
  assert.equal(composeProfile("full"), "all");
  assert.throws(() => parseMode("production"), /Unknown mode/);
});

test("dev mode selects the platform npm executable", () => {
  assert.equal(npmCommand("win32"), "npm.cmd");
  assert.equal(npmCommand("linux"), "npm");
  assert.equal(npmCommand("darwin"), "npm");
  assert.deepEqual(npmInvocation("linux"), { command: "npm", args: [] });
  assert.deepEqual(npmInvocation("win32", "C:\\Program Files\\nodejs\\node.exe"), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: [
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    ],
  });
});

test("the current platform npm entrypoint can start", { timeout: 10_000 }, () => {
  const npm = npmInvocation();
  const result = spawnSync(npm.command, [...npm.args, "--version"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});
