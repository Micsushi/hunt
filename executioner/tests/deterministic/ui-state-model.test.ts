import assert from "node:assert/strict";
import test from "node:test";

import { boundedText } from "../../src/contracts/index.ts";
import {
  canonicalSharedUiTypes,
  evaluateSharedUiState,
  sharedUiContract,
  sharedUiIntentMatchesReadback,
  sharedUiTypeForBrowserControl,
  sharedUiTypes,
  sharedUiValueMatches,
  sharedUiVariant,
  type SharedUiStateInput,
} from "../../src/deterministic/ui-state-model.ts";

const committed = (type: (typeof sharedUiTypes)[number]): SharedUiStateInput => ({
  type,
  ownerState: "exact",
  backingState: "committed",
  stabilizationState: "stable",
  readbackState: "matches",
  validationState: "clear",
});

test("the shared model owns every supported UI family", () => {
  assert.equal(new Set(sharedUiTypes).size, sharedUiTypes.length);
  for (const type of sharedUiTypes) {
    const contract = sharedUiContract(type);
    assert.equal(contract.type, type);
    assert.notEqual(contract.mutation, "");
    assert.notEqual(contract.backingProof, "");
    assert.equal(evaluateSharedUiState(committed(type)).navigationEligible, true, type);
  }
});

test("native, controlled, custom ARIA, masked, segmented, tokenized, and repeatable variants route once", () => {
  assert.deepEqual(sharedUiVariant("text", "workday_text_v1"), {
    owner: "native", variant: "native", mutation: "input",
  });
  assert.deepEqual(sharedUiVariant("search_select", "workday_search_prompt_react"), {
    owner: "controlled", variant: "controlled", mutation: "popup_option",
  });
  assert.deepEqual(sharedUiVariant("listbox", "custom_aria_listbox"), {
    owner: "custom_aria", variant: "custom_aria", mutation: "popup_option",
  });
  assert.deepEqual(sharedUiVariant("date", "workday_masked_formatted_date"), {
    owner: "controlled", variant: "masked", mutation: "masked_date_input",
  });
  assert.deepEqual(sharedUiVariant("date", "workday_composite_segmented_date"), {
    owner: "composite", variant: "segmented", mutation: "segmented_date_input",
  });
  assert.deepEqual(sharedUiVariant("multi_select", "workday_token_prompt"), {
    owner: "controlled", variant: "tokenized", mutation: "token_list",
  });
  assert.deepEqual(sharedUiVariant("repeatable", "workday_rows"), {
    owner: "composite", variant: "repeatable", mutation: "row_action",
  });
});

test("known predecessor state failures cannot permit navigation", () => {
  const cases: readonly [string, Partial<SharedUiStateInput>, string][] = [
    ["visible value with empty backing", { backingState: "empty" }, "backing"],
    ["duplicate presentation owners", { ownerState: "ambiguous" }, "owner"],
    ["structural owner replacement", { ownerState: "changed" }, "owner"],
    ["remount still pending", { stabilizationState: "pending" }, "stabilization"],
    ["delayed rollback", { stabilizationState: "rolled_back" }, "stabilization"],
    ["option disappeared", { readbackState: "mismatch" }, "readback"],
    ["validation remained", { validationState: "invalid" }, "validation"],
    [
      "validation appeared after navigation",
      { validationState: "invalid", navigationEffect: "validation_appeared" },
      "post_navigation_validation",
    ],
  ];
  for (const [name, delta, blockedBy] of cases) {
    const fact = evaluateSharedUiState({ ...committed("search_select"), ...delta });
    assert.equal(fact.navigationEligible, false, name);
    assert.equal(fact.blockedBy, blockedBy, name);
  }
  assert.equal(evaluateSharedUiState({
    ...committed("multi_select"), stabilizationState: "remounted_stable",
  }).navigationEligible, true);
});

test("semantic readback uses the shared normalization for every value family", () => {
  assert.equal(sharedUiValueMatches("text", " Ada ", "Ada"), true);
  assert.equal(sharedUiValueMatches("textarea", "A\r\nB", "A\nB"), true);
  assert.equal(sharedUiValueMatches("contenteditable", "A\rB", "A\nB"), true);
  assert.equal(sharedUiValueMatches("phone", "+1 (303) 555-0100", "13035550100"), true);
  assert.equal(sharedUiValueMatches("month", "08", "8"), true);
  assert.equal(sharedUiValueMatches("select", "Direct Sourcing", " direct   sourcing "), true);
  assert.equal(sharedUiValueMatches("search_select", "Recruiter", "recruiter"), true);
  assert.equal(sharedUiValueMatches("multi_select", '["TypeScript","Python"]', '["python","typescript"]'), true);
  assert.equal(sharedUiValueMatches("date", "2026-08-31", "2026-08-31"), true);
  assert.equal(sharedUiValueMatches("year", "2026", "2026"), true);
  assert.equal(sharedUiValueMatches("url", "https://example.test", " https://example.test "), true);
});

test("questionnaire browser controls and intents consume the same classification and readback", () => {
  assert.equal(sharedUiTypeForBrowserControl({ kind: "text", element: "input" }), "text");
  assert.equal(sharedUiTypeForBrowserControl({ kind: "text", element: "textarea" }), "textarea");
  assert.equal(sharedUiTypeForBrowserControl({ kind: "date", element: "input" }), "date");
  assert.equal(sharedUiTypeForBrowserControl({
    kind: "choice", element: "input", choice: "checkbox", group: boundedText("g"), checked: true,
  }), "checkbox");
  assert.equal(sharedUiTypeForBrowserControl({
    kind: "select", element: "listbox", options: [boundedText("A")],
  }), "listbox");
  assert.equal(sharedUiIntentMatchesReadback({
    kind: "choice",
    behavior: "listbox",
    fieldId: "field-test" as never,
    target: "target-test" as never,
    optionId: "option-test" as never,
    expectedOption: boundedText("Site valid"),
    provenance: "visible_option",
  }, { kind: "selected", option: boundedText(" site valid ") }), true);
});

test("monitor taxonomy canonicalization shares the model and rejects unknown types", () => {
  assert.deepEqual(canonicalSharedUiTypes([
    "text", "file", "file_upload", "multi_select", "contenteditable",
  ]), ["text", "file_upload", "multi_select", "contenteditable"]);
  assert.throws(() => canonicalSharedUiTypes(["visible_div_guess"]), /unsupported shared UI type/u);
});
