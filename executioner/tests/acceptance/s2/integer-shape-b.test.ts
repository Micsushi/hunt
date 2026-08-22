import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertAttemptProof,
  assertNonSubmittable,
  retained,
  runQuestionnaireFixture,
} from "./integer-retained-fixture-support.ts";

const fixture = readFileSync(new URL("./fixtures/integer-shape-b.html", import.meta.url), "utf8");

test("exact Integer Shape B binds Veteran and consent as separate non-submittable controls", async () => {
  const result = await runQuestionnaireFixture(fixture, "integer-shape-b");
  try {
    assert.deepEqual(result.completed, {
      ok: true,
      value: {
        kind: "blocked",
        code: "synthetic_test_non_submittable",
        fieldId: result.snapshot.fields[0]?.fieldId,
        protectedCategory: null,
      },
    });
    assert.deepEqual(result.evidence.controls.map((control) => control.label).sort(), [
      "Yes, I have read and consent to the terms and conditions",
      "Select Veteran Status",
    ].sort());
    assertAttemptProof(result, 2);
    assert.equal(await result.page.locator("#veteran-status").inputValue(), "I do not want to answer");
    assert.equal(await result.page.locator("#terms-consent").isChecked(), true);
    assert.deepEqual(retained("voluntary_disclosures").map((entry) => ({
      identity: entry.identity,
      behavior: entry.behavior,
      uiVariant: entry.uiVariant,
      required: entry.required,
    })), [
      {
        identity: "veteran_disclosure",
        behavior: "select",
        uiVariant: "workday_select_v1",
        required: true,
      },
      {
        identity: "terms_consent",
        behavior: "checkbox",
        uiVariant: "workday_checkbox_v2",
        required: true,
      },
    ]);
    await assertNonSubmittable(result.page);
  } finally {
    await result.close();
  }
});
