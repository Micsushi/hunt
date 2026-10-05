import assert from "node:assert/strict";
import { test } from "node:test";
import {
  criticalTermsPresentInSource,
  exitCodeForError,
  exitCodeForReport,
  runCheck
} from "./check.mjs";

test("exitCodeForReport maps D7 pass and quality failure", () => {
  assert.equal(exitCodeForReport({ status: "pass", checks: [] }), 0);
  assert.equal(exitCodeForReport({ status: "pass_with_warnings", checks: [] }), 0);
  assert.equal(exitCodeForReport({ status: "fail", checks: [] }), 2);
});

test("exitCodeForReport maps missing strict capability to 69", () => {
  assert.equal(
    exitCodeForReport({
      status: "fail",
      checks: [{ metadata: { required_capability_unavailable: true } }]
    }),
    69
  );
});

test("exitCodeForError maps D7 capability, usage, and internal failures", () => {
  assert.equal(exitCodeForError({ code: "CAPABILITY_UNAVAILABLE" }), 69);
  assert.equal(exitCodeForError({ code: "INVALID_USAGE" }), 64);
  assert.equal(exitCodeForError(new Error("unexpected")), 70);
});

test("strict local check requires a PDF artifact", async () => {
  const report = await runCheck({
    suite: "local",
    profile: "strict",
    resume: "resume/source/ats.tex",
    pdf: "resume/output/does-not-exist.pdf"
  });
  const missing = report.checks.find((check) => check.id === "pdf_artifact_unavailable");

  assert.equal(report.status, "fail");
  assert.equal(missing.metadata.required_capability_unavailable, true);
  assert.equal(exitCodeForReport(report), 69);
});

test("PDF critical-term checks only expect terms present in caller source", () => {
  assert.deepEqual(criticalTermsPresentInSource("Python and SQLite"), []);
  assert.deepEqual(criticalTermsPresentInSource("Kubernetes and PostgreSQL"), [
    "Kubernetes",
    "PostgreSQL"
  ]);
});
