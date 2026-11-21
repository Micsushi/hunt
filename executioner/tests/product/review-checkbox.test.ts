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

test("Review matches typed checkbox and month values only to their correct displays", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  for (const [type, behavior, value, display, rejected] of [
    ["boolean", "checkbox", "true", "Yes", ["No", "No Response"]],
    ["boolean", "checkbox", "false", "No", ["Yes", "No Response"]],
    ["month", "month", "1", "01/2000", ["02/2000"]],
  ] as const) {
    const expected = hash(profileReviewDisplayValue(type, behavior, value));
    const matches = (text: string) => [...reviewAnswerCandidates(text)].some(candidate => hash(candidate) === expected);
    assert.ok(matches(display), display);
    for (const other of rejected) assert.ok(!matches(other), other);
  }
  assert.equal(profileReviewDisplayValue("text", "text", "true"), "true");
  assert.equal(profileReviewDisplayValue("boolean", "radio_group", "true"), "true");
  assert.equal(profileReviewDisplayValue("boolean", "checkbox", "unknown"), "unknown");
  assert.equal(profileReviewDisplayValue("text", "text", "1"), "1");
});
