import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeJobDescriptionText, extractSignalTerms } from "./jd-analysis.mjs";

test("extractSignalTerms finds technical and role signals", () => {
  assert.deepEqual(
    extractSignalTerms("We need a software engineer with TypeScript, C++, PostgreSQL, and APIs."),
    ["software", "engineer", "TypeScript", "C++", "PostgreSQL", "APIs"]
  );
});

test("analyzeJobDescriptionText reports missing grounded terms as warnings", () => {
  const checks = analyzeJobDescriptionText("Backend engineer with Kubernetes and PostgreSQL", "");
  const coverage = checks.find((check) => check.id === "jd_keyword_coverage");

  assert.equal(coverage.status, "warning");
  assert.ok(coverage.metadata.missing_terms.includes("Kubernetes"));
});
