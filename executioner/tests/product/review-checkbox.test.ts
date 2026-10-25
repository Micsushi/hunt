import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { profileReviewDisplayValue, reviewAnswerCandidates, unknownProfileReviewFieldId } from "../../src/browser/playwright-live/private/workday-application-runtime.ts";

test("unknown Review ordinals are scoped to the physical profile page", () => {
  const info = unknownProfileReviewFieldId("s2-profile:applyFlowMyInfoPage", "unknown.required.1");
  const experience = unknownProfileReviewFieldId("s2-profile:applyFlowMyExperiencePage", "unknown.required.1");
  assert.notEqual(info, experience);
  assert.equal(info, unknownProfileReviewFieldId("s2-profile:applyFlowMyInfoPage", "unknown.required.1"));
  assert.notEqual(info, unknownProfileReviewFieldId("s2-profile:applyFlowMyInfoPage", "unknown.required.2"));
});

test("typed checkbox Review expectations match Yes/No without accepting opposite or unrelated text", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  for (const [committed, displayed, opposite] of [["true", "Yes", "No"], ["false", "No", "Yes"]]) {
    const expected = hash(profileReviewDisplayValue("boolean", "checkbox", committed!));
    assert.ok([...reviewAnswerCandidates(displayed!)].some(value => hash(value) === expected));
    assert.ok(![...reviewAnswerCandidates(opposite!)].some(value => hash(value) === expected));
    assert.ok(![...reviewAnswerCandidates("No Response")].some(value => hash(value) === expected));
  }
  assert.equal(profileReviewDisplayValue("text", "text", "true"), "true");
  assert.equal(profileReviewDisplayValue("boolean", "radio_group", "true"), "true");
  assert.equal(profileReviewDisplayValue("boolean", "checkbox", "unknown"), "unknown");
});


test("month Review matching tolerates display padding without treating arbitrary numbers as dates", () => {
  const expected = profileReviewDisplayValue("month", "month", "1");
  assert.ok(reviewAnswerCandidates("01/2000").has(expected));
  assert.ok(!reviewAnswerCandidates("02/2000").has(expected));
  assert.equal(profileReviewDisplayValue("text", "text", "1"), "1");
});
