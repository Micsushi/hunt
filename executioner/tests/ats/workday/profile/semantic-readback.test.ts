import assert from "node:assert/strict";
import test from "node:test";

import { sharedUiKnownSemanticAliasMatches } from
  "../../../../src/deterministic/ui-state-model.ts";

test("Workday phone and recruiting-source aliases match only their own committed values", () => {
  for (const [field, committed, display, expected] of [
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
