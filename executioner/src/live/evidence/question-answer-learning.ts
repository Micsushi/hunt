import type {
  AnswerProvenance,
  FieldIntent,
  FieldObservation,
  QuestionId,
} from "../../contracts/index.ts";
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
  | "resume";

export interface QuestionAnswerLearningRecordV1 {
  readonly questionId: string;
  readonly fieldId: string;
  readonly label: string;
  readonly required: boolean;
  readonly uiType: string;
  readonly answerType: string;
  readonly possibleAnswers: readonly string[];
  readonly chosenAnswer: string | boolean | null;
  readonly strategy: QuestionAnswerLearningStrategy;
  readonly provenance: AnswerProvenance;
  readonly replaceWithOwnerAnswer: boolean;
}

export interface QuestionAnswerLearningEvidenceV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-question-answer-learning-v1";
  readonly page: "questionnaire";
  readonly questions: readonly QuestionAnswerLearningRecordV1[];
}

export interface QuestionAnswerLearningCapture {
  record(input: {
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
    readonly intent: FieldIntent;
    readonly protectedCategory: string | null;
    readonly generatedDefault: boolean;
  }): void;
  write(): string | null;
}

export function createQuestionAnswerLearningCapture(input: {
  readonly root: string;
  readonly sensitiveValues?: readonly string[];
}): QuestionAnswerLearningCapture {
  const records = new Map<string, QuestionAnswerLearningRecordV1>();
  let written = false;
  return Object.freeze({
    record(value: {
      readonly questionId: QuestionId;
      readonly field: FieldObservation;
      readonly intent: FieldIntent;
      readonly protectedCategory: string | null;
      readonly generatedDefault: boolean;
    }) {
      records.set(value.field.fieldId, freezeRecord({
        questionId: value.questionId,
        fieldId: value.field.fieldId,
        label: value.field.label,
        required: value.field.required,
        uiType: value.field.behavior,
        answerType: answerType(value.intent),
        possibleAnswers: value.field.options.map(({ label }) => String(label)),
        chosenAnswer: chosenAnswer(value.intent),
        strategy: strategy(value.intent, value.protectedCategory, value.generatedDefault),
        provenance: value.intent.provenance,
        replaceWithOwnerAnswer: value.generatedDefault ||
          value.intent.provenance !== "owner_provided" &&
          value.intent.provenance !== "configured_template",
      }));
    },
    write() {
      if (written || records.size === 0) return null;
      written = true;
      try {
        const evidence = admitQuestionAnswerLearningEvidence({
          schemaVersion: 1,
          evidenceRevision: "s2-question-answer-learning-v1",
          page: "questionnaire",
          questions: [...records.values()],
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
  value: QuestionAnswerLearningEvidenceV1,
): QuestionAnswerLearningEvidenceV1 {
  if (
    !exactKeys(value, ["schemaVersion", "evidenceRevision", "page", "questions"]) ||
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-question-answer-learning-v1" ||
    value.page !== "questionnaire" ||
    value.questions.length < 1 || value.questions.length > 128
  ) denied();
  const fields = new Set<string>();
  for (const record of value.questions) {
    if (
      !exactKeys(record, [
        "questionId", "fieldId", "label", "required", "uiType", "answerType",
        "possibleAnswers", "chosenAnswer", "strategy", "provenance",
        "replaceWithOwnerAnswer",
      ]) ||
      !identifier(record.questionId) || !identifier(record.fieldId) ||
      !bounded(record.label, 512) || fields.has(record.fieldId) ||
      typeof record.required !== "boolean" || !uiTypes.has(record.uiType) ||
      !answerTypes.has(record.answerType) || record.possibleAnswers.length > 128 ||
      record.possibleAnswers.some((answer) => !bounded(answer, 512)) ||
      (typeof record.chosenAnswer !== "string" &&
        typeof record.chosenAnswer !== "boolean" && record.chosenAnswer !== null) ||
      (typeof record.chosenAnswer === "string" && !bounded(record.chosenAnswer, 512)) ||
      !strategies.has(record.strategy) || !provenances.has(record.provenance) ||
      typeof record.replaceWithOwnerAnswer !== "boolean"
    ) denied();
    fields.add(record.fieldId);
  }
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

function chosenAnswer(intent: FieldIntent): string | boolean | null {
  if (intent.provenance === "owner_provided") return "owner_answer_applied";
  if (intent.provenance === "configured_template") return "configured_template_applied";
  if (intent.provenance === "resume_verified") return "resume_artifact_applied";
  if (intent.kind === "choice") return intent.expectedOption;
  if (intent.kind === "toggle") return intent.checked;
  if (intent.kind === "date") {
    return intent.isoDate;
  }
  if (intent.kind === "resume_upload") return "resume_artifact_applied";
  return intent.value;
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

function freezeRecord(value: QuestionAnswerLearningRecordV1): QuestionAnswerLearningRecordV1 {
  return Object.freeze({
    ...value,
    possibleAnswers: Object.freeze([...value.possibleAnswers]),
  });
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
