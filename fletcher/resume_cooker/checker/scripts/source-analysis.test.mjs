import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeLatexText } from "./source-analysis.mjs";

test("analyzeLatexText reports layout risks and protects contact evidence", () => {
  const checks = analyzeLatexText("\\begin{paracol}{2}\\faGithub name@example.com Education Experience Projects Skills");
  const risk = checks.find((check) => check.id === "ats_layout_risk_scan");

  assert.equal(risk.status, "warning");
  assert.match(risk.evidence, /columns/);
  assert.match(risk.evidence, /icon font/);
  const contact = checks.find((check) => check.id === "contact_fields_parseable");

  assert.equal(contact.status, "pass");
  assert.doesNotMatch(contact.evidence, /name@example.com/);
});
