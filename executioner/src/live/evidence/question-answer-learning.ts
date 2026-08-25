import type {
  AnswerProvenance,
  FieldIntent,
  FieldObservation,
  QuestionId,
} from "../../contracts/index.ts";
import type {
  AnswerExecutionMode,
  AnswerProvenanceLane,
} from "../../form/answers/application-types.ts";
import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

const uiTypes = new Set([
  "text", "textarea", "radio", "checkbox", "select", "listbox", "date",
  "file_upload",
]);
const answerTypes = new Set(["text", "boolean", "single_select", "date", "file"]);
const strategies = new Set([
  "owner_answer", "configured_template", "catalog_default", "privacy_match",
  "first_visible_option", "generated_text", "generated_toggle", "generated_date",
  "resume",
  "needs_owner_input",
]);
const provenances = new Set<AnswerProvenance>([
  "owner_provided", "resume_verified", "configured_template", "reviewed_catalog",
  "visible_option",
]);

export type QuestionAnswerLearningStrategy =
  | "owner_answer"
  | "configured_template"
  | "catalog_default"
  | "privacy_match"
  | "first_visible_option"
  | "generated_text"
  | "generated_toggle"
  | "generated_date"
  | "resume"
  | "needs_owner_input";

export interface QuestionAnswerLearningRecordV2 {
  readonly questionId: string;
  readonly fieldId: string;
  readonly label: string;
  readonly required: boolean;
  readonly uiType: string;
  readonly answerType: string;
  readonly possibleAnswers: readonly string[];
  readonly answerState: "answered" | "unset";
  readonly lane: AnswerProvenanceLane | null;
  readonly chosenAnswer: string | null;
  readonly strategy: QuestionAnswerLearningStrategy;
  readonly provenance: AnswerProvenance | null;
  readonly replaceWithOwnerAnswer: boolean;
  readonly interactionState: "not_attempted" | "attempted";
  readonly monitorBinding: {
    readonly operationId: string;
    readonly attempt: number;
    readonly beforeMutationAck: true;
    readonly afterReadbackAck: true;
  } | null;
  readonly verificationResult:
    | "not_attempted" | "verified" | "driver_failed" | "verification_failed";
  readonly failureCode: string | null;
  readonly retryable: boolean;
  readonly terminalDisposition:
    | "pending" | "verified" | "needs_owner_input"
    | "driver_failed" | "verification_failed";
  readonly attemptHistory: readonly QuestionAnswerAttemptV1[];
}

export interface QuestionAnswerAttemptV1 {
  readonly operationId: string;
  readonly attempt: number;
  readonly beforeMutationAck: true;
  readonly afterReadbackAck: true;
  readonly outcome: "verified" | "driver_failed" | "verification_failed";
  readonly failureCode: string | null;
  readonly retryable: boolean;
}

export interface QuestionAnswerLearningEvidenceV2 {
  readonly schemaVersion: 4;
  readonly evidenceRevision: "s2-question-answer-learning-v4";
  readonly page: "questionnaire";
  readonly executionMode: AnswerExecutionMode;
  readonly testOnly: boolean;
  readonly liveAcceptanceEligible: boolean;
  readonly questions: readonly QuestionAnswerLearningRecordV2[];
}

export interface QuestionAnswerLearningCapture {
  recordAttempt(input: {
    readonly operationId: string;
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
    readonly intent: FieldIntent;
    readonly lane: AnswerProvenanceLane;
    readonly protectedCategory: string | null;
    readonly generatedDefault: boolean;
  }): void;
  record(input: {
    readonly operationId: string;
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
    readonly intent: FieldIntent;
    readonly lane: AnswerProvenanceLane;
    readonly protectedCategory: string | null;
    readonly generatedDefault: boolean;
  }): void;
  recordUnset(input: {
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
  }): void;
  recordFailure(input: {
    readonly operationId: string;
    readonly code: string;
    readonly retryable: boolean;
    readonly stage: "driver" | "verification";
  }): void;
  monitorAck(input: {
    readonly operationId: string;
    readonly attempt: number;
    readonly moment: "before_mutation" | "after_readback";
  }): void;
  write(): string | null;
}

export function createQuestionAnswerLearningCapture(input: {
  readonly root: string;
  readonly mode: AnswerExecutionMode;
  readonly sensitiveValues?: readonly string[];
}): QuestionAnswerLearningCapture {
  const records = new Map<string, MutableQuestionRecord>();
  const operations = new Map<string, string>();
  let written = false;
  return Object.freeze({
    recordAttempt(value: Parameters<QuestionAnswerLearningCapture["recordAttempt"]>[0]) {
      if (operations.has(value.operationId)) denied();
      const prior = records.get(value.field.fieldId);
      if (prior !== undefined && (
        prior.interactionState !== "attempted" ||
        !["driver_failed", "verification_failed"].includes(prior.terminalDisposition) ||
        prior.attemptHistory.length === 0
      )) denied();
      const record = answerRecord(value, "pending");
      if (prior !== undefined) record.attemptHistory = [...prior.attemptHistory];
      records.set(value.field.fieldId, record);
      operations.set(value.operationId, value.field.fieldId);
    },
    record(value: {
      readonly operationId: string;
      readonly questionId: QuestionId;
      readonly field: FieldObservation;
      readonly intent: FieldIntent;
      readonly lane: AnswerProvenanceLane;
      readonly protectedCategory: string | null;
      readonly generatedDefault: boolean;
    }) {
      const record = attemptedRecord(records, operations, value.operationId);
      record.verificationResult = "verified";
      record.failureCode = null;
      record.retryable = false;
      record.terminalDisposition = "verified";
      retainAttempt(record);
    },
    recordUnset(value: { readonly questionId: QuestionId; readonly field: FieldObservation }) {
      const prior = records.get(value.field.fieldId);
      records.set(value.field.fieldId, {
        questionId: value.questionId,
        fieldId: value.field.fieldId,
        label: value.field.label,
        required: value.field.required,
        uiType: value.field.behavior,
        answerType: observedAnswerType(value.field),
        possibleAnswers: value.field.options.map(({ label }) => String(label)),
        answerState: "unset",
        lane: null,
        chosenAnswer: null,
        strategy: "needs_owner_input",
        provenance: null,
        replaceWithOwnerAnswer: true,
        interactionState: "not_attempted",
        monitorBinding: null,
        pendingMonitor: null,
        verificationResult: "not_attempted",
        failureCode: null,
        retryable: false,
        terminalDisposition: "needs_owner_input",
        attemptHistory: prior === undefined ? [] : [...prior.attemptHistory],
      });
    },
    recordFailure(value: Parameters<QuestionAnswerLearningCapture["recordFailure"]>[0]) {
      const record = attemptedRecord(records, operations, value.operationId);
      record.verificationResult = value.stage === "driver" ? "driver_failed" : "verification_failed";
      record.failureCode = safeFailureCode(value.code);
      record.retryable = value.retryable;
      record.terminalDisposition = record.verificationResult;
      retainAttempt(record);
    },
    monitorAck(value: Parameters<QuestionAnswerLearningCapture["monitorAck"]>[0]) {
      const record = attemptedRecord(records, operations, value.operationId);
      if (value.moment === "before_mutation") {
        if (record.pendingMonitor !== null || record.monitorBinding !== null) denied();
        record.pendingMonitor = {
          operationId: value.operationId,
          attempt: value.attempt,
          beforeMutationAck: true,
        };
        return;
      }
      const pendingMonitor = record.pendingMonitor;
      if (pendingMonitor?.operationId !== value.operationId ||
          pendingMonitor.attempt !== value.attempt) denied();
      record.monitorBinding = Object.freeze({
        ...pendingMonitor,
        afterReadbackAck: true,
      });
      record.pendingMonitor = null;
    },
    write() {
      if (written || records.size === 0) return null;
      written = true;
      try {
        const questions = [...records.values()].map(freezeRecord);
        const evidence = admitQuestionAnswerLearningEvidence({
          schemaVersion: 4,
          evidenceRevision: "s2-question-answer-learning-v4",
          page: "questionnaire",
          executionMode: input.mode,
          testOnly: input.mode === "synthetic_test_non_submittable",
          liveAcceptanceEligible: input.mode === "live" &&
            questions.every(liveEligibleQuestion),
          questions,
        });
        const publicUiStrings = evidence.questions.flatMap((question) => [
          question.label,
          ...question.possibleAnswers,
          ...(typeof question.chosenAnswer === "string" &&
              question.provenance !== "owner_provided" &&
              question.provenance !== "configured_template"
            ? [question.chosenAnswer]
            : []),
        ]);
        return writeAtomicJsonEvidence({
          root: input.root,
          value: evidence,
          sensitiveValues: (input.sensitiveValues ?? []).filter((sensitive) =>
            !publicUiStrings.some((value) => value.includes(sensitive))
          ),
          reviewedOpaqueIdKeys: ["operationId"],
          label: "question answer learning",
          fileName: "question-answer-learning.json",
        });
      } catch (error) {
        process.stderr.write(`${JSON.stringify({
          questionAnswerLearningWriteFailed: error instanceof Error ? error.message : "unknown",
        })}\n`);
        return null;
      }
    },
  });
}

export function admitQuestionAnswerLearningEvidence(
  value: QuestionAnswerLearningEvidenceV2,
): QuestionAnswerLearningEvidenceV2 {
  if (
    !exactKeys(value, [
      "schemaVersion", "evidenceRevision", "page", "executionMode", "testOnly",
      "liveAcceptanceEligible", "questions",
    ]) ||
    value.schemaVersion !== 4 ||
    value.evidenceRevision !== "s2-question-answer-learning-v4" ||
    value.page !== "questionnaire" ||
    !validMode(value.executionMode, value.testOnly, value.liveAcceptanceEligible) ||
    value.questions.length < 1 || value.questions.length > 128
  ) denied();
  const fields = new Set<string>();
  for (const record of value.questions) {
    if (
      !exactKeys(record, [
        "questionId", "fieldId", "label", "required", "uiType", "answerType",
        "possibleAnswers", "answerState", "lane", "chosenAnswer", "strategy", "provenance",
        "replaceWithOwnerAnswer", "interactionState", "monitorBinding",
        "verificationResult", "failureCode", "retryable", "terminalDisposition",
        "attemptHistory",
      ]) ||
      !identifier(record.questionId) || !identifier(record.fieldId) ||
      !bounded(record.label, 512) || fields.has(record.fieldId) ||
      typeof record.required !== "boolean" || !uiTypes.has(record.uiType) ||
      !answerTypes.has(record.answerType) || record.possibleAnswers.length > 128 ||
      record.possibleAnswers.some((answer) => !bounded(answer, 512)) ||
      !["answered", "unset"].includes(record.answerState) ||
      (record.lane !== null && !["live_owner_fact", "synthetic_test_default"].includes(record.lane)) ||
      (record.answerState === "answered" && record.lane === null) ||
      (record.answerState === "unset" && record.lane !== null) ||
      (record.answerState === "answered" && record.provenance === null) ||
      (record.answerState === "unset" && record.provenance !== null) ||
      (record.answerState === "unset" &&
        (record.chosenAnswer !== null || record.strategy !== "needs_owner_input")) ||
      (record.lane === "synthetic_test_default" && value.executionMode !== "synthetic_test_non_submittable") ||
      (record.lane === "live_owner_fact" &&
        record.provenance !== "owner_provided" &&
        record.provenance !== "resume_verified" &&
        record.provenance !== "configured_template") ||
      (typeof record.chosenAnswer !== "string" && record.chosenAnswer !== null) ||
      (typeof record.chosenAnswer === "string" && !bounded(record.chosenAnswer, 512)) ||
      !strategies.has(record.strategy) ||
      (record.provenance !== null && !provenances.has(record.provenance)) ||
      typeof record.replaceWithOwnerAnswer !== "boolean" ||
      !validAttemptOutcome(record) || !validAttemptHistory(record)
    ) denied();
    fields.add(record.fieldId);
  }
  const operations = value.questions.flatMap(({ attemptHistory }) =>
    attemptHistory.map(({ operationId }) => operationId)
  );
  if (new Set(operations).size !== operations.length) denied();
  const eligible = value.executionMode === "live" &&
    value.questions.every(liveEligibleQuestion);
  if (value.liveAcceptanceEligible !== eligible) denied();
  return Object.freeze({
    ...value,
    questions: Object.freeze(value.questions.map(freezeRecord)),
  });
}

function answerType(intent: FieldIntent): string {
  if (intent.kind === "choice") return "single_select";
  if (intent.kind === "toggle") return "boolean";
  if (intent.kind === "date") return "date";
  if (intent.kind === "resume_upload") return "file";
  return "text";
}

function chosenAnswer(intent: FieldIntent): string {
  if (intent.provenance === "owner_provided") return "owner_answer_applied";
  if (intent.provenance === "configured_template") return "configured_template_applied";
  if (intent.provenance === "resume_verified") return "resume_artifact_applied";
  if (intent.kind === "choice") return "synthetic_choice_applied";
  if (intent.kind === "toggle") return "synthetic_toggle_applied";
  if (intent.kind === "date") return "synthetic_date_applied";
  if (intent.kind === "resume_upload") return "resume_artifact_applied";
  return "synthetic_text_applied";
}

function observedAnswerType(field: FieldObservation): string {
  if (field.behavior === "radio" || field.behavior === "select" || field.behavior === "listbox") {
    return "single_select";
  }
  if (field.behavior === "checkbox") return "boolean";
  if (field.behavior === "date") return "date";
  if (field.behavior === "file_upload") return "file";
  return "text";
}

function strategy(
  intent: FieldIntent,
  protectedCategory: string | null,
  generatedDefault: boolean,
): QuestionAnswerLearningStrategy {
  if (generatedDefault) {
    if (intent.kind === "toggle") return "generated_toggle";
    if (intent.kind === "date") return "generated_date";
    return intent.kind === "choice" ? "first_visible_option" : "generated_text";
  }
  if (intent.provenance === "owner_provided") return "owner_answer";
  if (intent.provenance === "configured_template") return "configured_template";
  if (intent.provenance === "resume_verified") return "resume";
  if (intent.provenance === "visible_option") return "first_visible_option";
  if (intent.provenance === "reviewed_catalog") {
    return protectedCategory === "demographic" || protectedCategory === "disclosure"
      ? "privacy_match"
      : "catalog_default";
  }
  return "catalog_default";
}

function freezeRecord(value: QuestionAnswerLearningRecordV2 | MutableQuestionRecord): QuestionAnswerLearningRecordV2 {
  const { pendingMonitor: _pendingMonitor, ...record } = value as MutableQuestionRecord;
  return Object.freeze({
    ...record,
    possibleAnswers: Object.freeze([...record.possibleAnswers]),
    monitorBinding: record.monitorBinding === null
      ? null
      : Object.freeze({ ...record.monitorBinding }),
    attemptHistory: Object.freeze(record.attemptHistory.map((attempt) =>
      Object.freeze({ ...attempt })
    )),
  });
}

function liveEligibleQuestion(record: QuestionAnswerLearningRecordV2): boolean {
  return record.answerState === "answered" && record.lane === "live_owner_fact" &&
    record.verificationResult === "verified" &&
    record.terminalDisposition === "verified" && record.monitorBinding !== null &&
    record.attemptHistory.length === 1 &&
    record.attemptHistory[0]?.outcome === "verified";
}

interface MutableQuestionRecord extends Omit<{
  -readonly [Key in keyof QuestionAnswerLearningRecordV2]: QuestionAnswerLearningRecordV2[Key]
}, "monitorBinding" | "attemptHistory"> {
  monitorBinding: QuestionAnswerLearningRecordV2["monitorBinding"];
  pendingMonitor: {
    operationId: string;
    attempt: number;
    beforeMutationAck: true;
  } | null;
  attemptHistory: QuestionAnswerAttemptV1[];
}

function answerRecord(value: {
  readonly operationId: string;
  readonly questionId: QuestionId;
  readonly field: FieldObservation;
  readonly intent: FieldIntent;
  readonly lane: AnswerProvenanceLane;
  readonly protectedCategory: string | null;
  readonly generatedDefault: boolean;
}, disposition: "pending"): MutableQuestionRecord {
  return {
    questionId: value.questionId,
    fieldId: value.field.fieldId,
    label: value.field.label,
    required: value.field.required,
    uiType: value.field.behavior,
    answerType: answerType(value.intent),
    possibleAnswers: value.field.options.map(({ label }) => String(label)),
    answerState: "answered",
    lane: value.lane,
    chosenAnswer: chosenAnswer(value.intent),
    strategy: strategy(value.intent, value.protectedCategory, value.generatedDefault),
    provenance: value.intent.provenance,
    replaceWithOwnerAnswer: value.generatedDefault ||
      value.intent.provenance !== "owner_provided" &&
      value.intent.provenance !== "configured_template",
    interactionState: "attempted",
    monitorBinding: null,
    pendingMonitor: null,
    verificationResult: "not_attempted",
    failureCode: null,
    retryable: false,
    terminalDisposition: disposition,
    attemptHistory: [],
  };
}

function retainAttempt(record: MutableQuestionRecord): void {
  const binding = record.monitorBinding;
  if (binding === null || record.verificationResult === "not_attempted") denied();
  if (record.attemptHistory.some(({ operationId }) => operationId === binding.operationId)) denied();
  if (record.attemptHistory.length >= 256) denied();
  record.attemptHistory.push(Object.freeze({
    ...binding,
    outcome: record.verificationResult,
    failureCode: record.failureCode,
    retryable: record.retryable,
  }));
}

function attemptedRecord(
  records: Map<string, MutableQuestionRecord>,
  operations: Map<string, string>,
  operationId: string,
): MutableQuestionRecord {
  const fieldId = operations.get(operationId);
  const record = fieldId === undefined ? undefined : records.get(fieldId);
  if (record === undefined) return denied();
  return record;
}

function validAttemptOutcome(record: QuestionAnswerLearningRecordV2): boolean {
  const noAttempt = record.interactionState === "not_attempted";
  if (noAttempt) {
    return record.answerState === "unset" && record.monitorBinding === null &&
      record.verificationResult === "not_attempted" && record.failureCode === null &&
      record.retryable === false && record.terminalDisposition === "needs_owner_input";
  }
  if (record.interactionState !== "attempted" || record.monitorBinding === null ||
      !validMonitorBinding(record.monitorBinding) || record.answerState !== "answered") return false;
  if (record.verificationResult === "verified") {
    return record.failureCode === null && record.retryable === false &&
      record.terminalDisposition === "verified";
  }
  if (record.verificationResult === "driver_failed" ||
      record.verificationResult === "verification_failed") {
    return validFailureCode(record.failureCode) &&
      record.terminalDisposition === record.verificationResult;
  }
  return false;
}

function validAttemptHistory(record: QuestionAnswerLearningRecordV2): boolean {
  if (!Array.isArray(record.attemptHistory) || record.attemptHistory.length > 256) return false;
  const operations = new Set<string>();
  for (const attempt of record.attemptHistory) {
    if (!exactKeys(attempt, [
      "operationId", "attempt", "beforeMutationAck", "afterReadbackAck",
      "outcome", "failureCode", "retryable",
    ]) || !/^operation_[A-Za-z0-9_-]{16,64}$/u.test(attempt.operationId) ||
        !Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1 || attempt.attempt > 256 ||
        attempt.beforeMutationAck !== true || attempt.afterReadbackAck !== true ||
        operations.has(attempt.operationId) ||
        !["verified", "driver_failed", "verification_failed"].includes(attempt.outcome) ||
        typeof attempt.retryable !== "boolean" ||
        (attempt.outcome === "verified"
          ? attempt.failureCode !== null || attempt.retryable
          : !validFailureCode(attempt.failureCode))) return false;
    operations.add(attempt.operationId);
  }
  if (record.interactionState === "not_attempted") return true;
  const latest = record.attemptHistory.at(-1);
  return latest !== undefined && record.monitorBinding !== null &&
    latest.operationId === record.monitorBinding.operationId &&
    latest.attempt === record.monitorBinding.attempt &&
    latest.outcome === record.verificationResult &&
    latest.failureCode === record.failureCode && latest.retryable === record.retryable;
}

function validMonitorBinding(value: NonNullable<QuestionAnswerLearningRecordV2["monitorBinding"]>): boolean {
  return exactKeys(value, [
    "operationId", "attempt", "beforeMutationAck", "afterReadbackAck",
  ]) && /^operation_[A-Za-z0-9_-]{16,64}$/u.test(value.operationId) &&
    Number.isSafeInteger(value.attempt) && value.attempt >= 1 && value.attempt <= 256 &&
    value.beforeMutationAck === true && value.afterReadbackAck === true;
}

function safeFailureCode(value: string): string {
  if (!validFailureCode(value)) return denied();
  return value;
}

function validFailureCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value);
}

function validMode(mode: string, testOnly: boolean, liveAcceptanceEligible: boolean): boolean {
  return mode === "live"
    ? testOnly === false
    : mode === "synthetic_test_non_submittable" &&
      testOnly === true && liveAcceptanceEligible === false;
}

function bounded(value: string, maximum: number): boolean {
  const length = [...value].length;
  return length > 0 && length <= maximum;
}

function identifier(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key, index) => keys[index] === key);
}

function denied(): never {
  throw new TypeError("question answer learning evidence denied");
}
