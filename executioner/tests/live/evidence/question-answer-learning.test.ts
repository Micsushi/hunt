import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  boundedText,
  browserTargetToken,
  fieldId,
  optionId,
  questionId,
} from "../../../src/contracts/index.ts";
import {
  admitQuestionAnswerLearningEvidence,
  createQuestionAnswerLearningCapture,
} from "../../../src/live/evidence/question-answer-learning.ts";

test("question learning stores observed choices, fallback, provenance, and replacement intent", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-"));
  try {
    const capture = createQuestionAnswerLearningCapture({
      root,
      sensitiveValues: ["Woman"],
    });
    capture.record({
      questionId: questionId("observed-question-0123456789abcdef01234567"),
      field: {
        fieldId: fieldId("question-gender"),
        target: browserTargetToken("target-gender"),
        label: boundedText("Gender"),
        required: false,
        behavior: "select",
        options: [
          { id: optionId("gender-placeholder"), label: boundedText("Select One") },
          { id: optionId("gender-first"), label: boundedText("Woman") },
          { id: optionId("gender-other"), label: boundedText("Other") },
        ],
        state: "empty",
      },
      intent: {
        kind: "choice",
        behavior: "select",
        fieldId: fieldId("question-gender"),
        target: browserTargetToken("target-gender"),
        optionId: optionId("gender-first"),
        expectedOption: boundedText("Woman"),
        provenance: "visible_option",
      },
      protectedCategory: "legal",
      generatedDefault: false,
    });

    const sha256 = capture.write();
    assert.match(sha256 ?? "", /^[0-9a-f]{64}$/u);
    const evidence = admitQuestionAnswerLearningEvidence(JSON.parse(
      readFileSync(join(root, "question-answer-learning.json"), "utf8"),
    ));
    assert.deepEqual(evidence.questions, [{
      questionId: "observed-question-0123456789abcdef01234567",
      fieldId: "question-gender",
      label: "Gender",
      required: false,
      uiType: "select",
      answerType: "single_select",
      possibleAnswers: ["Select One", "Woman", "Other"],
      chosenAnswer: "Woman",
      strategy: "first_visible_option",
      provenance: "visible_option",
      replaceWithOwnerAnswer: true,
    }]);
    assert.equal(capture.write(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("question learning redacts owner text while preserving the question contract", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-owner-"));
  try {
    const capture = createQuestionAnswerLearningCapture({ root });
    capture.record({
      questionId: questionId("question-current-employer"),
      field: {
        fieldId: fieldId("question-current-employer"),
        target: browserTargetToken("target-current-employer"),
        label: boundedText("Current employer"),
        required: true,
        behavior: "text",
        options: [],
        state: "empty",
      },
      intent: {
        kind: "text",
        behavior: "text",
        fieldId: fieldId("question-current-employer"),
        target: browserTargetToken("target-current-employer"),
        value: "Private Employer Name",
        provenance: "owner_provided",
      },
      protectedCategory: null,
      generatedDefault: false,
    });
    capture.write();
    const text = readFileSync(join(root, "question-answer-learning.json"), "utf8");
    assert.doesNotMatch(text, /Private Employer Name/u);
    assert.match(text, /owner_answer_applied/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("question learning redacts the selected owner choice", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-owner-controls-"));
  try {
    const capture = createQuestionAnswerLearningCapture({ root });
    capture.record({
      questionId: questionId("question-private-choice"),
      field: {
        fieldId: fieldId("question-private-choice"),
        target: browserTargetToken("target-private-choice"),
        label: boundedText("Private choice"),
        required: true,
        behavior: "select",
        options: [
          { id: optionId("private-choice-yes"), label: boundedText("Yes") },
          { id: optionId("private-choice-no"), label: boundedText("No") },
        ],
        state: "empty",
      },
      intent: {
        kind: "choice",
        behavior: "select",
        fieldId: fieldId("question-private-choice"),
        target: browserTargetToken("target-private-choice"),
        optionId: optionId("private-choice-yes"),
        expectedOption: boundedText("Yes"),
        provenance: "owner_provided",
      },
      protectedCategory: null,
      generatedDefault: false,
    });
    capture.write();
    const text = readFileSync(join(root, "question-answer-learning.json"), "utf8");
    const evidence = JSON.parse(text) as {
      readonly questions: readonly { readonly chosenAnswer: string }[];
    };
    assert.equal(evidence.questions[0]?.chosenAnswer, "owner_answer_applied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
