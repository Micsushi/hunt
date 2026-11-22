import assert from "node:assert/strict";
import test from "node:test";

import { sharedUiKnownSemanticAliasMatches } from
  "../../../../src/deterministic/ui-state-model.ts";

test("Workday profile aliases match only compatible committed values", () => {
  const degree = "Bachelor’s / Undergraduate Degree (3-4 year degree equivalent e.g., BA, BS, LLB, etc.)";
  for (const [field, committed, display, expected] of [
    ["education.degree", degree, "Bachelor of Science", true],
    ["education.degree", degree, "B.Sc.", true],
    ["education.degree", degree, "Master of Science", undefined],
    ["education.degree", degree.replace("BA, BS, LLB", "BA, LLB"), "Bachelor of Science", undefined],
    ["education.degree", degree.replace("LLB", "PhD"), "Bachelor of Science", undefined],
    ["education.degree", degree.replace("Bachelor’s / Undergraduate Degree", "Bachelor of Arts"), "Bachelor of Science", undefined],
    ["education.degree", degree.replace("Bachelor’s / Undergraduate Degree", "Master’s / Graduate Degree"), "Bachelor of Science", undefined],
    ["phone.device_type", "CELL", "Mobile", true],
    ["phone.device_type", "Home", "Mobile", undefined],
    ["source.how_did_you_hear", "Direct Sourcing", "Recruiter", true],
    ["source.how_did_you_hear", "Recruiter Outreach", "Recruiter", true],
    ["source.how_did_you_hear", "Employee Referral", "Recruiter", undefined],
    ["name.first", "Jane", "Jane", undefined],
  ] as const) {
    assert.equal(sharedUiKnownSemanticAliasMatches(field, committed, display), expected, committed);
  }
});
