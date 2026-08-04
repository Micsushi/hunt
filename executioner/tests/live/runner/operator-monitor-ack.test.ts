import assert from "node:assert/strict";
import test from "node:test";

import { parseOperatorMonitorAckArgs } from "../../../src/live/runner/operator-monitor-ack.ts";

test("operator monitor acknowledgement CLI accepts one canonical root and classification", () => {
  assert.deepEqual(parseOperatorMonitorAckArgs([
    "--evidence-root",
    "C:\\evidence\\run-1",
    "--classification",
    "application_ready",
  ]), {
    evidenceRoot: "C:\\evidence\\run-1",
    classification: "application_ready",
  });
});

test("operator monitor acknowledgement CLI rejects free-form and widened inputs", () => {
  for (const values of [
    ["--evidence-root", "relative", "--classification", "application_ready"],
    ["--evidence-root", "C:\\evidence\\run-1", "--classification", "My Information"],
    ["--evidence-root", "C:\\evidence\\run-1", "--classification", "application_ready", "extra"],
  ]) assert.throws(() => parseOperatorMonitorAckArgs(values), /monitor acknowledgement arguments invalid/u);
});
