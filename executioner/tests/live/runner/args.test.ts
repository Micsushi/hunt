import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { parseStage2AcceptanceArgs } from "../../../src/live/runner/args.ts";

test("account-access CLI accepts only the exact bounded flag set", () => {
  const { config, evidence } = storageLayout("abcdefghijklmnop");
  assert.deepEqual(parseStage2AcceptanceArgs([
    "--config",
    config,
    "--stop-after",
    "account_access",
    "--evidence-root",
    evidence,
  ]), { checkpoint: "account_access", configPath: config, evidenceRoot: evidence });
});

test("mailbox-candidate CLI accepts the same exact bounded flag set", () => {
  const { config, evidence } = storageLayout("abcdefghijklmnop");
  assert.deepEqual(parseStage2AcceptanceArgs([
    "--config",
    config,
    "--stop-after",
    "mailbox_candidate",
    "--evidence-root",
    evidence,
  ]), { checkpoint: "mailbox_candidate", configPath: config, evidenceRoot: evidence });
});

test("account-verified CLI accepts the same exact bounded flag set", () => {
  const { config, evidence } = storageLayout("abcdefghijklmnop");
  assert.deepEqual(parseStage2AcceptanceArgs([
    "--config",
    config,
    "--stop-after",
    "account_verified",
    "--evidence-root",
    evidence,
  ]), { checkpoint: "account_verified", configPath: config, evidenceRoot: evidence });
});

test("account-access CLI rejects missing, duplicate, relative, and widened arguments", () => {
  const { config, evidence } = storageLayout("abcdefghijklmnop");
  const otherEvidence = storageLayout("qrstuvwxyzabcdef").evidence;
  const invalid = [
    [],
    ["--config", config, "--stop-after", "account_access"],
    ["--config", config, "--config", config, "--stop-after", "account_access", "--evidence-root", evidence],
    ["--config", "owner-inputs.json", "--stop-after", "account_access", "--evidence-root", evidence],
    ["--config", config, "--stop-after", "review", "--evidence-root", evidence],
    ["--config", config, "--stop-after", "account_access", "--evidence-root", evidence, "extra"],
    ["--config", config, "--unknown", "value", "--stop-after", "account_access", "--evidence-root", evidence],
    ["--config", resolve("owner-inputs.json"), "--stop-after", "account_access", "--evidence-root", resolve("evidence")],
    ["--config", config, "--stop-after", "account_access", "--evidence-root", otherEvidence],
  ];
  for (const args of invalid) {
    assert.throws(() => parseStage2AcceptanceArgs(args), /invalid Stage 2 arguments/u);
  }
});

function storageLayout(nonce: string): { readonly config: string; readonly evidence: string } {
  const root = resolve("protected-storage");
  const runKey = `run_20260803_${nonce}`;
  return {
    config: resolve(root, "transient", runKey, "owner-input.json"),
    evidence: resolve(root, "retained", runKey, "evidence"),
  };
}
