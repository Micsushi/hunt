import assert from "node:assert/strict";
import test from "node:test";
import { semanticSyntheticTestDefault, testingQuestionSemanticType } from "../../src/form/answers/testing-policy.ts";

test("numeric employee identifiers and hourly compensation receive editable numeric test defaults", () => {
  for (const label of ["Your Workday ID (not your Logon ID)", "Employee number", "What is your desired Hourly Rate?", "Expected hourly wage"]) {
    assert.match(String(semanticSyntheticTestDefault(label)), /^\d+$/);
  }
  assert.equal(testingQuestionSemanticType("What is your desired Hourly Rate?"), "compensation");
  assert.equal(semanticSyntheticTestDefault("Employee name"), undefined);
  assert.equal(semanticSyntheticTestDefault("How do you rate our company?"), undefined);
});
