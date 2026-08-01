import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { parseStage2AccountAccessArgs } from "../../../src/live/runner/args.ts";

test("account-access CLI accepts only the exact bounded flag set", () => {
  const config = resolve("owner-inputs.json");
  const evidence = resolve("evidence");
  assert.deepEqual(parseStage2AccountAccessArgs([
    "--config",
    config,
    "--stop-after",
    "account_access",
    "--evidence-root",
    evidence,
  ]), { configPath: config, evidenceRoot: evidence });
});

test("account-access CLI rejects missing, duplicate, relative, and widened arguments", () => {
  const config = resolve("owner-inputs.json");
  const evidence = resolve("evidence");
  const invalid = [
    [],
    ["--config", config, "--stop-after", "account_access"],
    ["--config", config, "--config", config, "--stop-after", "account_access", "--evidence-root", evidence],
    ["--config", "owner-inputs.json", "--stop-after", "account_access", "--evidence-root", evidence],
    ["--config", config, "--stop-after", "review", "--evidence-root", evidence],
    ["--config", config, "--stop-after", "account_access", "--evidence-root", evidence, "extra"],
    ["--config", config, "--unknown", "value", "--stop-after", "account_access", "--evidence-root", evidence],
  ];
  for (const args of invalid) {
    assert.throws(() => parseStage2AccountAccessArgs(args), /invalid Stage 2 arguments/u);
  }
});
