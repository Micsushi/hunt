import assert from "node:assert/strict";
import test from "node:test";

import { parseStage2CompletionAuditArgs } from "../../../src/live/runner/completion-audit.ts";

test("completion audit CLI accepts only one canonical evidence root", () => {
  assert.deepEqual(parseStage2CompletionAuditArgs([
    "--evidence-root",
    "C:\\evidence\\run-1",
  ]), { evidenceRoot: "C:\\evidence\\run-1" });
  for (const values of [
    ["--evidence-root", "relative"],
    ["--root", "C:\\evidence\\run-1"],
    ["--evidence-root", "C:\\evidence\\run-1", "extra"],
  ]) assert.throws(() => parseStage2CompletionAuditArgs(values), /completion audit arguments invalid/u);
});
