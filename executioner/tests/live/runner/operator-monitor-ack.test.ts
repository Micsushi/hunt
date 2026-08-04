import assert from "node:assert/strict";
import test from "node:test";

import { parseOperatorMonitorAckArgs } from "../../../src/live/runner/operator-monitor-ack.ts";

test("operator monitor acknowledgement CLI accepts one canonical root and classification", () => {
  for (const classification of ["application_ready", "runtime_error"] as const) {
    assert.deepEqual(parseOperatorMonitorAckArgs([
      "--evidence-root",
      "C:\\evidence\\run-1",
      "--monitor-request",
      "C:\\runtime\\run-1\\monitor-request.json",
      "--classification",
      classification,
    ]), {
      evidenceRoot: "C:\\evidence\\run-1",
      monitorRequestPath: "C:\\runtime\\run-1\\monitor-request.json",
      classification,
    });
  }
});

test("operator monitor acknowledgement CLI rejects free-form and widened inputs", () => {
  for (const values of [
    ["--evidence-root", "relative", "--classification", "application_ready"],
    ["--evidence-root", "C:\\evidence\\run-1", "--classification", "application_ready"],
    ["--evidence-root", "C:\\evidence\\run-1", "--classification", "My Information"],
    ["--evidence-root", "C:\\evidence\\run-1", "--classification", "application_ready", "extra"],
  ]) assert.throws(() => parseOperatorMonitorAckArgs(values), /monitor acknowledgement arguments invalid/u);
});
