import assert from "node:assert/strict";
import { test } from "node:test";
import { adapterResultToCheck, runTesterAdapter, sanitizeTesterDetail } from "./tester-wrapper.mjs";

test("runTesterAdapter records an optional missing input as an explicit skip", async () => {
  const result = await runTesterAdapter({
    id: "ats-checker",
    preflight: async () => "PDF input is missing.",
    execute: async () => assert.fail("execute should not run")
  });

  assert.equal(result.state, "skipped");
  assert.equal(result.reason, "PDF input is missing.");
  assert.equal(adapterResultToCheck(result).status, "warning");
});

test("runTesterAdapter makes a required skip a capability failure", async () => {
  const result = await runTesterAdapter({
    id: "ats-checker",
    required: true,
    preflight: async () => "Python runtime is unavailable.",
    execute: async () => assert.fail("execute should not run")
  });
  const check = adapterResultToCheck(result);

  assert.equal(result.state, "skipped");
  assert.equal(check.status, "fail");
  assert.equal(check.severity, "blocker");
  assert.equal(check.metadata.required_capability_unavailable, true);
});

test("runTesterAdapter sanitizes a thrown preflight as a skip", async () => {
  const result = await runTesterAdapter({
    id: "ats-checker",
    preflight: async () => {
      throw new Error("C:\\Users\\private\\runtime failed");
    },
    execute: async () => assert.fail("execute should not run")
  });

  assert.equal(result.state, "skipped");
  assert.equal(result.failure_kind, "preflight_error");
  assert.doesNotMatch(result.reason, /Users|private/);
});

test("runTesterAdapter preserves an explicit measured deferral", async () => {
  const result = await runTesterAdapter({
    id: "resume-matcher",
    preflight: async () => ({
      reason: "Deferred: useful operations require the full service dependency boundary.",
      failure_kind: "deferred",
      metadata: { required_python: ">=3.13", dependency_count: 13 }
    }),
    execute: async () => assert.fail("execute should not run")
  });

  assert.equal(result.state, "skipped");
  assert.equal(result.failure_kind, "deferred");
  assert.equal(result.metadata.required_python, ">=3.13");
  assert.equal(result.metadata.dependency_count, 13);
});

test("runTesterAdapter classifies timeout and nonzero exits", async (t) => {
  await t.test("timeout", async () => {
    const error = new Error("python timed out");
    error.code = "ETIMEDOUT";
    const result = await runTesterAdapter({
      id: "ats-checker",
      execute: async () => {
        throw error;
      }
    });

    assert.equal(result.state, "executed_fail");
    assert.equal(result.failure_kind, "timeout");
  });

  await t.test("nonzero", async () => {
    const error = new Error("python exited with code 4");
    error.code = 4;
    error.stderr = "private parser output";
    const result = await runTesterAdapter({
      id: "ats-checker",
      execute: async () => {
        throw error;
      }
    });

    assert.equal(result.state, "executed_fail");
    assert.equal(result.failure_kind, "nonzero_exit");
    assert.doesNotMatch(result.reason, /private parser output/);
    assert.equal(adapterResultToCheck(result).status, "warning");
  });
});

test("adapterResultToCheck blocks a required execution failure", async () => {
  const result = await runTesterAdapter({
    id: "ats-checker",
    required: true,
    execute: async () => {
      const error = new Error("parser crashed");
      error.code = 4;
      throw error;
    }
  });

  assert.equal(result.state, "executed_fail");
  assert.equal(adapterResultToCheck(result).status, "fail");
});

test("runTesterAdapter classifies malformed output, pass, and warning", async (t) => {
  await t.test("malformed", async () => {
    const result = await runTesterAdapter({
      id: "ats-checker",
      execute: async () => ({ stdout: "not-json" }),
      evaluate: () => {
        const error = new Error("Malformed tester output.");
        error.code = "MALFORMED_OUTPUT";
        throw error;
      }
    });
    assert.equal(result.state, "executed_fail");
    assert.equal(result.failure_kind, "malformed_output");
  });

  await t.test("pass", async () => {
    const result = await runTesterAdapter({
      id: "ats-checker",
      execute: async () => ({ ok: true }),
      evaluate: () => ({ state: "executed_pass", metadata: { extracted_chars: 120 } })
    });
    assert.equal(result.state, "executed_pass");
    assert.deepEqual(result.metadata, { extracted_chars: 120 });
  });

  await t.test("warning", async () => {
    const result = await runTesterAdapter({
      id: "ats-checker",
      execute: async () => ({ ok: true }),
      evaluate: () => ({ state: "executed_warning", reason: "Parser agreement below threshold." })
    });
    assert.equal(result.state, "executed_warning");
  });
});

test("runTesterAdapter records a bounded duration", async () => {
  const times = [100, 145];
  const result = await runTesterAdapter({
    id: "ats-checker",
    nowImpl: () => times.shift(),
    execute: async () => ({ ok: true }),
    evaluate: () => ({ state: "executed_pass" })
  });

  assert.equal(result.duration_ms, 45);
});

test("sanitizeTesterDetail removes secrets, workspace paths, line breaks, and excess output", () => {
  const detail = sanitizeTesterDetail(
    `C:\\Users\\sushi\\Documents\\Github\\resume-cooker\\secret.py\nAPI_KEY=abc123 ${"x".repeat(300)}`
  );

  assert.doesNotMatch(detail, /sushi|abc123|\n/);
  assert.ok(detail.length <= 220);
});
