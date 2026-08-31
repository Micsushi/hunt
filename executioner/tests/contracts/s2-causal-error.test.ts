import assert from "node:assert/strict";
import test from "node:test";

import {
  earliestStage2Cause,
  stage2CausalCode,
  stage2CausalError,
} from "../../src/contracts/s2-causal-error.ts";

test("the deepest structured cause survives phase wrappers", () => {
  const root = stage2CausalError("browser_launch_binding", "browser_timeout");
  const observer = stage2CausalError("observer_evidence", "evidence_unavailable", root);
  const source = stage2CausalError("source_admission", "owner_config_invalid", observer);

  assert.deepEqual(earliestStage2Cause(source), {
    layer: "browser_launch_binding",
    code: "browser_timeout",
  });
  assert.equal(stage2CausalCode(source, "mcp_internal_error"), "browser_timeout");
});

test("an unstructured exception uses the phase-specific fallback", () => {
  assert.equal(
    stage2CausalCode(new Error("private detail"), "evidence_unavailable"),
    "evidence_unavailable",
  );
});
