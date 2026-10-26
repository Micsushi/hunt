import assert from "node:assert/strict";
import test from "node:test";

import {
  parseExternalMonitorAckArgs,
  parseOperatorMonitorAckArgs,
} from "../../../src/live/runner/operator-monitor-ack.ts";

test("ordinal monitor ACK parser accepts only five exact path/value pairs", () => {
  assert.deepEqual(parseExternalMonitorAckArgs([
    "--runtime-root", "C:\\private\\runtime",
    "--evidence-root", "C:\\private\\evidence",
    "--monitor-request", "C:\\private\\evidence\\monitor\\0001-resume-before_mutation.request.json",
    "--classification", "safe_to_continue",
    "--observation", "C:\\private\\runtime\\0001-resume-before_mutation.observation.json",
  ]), {
    runtimeRoot: "C:\\private\\runtime",
    evidenceRoot: "C:\\private\\evidence",
    monitorRequestPath: "C:\\private\\evidence\\monitor\\0001-resume-before_mutation.request.json",
    classification: "safe_to_continue",
    observationPath: "C:\\private\\runtime\\0001-resume-before_mutation.observation.json",
  });
  assert.throws(() => parseExternalMonitorAckArgs([
    "--runtime-root", "C:\\private\\runtime",
    "--evidence-root", "C:\\private\\evidence",
    "--monitor-request", "C:\\private\\request.json",
    "--classification", "application_ready",
    "--observation", "C:\\private\\observation.json",
  ]), /monitor acknowledgement arguments invalid/u);
});

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
