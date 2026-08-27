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
  type QuestionAnswerLearningCapture,
} from "../../../src/live/evidence/question-answer-learning.ts";

test("question learning stores observed choices, fallback, provenance, and replacement intent", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-"));
  try {
    const capture = createQuestionAnswerLearningCapture({
      root,
      mode: "synthetic_test_non_submittable",
      sensitiveValues: ["Woman"],
    });
    recordVerified(capture, {
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
      lane: "synthetic_test_default",
      protectedCategory: "legal",
      generatedDefault: false,
      conditionalReveal: true,
      semanticQuestionType: "demographic",
    }, 1);

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
      answerState: "answered",
      lane: "synthetic_test_default",
      chosenAnswer: "Woman",
      strategy: "random_visible_option",
      provenance: "visible_option",
      replaceWithOwnerAnswer: true,
      interactionState: "attempted",
      monitorBinding: binding(1),
      verificationResult: "verified",
      failureCode: null,
      retryable: false,
      terminalDisposition: "verified",
      attemptHistory: [{
        ...binding(1),
        outcome: "verified",
        failureCode: null,
        retryable: false,
      }],
    }]);
    const pending = JSON.parse(readFileSync(
      join(root, "pending-profile-questions.json"),
      "utf8",
    ));
    assert.deepEqual(pending.pendingProfileQuestions, [{
      questionId: "observed-question-0123456789abcdef01234567",
      fieldId: "question-gender",
      exactQuestion: "Gender",
      required: false,
      semanticQuestionType: "demographic",
      answerType: "single_select",
      controlType: "select",
      options: ["Select One", "Woman", "Other"],
      constraints: null,
      conditionalReveal: true,
      testDefault: "Woman",
      actualOwnerValue: null,
      needsUserValue: true,
      provenance: "visible_option",
      validation: "verified",
      committedReadback: "Woman",
    }]);
    assert.equal(capture.write(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("question learning redacts owner text while preserving the question contract", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-owner-"));
  try {
    const capture = createQuestionAnswerLearningCapture({ root, mode: "live" });
    recordVerified(capture, {
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
      lane: "live_owner_fact",
      protectedCategory: null,
      generatedDefault: false,
    }, 2);
    capture.write();
    const text = readFileSync(join(root, "question-answer-learning.json"), "utf8");
    assert.doesNotMatch(text, /Private Employer Name/u);
    assert.match(text, /owner_answer_applied/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("question learning admits reviewed opaque operation ids that collide with sensitive suffixes", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-operation-id-"));
  try {
    const operationId = operation(22);
    const capture = createQuestionAnswerLearningCapture({
      root,
      mode: "live",
      sensitiveValues: [operationId.replace(/^operation_/u, "")],
    });
    const value = ownerChoice(22);
    capture.recordAttempt({ operationId, ...value });
    capture.monitorAck({ operationId, attempt: 1, moment: "before_mutation" });
    capture.monitorAck({ operationId, attempt: 1, moment: "after_readback" });
    capture.record({ operationId, ...value });
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    const evidence = admitQuestionAnswerLearningEvidence(JSON.parse(
      readFileSync(join(root, "question-answer-learning.json"), "utf8"),
    ));
    assert.equal(evidence.questions[0]?.attemptHistory[0]?.operationId, operationId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("question learning redacts the selected owner choice", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-owner-controls-"));
  try {
    const capture = createQuestionAnswerLearningCapture({ root, mode: "live" });
    recordVerified(capture, {
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
      lane: "live_owner_fact",
      protectedCategory: null,
      generatedDefault: false,
    }, 3);
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

test("question learning proves explicit unset without applicant values", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-unset-"));
  try {
    const capture = createQuestionAnswerLearningCapture({ root, mode: "live" });
    capture.recordUnset({
      questionId: questionId("question-prior-employment"),
      field: {
        fieldId: fieldId("question-prior-employment"),
        target: browserTargetToken("target-prior-employment"),
        label: boundedText("Previously worked for organization"),
        required: true,
        behavior: "radio",
        options: [],
        state: "empty",
      },
    });
    capture.write();
    const evidence = admitQuestionAnswerLearningEvidence(JSON.parse(
      readFileSync(join(root, "question-answer-learning.json"), "utf8"),
    ));
    assert.equal(evidence.executionMode, "live");
    assert.equal(evidence.liveAcceptanceEligible, false);
    assert.deepEqual(evidence.questions.map(({ answerState, lane, provenance }) => ({
      answerState,
      lane,
      provenance,
    })), [{ answerState: "unset", lane: null, provenance: null }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("question learning strictly rejects absent, invalid, extra, or synthetic live lanes", () => {
  const record = {
    questionId: "question-owner-answer",
    fieldId: "field-owner-answer",
    label: "Owner answer",
    required: true,
    uiType: "select",
    answerType: "single_select",
    possibleAnswers: ["Yes", "No"],
    answerState: "answered",
    lane: "live_owner_fact",
    chosenAnswer: "owner_answer_applied",
    strategy: "owner_answer",
    provenance: "owner_provided",
    replaceWithOwnerAnswer: false,
    interactionState: "attempted",
    monitorBinding: binding(4),
    verificationResult: "verified",
    failureCode: null,
    retryable: false,
    terminalDisposition: "verified",
    attemptHistory: [{
      ...binding(4),
      outcome: "verified",
      failureCode: null,
      retryable: false,
    }],
  } as const;
  const base = {
    schemaVersion: 4 as const,
    evidenceRevision: "s2-question-answer-learning-v4" as const,
    page: "questionnaire" as const,
    executionMode: "live" as const,
    testOnly: false,
    liveAcceptanceEligible: true,
    questions: [record],
  };
  const { lane: _lane, ...missingLane } = record;
  assert.doesNotThrow(() => admitQuestionAnswerLearningEvidence(base));
  for (const invalid of [
    { ...base, questions: [missingLane] },
    { ...base, questions: [{ ...record, lane: "invalid" }] },
    { ...base, questions: [{ ...record, lane: "synthetic_test_default" }] },
    { ...base, questions: [{ ...record, extra: true }] },
    { ...base, questions: [{ ...record, provenance: "reviewed_catalog" }] },
  ]) assert.throws(() => admitQuestionAnswerLearningEvidence(invalid as never));
});

test("question learning rejects hostile failure codes and retryable verified attempts", () => {
  const verified = {
    questionId: "question-owner-answer",
    fieldId: "field-owner-answer",
    label: "Owner answer",
    required: true,
    uiType: "select",
    answerType: "single_select",
    possibleAnswers: ["Yes", "No"],
    answerState: "answered",
    lane: "live_owner_fact",
    chosenAnswer: "owner_answer_applied",
    strategy: "owner_answer",
    provenance: "owner_provided",
    replaceWithOwnerAnswer: false,
    interactionState: "attempted",
    monitorBinding: binding(40),
    verificationResult: "verified",
    failureCode: null,
    retryable: false,
    terminalDisposition: "verified",
    attemptHistory: [{
      ...binding(40),
      outcome: "verified",
      failureCode: null,
      retryable: false,
    }],
  } as const;
  const base = {
    schemaVersion: 4 as const,
    evidenceRevision: "s2-question-answer-learning-v4" as const,
    page: "questionnaire" as const,
    executionMode: "live" as const,
    testOnly: false,
    liveAcceptanceEligible: true,
    questions: [verified],
  };
  const failed = {
    ...verified,
    monitorBinding: binding(41),
    verificationResult: "driver_failed",
    failureCode: "driver_target_stale",
    retryable: true,
    terminalDisposition: "driver_failed",
    attemptHistory: [{
      ...binding(41),
      outcome: "driver_failed",
      failureCode: "driver_target_stale",
      retryable: true,
    }],
  };
  const hostileCodes = [{ raw: "private" }, "x".repeat(65), "raw private value!"];
  for (const failureCode of hostileCodes) {
    assert.throws(() => admitQuestionAnswerLearningEvidence({
      ...base,
      liveAcceptanceEligible: false,
      questions: [{
        ...failed,
        failureCode,
        attemptHistory: [{ ...failed.attemptHistory[0], failureCode }],
      }],
    } as never));
  }
  assert.throws(() => admitQuestionAnswerLearningEvidence({
    ...base,
    questions: [{
      ...verified,
      retryable: true,
      attemptHistory: [{ ...verified.attemptHistory[0], retryable: true }],
    }],
  } as never));
});

test("question learning retains sanitized driver failure at occurrence", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-failure-"));
  try {
    const capture = createQuestionAnswerLearningCapture({ root, mode: "live" });
    const value = ownerChoice(5);
    const operationId = operation(5);
    capture.recordAttempt({ operationId, ...value });
    capture.monitorAck({ operationId, attempt: 1, moment: "before_mutation" });
    capture.monitorAck({ operationId, attempt: 1, moment: "after_readback" });
    capture.recordFailure({
      operationId,
      code: "driver_target_stale",
      retryable: true,
      stage: "driver",
    });
    capture.write();
    const evidence = admitQuestionAnswerLearningEvidence(JSON.parse(
      readFileSync(join(root, "question-answer-learning.json"), "utf8"),
    ));
    assert.equal(evidence.liveAcceptanceEligible, false);
    assert.deepEqual(evidence.questions.map((record) => ({
      verificationResult: record.verificationResult,
      failureCode: record.failureCode,
      retryable: record.retryable,
      terminalDisposition: record.terminalDisposition,
    })), [{
      verificationResult: "driver_failed",
      failureCode: "driver_target_stale",
      retryable: true,
      terminalDisposition: "driver_failed",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("question learning retains bounded retry history without accepting a recovered failure run", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-retry-"));
  try {
    const capture = createQuestionAnswerLearningCapture({ root, mode: "live" });
    const value = ownerChoice(6);
    const first = operation(6);
    capture.recordAttempt({ operationId: first, ...value });
    capture.monitorAck({ operationId: first, attempt: 1, moment: "before_mutation" });
    capture.monitorAck({ operationId: first, attempt: 1, moment: "after_readback" });
    capture.recordFailure({
      operationId: first,
      code: "driver_target_stale",
      retryable: true,
      stage: "driver",
    });
    const second = operation(7);
    capture.recordAttempt({ operationId: second, ...value });
    capture.monitorAck({ operationId: second, attempt: 2, moment: "before_mutation" });
    capture.monitorAck({ operationId: second, attempt: 2, moment: "after_readback" });
    capture.record({ operationId: second, ...value });
    capture.write();
    const evidence = admitQuestionAnswerLearningEvidence(JSON.parse(readFileSync(
      join(root, "question-answer-learning.json"), "utf8",
    )));
    assert.equal(evidence.liveAcceptanceEligible, false);
    assert.deepEqual(evidence.questions[0]?.attemptHistory, [
      {
        ...binding(6),
        outcome: "driver_failed",
        failureCode: "driver_target_stale",
        retryable: true,
      },
      {
        ...binding(7),
        attempt: 2,
        outcome: "verified",
        failureCode: null,
        retryable: false,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("question learning retains verification failure through a terminal retry", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-terminal-retry-"));
  try {
    const capture = createQuestionAnswerLearningCapture({ root, mode: "live" });
    const value = ownerChoice(8);
    for (const [operationId, attempt, retryable] of [
      [operation(8), 1, true],
      [operation(9), 2, false],
    ] as const) {
      capture.recordAttempt({ operationId, ...value });
      capture.monitorAck({ operationId, attempt, moment: "before_mutation" });
      capture.monitorAck({ operationId, attempt, moment: "after_readback" });
      capture.recordFailure({
        operationId,
        code: "verification_mismatch",
        retryable,
        stage: "verification",
      });
    }
    capture.write();
    const evidence = admitQuestionAnswerLearningEvidence(JSON.parse(readFileSync(
      join(root, "question-answer-learning.json"), "utf8",
    )));
    assert.deepEqual(evidence.questions[0]?.attemptHistory.map((attempt) => ({
      outcome: attempt.outcome,
      failureCode: attempt.failureCode,
      retryable: attempt.retryable,
      attempt: attempt.attempt,
    })), [
      { outcome: "verification_failed", failureCode: "verification_mismatch", retryable: true, attempt: 1 },
      { outcome: "verification_failed", failureCode: "verification_mismatch", retryable: false, attempt: 2 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("question learning admits one page monitor batch for independently verified fields", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-question-learning-batch-"));
  try {
    const capture = createQuestionAnswerLearningCapture({ root, mode: "live" });
    const batchOperationId = operation(40);
    capture.monitorBatchAck({
      operationId: batchOperationId,
      attempt: 1,
      moment: "before_mutation",
    });
    for (const index of [41, 42]) {
      const value = ownerChoice(index);
      const fieldOperationId = operation(index);
      capture.recordAttempt({ operationId: fieldOperationId, ...value });
      capture.record({ operationId: fieldOperationId, ...value });
    }
    capture.monitorBatchAck({
      operationId: batchOperationId,
      attempt: 1,
      moment: "after_readback",
    });
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    const evidence = admitQuestionAnswerLearningEvidence(JSON.parse(readFileSync(
      join(root, "question-answer-learning.json"),
      "utf8",
    )));
    assert.equal(evidence.liveAcceptanceEligible, true);
    assert.equal(evidence.questions.length, 2);
    assert.deepEqual(
      evidence.questions.map(({ monitorBinding }) => monitorBinding?.operationId),
      [batchOperationId, batchOperationId],
    );
    assert.deepEqual(
      evidence.questions.map(({ attemptHistory }) => attemptHistory.length),
      [1, 1],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function recordVerified(
  capture: QuestionAnswerLearningCapture,
  value: Omit<Parameters<QuestionAnswerLearningCapture["record"]>[0], "operationId">,
  index: number,
): void {
  const operationId = operation(index);
  capture.recordAttempt({ operationId, ...value });
  capture.monitorAck({ operationId, attempt: 1, moment: "before_mutation" });
  capture.monitorAck({ operationId, attempt: 1, moment: "after_readback" });
  capture.record({ operationId, ...value });
}

function ownerChoice(index: number): Omit<
  Parameters<QuestionAnswerLearningCapture["record"]>[0], "operationId"
> {
  return {
    questionId: questionId(`question-owner-${index}`),
    field: {
      fieldId: fieldId(`field-owner-${index}`),
      target: browserTargetToken(`target-owner-${index}`),
      label: boundedText("Owner answer"),
      required: true,
      behavior: "select",
      options: [
        { id: optionId("owner-yes"), label: boundedText("Yes") },
        { id: optionId("owner-no"), label: boundedText("No") },
      ],
      state: "empty",
    },
    intent: {
      kind: "choice",
      behavior: "select",
      fieldId: fieldId(`field-owner-${index}`),
      target: browserTargetToken(`target-owner-${index}`),
      optionId: optionId("owner-yes"),
      expectedOption: boundedText("Yes"),
      provenance: "owner_provided",
    },
    lane: "live_owner_fact",
    protectedCategory: "legal",
    generatedDefault: false,
  };
}

function operation(index: number): string {
  return `operation_question_${String(index).padStart(16, "0")}`;
}

function binding(index: number): {
  readonly operationId: string;
  readonly attempt: number;
  readonly beforeMutationAck: true;
  readonly afterReadbackAck: true;
} {
  return {
    operationId: operation(index),
    attempt: 1,
    beforeMutationAck: true,
    afterReadbackAck: true,
  };
}
