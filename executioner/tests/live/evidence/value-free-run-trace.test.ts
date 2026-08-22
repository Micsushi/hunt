import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createValueFreeRunTrace,
  readValueFreeRunTrace,
} from "../../../src/live/evidence/value-free-run-trace.ts";

test("durable run trace retains ordered structural state and drops applicant values", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-value-free-trace-"));
  const streamed: string[] = [];
  try {
    const trace = createValueFreeRunTrace(root, (line) => streamed.push(line));
    trace("application_walk_progress", {
      checkpoint: "questionnaire",
      browserPage: "questionnaire",
      questionTypes: ["authorization", "employment"],
      answerTypes: ["single_select", "number"],
      completedPages: 2,
      code: "page_incomplete",
      classifier: "required_field_gate",
      primitive: "required_field_verification",
      unknownLayer: "required_field",
      submitActivated: false,
      email: "applicant_private_sentinel",
      answer: "private answer",
    });
    trace("external_monitor_acknowledged", {
      chain: "application",
      page: "questionnaire",
      moment: "after_readback",
      ordinal: 7,
      operationId: "operation_question_mutation_01",
      attempt: 1,
      submitPresent: false,
      submitActivated: false,
    });
    trace("questionnaire_checkbox_diagnostics", {
      groupCount: 1,
      checkboxCount: 3,
      checkedCount: 0,
      adapterSelectCount: 5,
      adapterExclusiveSelectCount: 1,
      sharedOptionSelectCount: 2,
      exactObjectCallCount: 2,
      exactCommitCount: 0,
      nested: { answer: "private answer" },
    });
    trace("questionnaire_date_diagnostics", {
      dateInputCount: 1,
      allTextTelInputCount: 4,
      maskedInputCount: 1,
      visibleMaskedInputCount: 0,
      exactDateLabelCount: 1,
      exactMaskTextCount: 1,
      exactMaskTextSpanCount: 1,
      dateOwnerCandidateCount: 1,
      dateOwnerInputCount: 1,
      dateOwnerSvgCount: 1,
      boundDateInputCount: 1,
      boundDateExactLabelCount: 2,
      boundDateAssociatedLabelCount: 2,
      boundDateClosestFormFieldCount: 0,
      boundDateClosestDateSectionCount: 0,
      boundDatePlaceholderMaskCount: 0,
      boundDateValueMaskCount: 1,
      boundDateReactOnChangeCount: 1,
      dateSvgOwnerCandidateCount: 1,
      dateSvgOwnerDepth: 2,
      dateSvgOwnerExactLabelCount: 2,
      dateSvgOwnerLabelCount: 2,
      dateSvgOwnerSvgCount: 1,
      dateSvgOwnerInputCount: 1,
      dateSvgOwnerButtonCount: 0,
      dateSvgOwnerRoleButtonCount: 0,
      dateSvgOwnerAutomationCount: 1,
      dateSvgOwnerReactClickCount: 1,
      boundRightHitInput: false,
      boundRightHitWithinSvgOwner: true,
      boundRightHitSvgAncestor: true,
      boundRightReactClickAncestorCount: 1,
      ownedDateLabelOwnerDepth: 3,
      ownedDateLabelOwnerVisibleLabelCount: 2,
      ownedDateLabelOwnerExactLabelCount: 2,
      ownedDateLabelOwnerVisibleTextTelInputCount: 1,
      ownedDateLabelOwnerSvgCount: 1,
      ownedDateLabelOwnerButtonCount: 1,
      reboundDateExactLabelCount: 2,
      reboundDateLabelInputOwnerCount: 2,
      reboundDateLabelSvgOwnerCount: 2,
      reboundDateDistinctInputCount: 1,
      reboundDateDistinctSvgCount: 1,
      reboundDateJointOwnerCount: 1,
      formattedDateReboundCount: 1,
      fieldButtonCount: 0,
      fieldRoleButtonCount: 0,
      fieldSvgCount: 1,
      fieldAutomationCount: 2,
      rightHitInput: false,
      rightHitWithinField: true,
      rightHitButtonAncestor: false,
      rightHitRoleButtonAncestor: false,
      rightHitSvgAncestor: true,
      rightHitAutomationAncestor: true,
      rightHitReactClickAncestorCount: 1,
      applicantValue: "private date",
    });

    const path = join(root, "value-free-trace.ndjson");
    const text = readFileSync(path, "utf8");
    assert.equal(text.includes("applicant_private_sentinel"), false);
    assert.equal(text.includes("private answer"), false);
    assert.equal(streamed.join("").includes("applicant_private_sentinel"), false);
    const records = readValueFreeRunTrace(path);
    assert.deepEqual(records.map(({ sequence, event }) => [sequence, event]), [
      [1, "application_walk_progress"],
      [2, "external_monitor_acknowledged"],
      [3, "questionnaire_checkbox_diagnostics"],
      [4, "questionnaire_date_diagnostics"],
    ]);
    assert.deepEqual(records[0]?.details.questionTypes, ["authorization", "employment"]);
    assert.deepEqual(records[2]?.details, {
      groupCount: 1,
      checkboxCount: 3,
      checkedCount: 0,
      adapterSelectCount: 5,
      adapterExclusiveSelectCount: 1,
      sharedOptionSelectCount: 2,
      exactObjectCallCount: 2,
      exactCommitCount: 0,
    });
    assert.deepEqual(records[3]?.details, {
      dateInputCount: 1,
      allTextTelInputCount: 4,
      maskedInputCount: 1,
      visibleMaskedInputCount: 0,
      exactDateLabelCount: 1,
      exactMaskTextCount: 1,
      exactMaskTextSpanCount: 1,
      dateOwnerCandidateCount: 1,
      dateOwnerInputCount: 1,
      dateOwnerSvgCount: 1,
      boundDateInputCount: 1,
      boundDateExactLabelCount: 2,
      boundDateAssociatedLabelCount: 2,
      boundDateClosestFormFieldCount: 0,
      boundDateClosestDateSectionCount: 0,
      boundDatePlaceholderMaskCount: 0,
      boundDateValueMaskCount: 1,
      boundDateReactOnChangeCount: 1,
      dateSvgOwnerCandidateCount: 1,
      dateSvgOwnerDepth: 2,
      dateSvgOwnerExactLabelCount: 2,
      dateSvgOwnerLabelCount: 2,
      dateSvgOwnerSvgCount: 1,
      dateSvgOwnerInputCount: 1,
      dateSvgOwnerButtonCount: 0,
      dateSvgOwnerRoleButtonCount: 0,
      dateSvgOwnerAutomationCount: 1,
      dateSvgOwnerReactClickCount: 1,
      boundRightHitInput: false,
      boundRightHitWithinSvgOwner: true,
      boundRightHitSvgAncestor: true,
      boundRightReactClickAncestorCount: 1,
      ownedDateLabelOwnerDepth: 3,
      ownedDateLabelOwnerVisibleLabelCount: 2,
      ownedDateLabelOwnerExactLabelCount: 2,
      ownedDateLabelOwnerVisibleTextTelInputCount: 1,
      ownedDateLabelOwnerSvgCount: 1,
      ownedDateLabelOwnerButtonCount: 1,
      reboundDateExactLabelCount: 2,
      reboundDateLabelInputOwnerCount: 2,
      reboundDateLabelSvgOwnerCount: 2,
      reboundDateDistinctInputCount: 1,
      reboundDateDistinctSvgCount: 1,
      reboundDateJointOwnerCount: 1,
      formattedDateReboundCount: 1,
      fieldButtonCount: 0,
      fieldRoleButtonCount: 0,
      fieldSvgCount: 1,
      fieldAutomationCount: 2,
      rightHitInput: false,
      rightHitWithinField: true,
      rightHitButtonAncestor: false,
      rightHitRoleButtonAncestor: false,
      rightHitSvgAncestor: true,
      rightHitAutomationAncestor: true,
      rightHitReactClickAncestorCount: 1,
    });
    assert.equal(Object.isFrozen(records[0]?.details), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace observer and invalid details never alter runtime behavior", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-value-free-trace-failure-"));
  try {
    const trace = createValueFreeRunTrace(root, () => { throw new Error("observer failed"); });
    assert.doesNotThrow(() => trace("account_state_observed", { value: "secret" }));
    assert.equal(readValueFreeRunTrace(join(root, "value-free-trace.ndjson")).length, 1);
    writeFileSync(join(root, "malformed.ndjson"), '{"schemaVersion":1}\n');
    assert.throws(
      () => readValueFreeRunTrace(join(root, "malformed.ndjson")),
      /value-free run trace denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
