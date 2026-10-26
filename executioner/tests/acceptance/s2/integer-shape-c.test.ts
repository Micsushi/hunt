import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertAttemptProof,
  assertNonSubmittable,
  retained,
  runQuestionnaireFixture,
} from "./integer-retained-fixture-support.ts";

const fixture = readFileSync(new URL("./fixtures/integer-shape-c.html", import.meta.url), "utf8");

test("exact Integer Shape C uses radio semantics and leaves its unlabeled control untouched", async () => {
  const result = await runQuestionnaireFixture(fixture, "integer-shape-c");
  try {
    assert.equal(result.completed.ok && result.completed.value.kind, "blocked");
    assert.equal(result.completed.value.code, "profile_answer_missing");
    const attempted = result.evidence.controls.filter(({ terminalDisposition }) =>
      terminalDisposition === "verified"
    );
    const unresolved = result.evidence.controls.find(({ terminalDisposition }) =>
      terminalDisposition === "needs_owner_input"
    );
    assert.deepEqual(attempted.map(({ label, uiType }) => [label, uiType] as const)
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))), [
      ["Language", "select"],
      ["Name", "text"],
      ["Date", "date"],
      ["Please check one of the boxes below", "radio"],
    ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
    assertAttemptProof(result, 4);
    assert.equal(unresolved?.lane, null);
    assert.equal(unresolved?.monitorBinding, null);
    assert.equal(unresolved?.observationBinding?.stateObservedAck, true);
    assert.equal(unresolved?.immediateReadback, "unset");
    assert.equal(unresolved?.validation, "not_attempted");
    assert.equal(unresolved?.transition, "fixture_retained");
    assert.equal(unresolved?.terminalDisposition, "needs_owner_input");
    assert.equal(await result.page.locator("#self-identify-language").inputValue(), "English");
    assert.equal(await result.page.locator("#self-identify-name").inputValue(), "Fixture Candidate");
    assert.equal(await result.page.locator("#self-identify-date").inputValue(), "2026-08-22");
    assert.equal(await result.page.locator('input[name="disability-status"]:checked').count(), 1);
    assert.equal(
      await result.page.locator('input[name="disability-status"]:checked').inputValue(),
      "decline",
    );
    const unresolvedControl = result.page.locator("#unresolved-adjacent-control");
    assert.equal(await unresolvedControl.inputValue(), "");
    assert.equal(await unresolvedControl.getAttribute("aria-label"), null);
    assert.equal(await unresolvedControl.getAttribute("name"), null);
    assert.equal(await unresolvedControl.getAttribute("placeholder"), null);
    const retainedUnresolved = retained("self_identify").find(({ identity }) =>
      identity === "unresolved"
    );
    assert.equal(retainedUnresolved?.sanitizedLabel, null);
    assert.equal(retainedUnresolved?.normalizedQuestionType, "unknown");
    assert.equal(retainedUnresolved?.required, null);
    assert.equal(retainedUnresolved?.initialState, "unset");
    const disability = retained("self_identify").find(({ identity }) =>
      identity === "disability_disclosure"
    );
    assert.equal(disability?.behavior, "radio");
    assert.equal(disability?.answerType, "single_select");
    assert.equal(disability?.uiVariant, "workday_radio_v1");
    assert.deepEqual(disability?.allowedOptions, [
      "Yes, I have a disability, or have had one in the past",
      "No, I do not have a disability and have not had one in the past",
      "I do not want to answer",
    ]);
    await assertNonSubmittable(result.page);
  } finally {
    await result.close();
  }
});
