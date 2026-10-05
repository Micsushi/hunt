import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { getRepoRoot } from "../../generator/scripts/build-lib.mjs";
import { analyzeLatexText } from "./source-analysis.mjs";

test("analyzeLatexText warns on common ATS layout risks", () => {
  const checks = analyzeLatexText("\\begin{paracol}{2}\\faGithub Education Experience");
  const risk = checks.find((check) => check.id === "ats_layout_risk_scan");

  assert.equal(risk.status, "warning");
  assert.match(risk.evidence, /columns/);
  assert.match(risk.evidence, /icon font/);
});

test("analyzeLatexText detects contact without exposing private value", () => {
  const checks = analyzeLatexText("name@example.com Education Experience Projects Skills");
  const contact = checks.find((check) => check.id === "contact_fields_parseable");

  assert.equal(contact.status, "pass");
  assert.doesNotMatch(contact.evidence, /name@example.com/);
});

test("ats source avoids common layout risks", async () => {
  const source = await readFile(resolve(getRepoRoot(), "resume/source/ats.tex"), "utf8");
  const checks = analyzeLatexText(source);
  const risk = checks.find((check) => check.id === "ats_layout_risk_scan");

  assert.equal(risk.status, "pass");
});
