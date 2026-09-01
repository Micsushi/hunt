import assert from "node:assert/strict";
import test from "node:test";

import { sharedUiKnownSemanticAliasMatches } from
  "../../../../src/deterministic/ui-state-model.ts";

test("accepts Workday's committed phone-device canonical value", () => {
  assert.equal(sharedUiKnownSemanticAliasMatches("phone.device_type", "CELL", "Mobile"), true);
  assert.equal(sharedUiKnownSemanticAliasMatches("phone.device_type", "Home", "Mobile"), undefined);
});

test("accepts Workday's committed recruiting-source canonical values", () => {
  assert.equal(
    sharedUiKnownSemanticAliasMatches("source.how_did_you_hear", "Direct Sourcing", "Recruiter"),
    true,
  );
  assert.equal(
    sharedUiKnownSemanticAliasMatches("source.how_did_you_hear", "Recruiter Outreach", "Recruiter"),
    true,
  );
  assert.equal(
    sharedUiKnownSemanticAliasMatches("source.how_did_you_hear", "Employee Referral", "Recruiter"),
    undefined,
  );
});

test("does not invent aliases for unrelated fields", () => {
  assert.equal(sharedUiKnownSemanticAliasMatches("name.first", "Jane", "Jane"), undefined);
});
