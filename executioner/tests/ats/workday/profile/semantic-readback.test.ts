import assert from "node:assert/strict";
import test from "node:test";

import { profileKnownAliasMatches } from
  "../../../../src/ats/workday/application/profile/semantic-readback.ts";

test("accepts Workday's committed phone-device canonical value", () => {
  assert.equal(profileKnownAliasMatches("phone.device_type", "CELL", "Mobile"), true);
  assert.equal(profileKnownAliasMatches("phone.device_type", "Home", "Mobile"), false);
});

test("accepts Workday's committed recruiting-source canonical values", () => {
  assert.equal(
    profileKnownAliasMatches("source.how_did_you_hear", "Direct Sourcing", "Recruiter"),
    true,
  );
  assert.equal(
    profileKnownAliasMatches("source.how_did_you_hear", "Recruiter Outreach", "Recruiter"),
    true,
  );
  assert.equal(
    profileKnownAliasMatches("source.how_did_you_hear", "Employee Referral", "Recruiter"),
    false,
  );
});

test("does not invent aliases for unrelated fields", () => {
  assert.equal(profileKnownAliasMatches("name.first", "Jane", "Jane"), undefined);
});
