import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeExtractedText } from "./text-layer.mjs";

test("text-layer checks report ordered sections, empty text and corrupted text", () => {
  for (const [text, expected] of [
    ["Education\nUniversity\nExperience\nBuilt APIs\nProjects\nCompiler\nSkills\nTypeScript",
      { pdf_text_non_empty: "pass", section_headings_present: "pass", section_order_readable: "pass" }],
    ["", { pdf_text_non_empty: "fail" }],
    ["Experience\nWork\nEducation\nSchool\nProjects\nProject\nSkills\nTypeScript\uFFFD",
      { section_order_readable: "warning", encoding_noise_low: "warning" }]
  ]) {
    const checks = new Map(analyzeExtractedText(text).map(check => [check.id, check.status]));
    for (const [id, status] of Object.entries(expected)) assert.equal(checks.get(id), status, id);
  }
});
