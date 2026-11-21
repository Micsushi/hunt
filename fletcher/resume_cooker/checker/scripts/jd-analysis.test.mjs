import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeJobDescriptionText } from "./jd-analysis.mjs";

test("analyzeJobDescriptionText reports missing grounded terms as warnings", () => {
  const checks = analyzeJobDescriptionText("Backend engineer with Kubernetes and PostgreSQL", "");
  const coverage = checks.find((check) => check.id === "jd_keyword_coverage");

  assert.equal(coverage.status, "warning");
  assert.ok(coverage.metadata.missing_terms.includes("Kubernetes"));
});
