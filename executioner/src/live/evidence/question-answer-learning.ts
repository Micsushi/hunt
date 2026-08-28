import { createHash } from "node:crypto";

import type {
  AnswerProvenance,
  FieldIntent,
  FieldObservation,
  QuestionId,
} from "../../contracts/index.ts";
import { isSupportedUiBehavior } from "../../deterministic/supported-controls.ts";
import type {
  ApplicationFieldObservation,
  AnswerExecutionMode,
  AnswerProvenanceLane,
} from "../../form/answers/application-types.ts";
import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

const answerTypes = new Set(["text", "boolean", "single_select", "multi_select", "date", "file"]);
const testingQuestionTypes = new Set<TestingQuestionSemanticType>([
  "qualification_requirement", "employee_referral", "prior_employment",
  "sponsorship_requirement", "demographic", "compensation", "authorization",
  "consent", "availability", "identity", "employment", "unknown",
]);
const strategies = new Set([
  "owner_answer", "configured_template", "catalog_default", "privacy_match",
  "first_visible_option", "random_visible_option", "generated_text", "generated_toggle", "generated_date",
  "resume",
  "needs_owner_input",
]);
const provenances = new Set<AnswerProvenance>([
  "owner_provided", "resume_verified", "configured_template", "reviewed_catalog",
  "visible_option",
]);

export type TestingQuestionSemanticType =
  | "qualification_requirement"
  | "employee_referral"
  | "prior_employment"
  | "sponsorship_requirement"
  | "demographic"
  | "compensation"
  | "authorization"
  | "consent"
  | "availability"
  | "identity"
  | "employment"
  | "unknown";

export type QuestionAnswerLearningStrategy =
  | "owner_answer"
  | "configured_template"
  | "catalog_default"
  | "privacy_match"
  | "first_visible_option"
  | "random_visible_option"
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

export type PendingQuestionConstraintsV1 =
  | { readonly displayFormat: "YYYY-MM-DD" }
  | {
      readonly inputType: "text" | "email" | "url" | "number";
      readonly min: number | null;
      readonly max: number | null;
      readonly step: number | null;
      readonly minLength: number | null;
      readonly maxLength: number | null;
      readonly pattern: string | null;
    };

export interface PendingProfileQuestionV1 {
  readonly questionId: string;
  readonly fieldId: string;
  readonly exactQuestion: string;
  readonly required: boolean;
  readonly semanticQuestionType: TestingQuestionSemanticType;
  readonly answerType: string;
  readonly controlType: string;
  readonly options: readonly string[];
  readonly constraints: PendingQuestionConstraintsV1 | null;
  readonly conditionalReveal: boolean;
  readonly testDefault: string | null;
  readonly actualOwnerValue: null;
  readonly needsUserValue: true;
  readonly provenance: AnswerProvenance | null;
  readonly validation:
    | "not_attempted" | "verified" | "driver_failed" | "verification_failed";
  readonly committedReadback: string | null;
}

export interface PendingProfileQuestionsEvidenceV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-pending-profile-questions-v1";
  readonly pendingProfileQuestions: readonly PendingProfileQuestionV1[];
}

export interface QuestionAnswerLearningCapture {
  recordPendingProfile?(input: PendingProfileQuestionV1): void;
  recordAttempt(input: {
    readonly operationId: string;
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
    readonly intent: FieldIntent;
    readonly lane: AnswerProvenanceLane;
    readonly protectedCategory: string | null;
    readonly generatedDefault: boolean;
    readonly conditionalReveal?: boolean;
    readonly semanticQuestionType?: TestingQuestionSemanticType;
    readonly syntheticReplacementReason?:
      | "committed_value_adopted"
      | "cached_option_unavailable";
  }): void;
  recordObserved(input: {
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
    readonly conditionalReveal?: boolean;
    readonly semanticQuestionType?: TestingQuestionSemanticType;
  }): void;
  record(input: {
    readonly operationId: string;
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
    readonly intent: FieldIntent;
    readonly lane: AnswerProvenanceLane;
    readonly protectedCategory: string | null;
    readonly generatedDefault: boolean;
    readonly conditionalReveal?: boolean;
    readonly semanticQuestionType?: TestingQuestionSemanticType;
  }): void;
  recordUnset(input: {
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
    readonly conditionalReveal?: boolean;
    readonly semanticQuestionType?: TestingQuestionSemanticType;
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
  monitorBatchAck(input: {
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
  const intentFingerprints = new Map<string, string>();
  const batchFields = new Set<string>();
  const profilePending = new Map<string, PendingProfileQuestionV1>();
  let pendingBatch: {
    readonly operationId: string;
    readonly attempt: number;
    readonly beforeMutationAck: true;
  } | null = null;
  let written = false;
  return Object.freeze({
    recordPendingProfile(value: PendingProfileQuestionV1) {
      const admitted = admitPendingProfileQuestionsEvidence({
        schemaVersion: 1,
        evidenceRevision: "s2-pending-profile-questions-v1",
        pendingProfileQuestions: [value],
      }).pendingProfileQuestions[0]!;
      if (records.has(admitted.fieldId) || profilePending.has(admitted.fieldId)) denied();
      profilePending.set(admitted.fieldId, admitted);
    },
    recordAttempt(value: Parameters<QuestionAnswerLearningCapture["recordAttempt"]>[0]) {
      if (operations.has(value.operationId)) denied();
      const prior = records.get(value.field.fieldId);
      const record = answerRecord(value, "pending");
      const fingerprint = answerIntentFingerprint(value.intent);
      const retryableFailure = prior !== undefined &&
        prior.interactionState === "attempted" &&
        ["driver_failed", "verification_failed"].includes(prior.terminalDisposition) &&
        retainedOrProvisionalAttempts(prior) > 0;
      const verifiedRemountRestore = prior !== undefined &&
        value.conditionalReveal === true &&
        prior.interactionState === "attempted" &&
        prior.terminalDisposition === "verified" &&
        retainedOrProvisionalAttempts(prior) > 0 &&
        intentFingerprints.get(value.field.fieldId) === fingerprint;
      const observedOnly = prior !== undefined &&
        prior.interactionState === "not_attempted" &&
        prior.terminalDisposition === "needs_owner_input";
      const verifiedSyntheticReplacement = prior !== undefined &&
        value.syntheticReplacementReason !== undefined &&
        prior.interactionState === "attempted" &&
        prior.terminalDisposition === "verified" &&
        prior.lane === "synthetic_test_default" &&
        value.lane === "synthetic_test_default" &&
        prior.provenance !== "owner_provided" &&
        prior.provenance !== "configured_template" &&
        prior.provenance !== "resume_verified" &&
        prior.chosenAnswer !== null &&
        retainedOrProvisionalAttempts(prior) > 0 &&
        !value.field.options.some(({ label }) =>
          normalizeAnswer(label) === normalizeAnswer(prior.chosenAnswer!)
        );
      if (value.syntheticReplacementReason !== undefined && !verifiedSyntheticReplacement) denied();
      if (prior !== undefined && !retryableFailure && !verifiedRemountRestore &&
          !observedOnly && !verifiedSyntheticReplacement) denied();
      if (prior !== undefined) {
        record.attemptHistory = [...prior.attemptHistory];
        record.provisionalAttempts = [...prior.provisionalAttempts];
      }
      records.set(value.field.fieldId, record);
      intentFingerprints.set(value.field.fieldId, fingerprint);
      operations.set(value.operationId, value.field.fieldId);
      if (pendingBatch !== null) batchFields.add(value.field.fieldId);
    },
    recordObserved(value: Parameters<QuestionAnswerLearningCapture["recordObserved"]>[0]) {
      observeQuestion(records, value);
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
      if (record.monitorBinding !== null) retainAttempt(record, value.operationId);
      else if (pendingBatch !== null) retainProvisionalAttempt(record, value.operationId);
    },
    recordUnset(value: Parameters<QuestionAnswerLearningCapture["recordUnset"]>[0]) {
      observeQuestion(records, value);
    },
    recordFailure(value: Parameters<QuestionAnswerLearningCapture["recordFailure"]>[0]) {
      const record = attemptedRecord(records, operations, value.operationId);
      record.verificationResult = value.stage === "driver" ? "driver_failed" : "verification_failed";
      record.failureCode = safeFailureCode(value.code);
      record.retryable = value.retryable;
      record.terminalDisposition = record.verificationResult;
      if (record.monitorBinding !== null) retainAttempt(record, value.operationId);
      else if (pendingBatch !== null) retainProvisionalAttempt(record, value.operationId);
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
      if (record.verificationResult !== "not_attempted" &&
          !record.attemptHistory.some(({ operationId }) => operationId === value.operationId)) {
        retainAttempt(record, value.operationId);
      }
    },
    monitorBatchAck(value: Parameters<QuestionAnswerLearningCapture["monitorBatchAck"]>[0]) {
      if (value.moment === "before_mutation") {
        if (pendingBatch !== null || batchFields.size !== 0) denied();
        pendingBatch = Object.freeze({
          operationId: value.operationId,
          attempt: value.attempt,
          beforeMutationAck: true as const,
        });
        return;
      }
      if (pendingBatch?.operationId !== value.operationId ||
          pendingBatch.attempt !== value.attempt) denied();
      const binding = Object.freeze({
        ...pendingBatch,
        afterReadbackAck: true as const,
      });
      for (const fieldId of batchFields) {
        const record = records.get(fieldId);
        if (record === undefined || record.pendingMonitor !== null ||
            record.monitorBinding !== null ||
            record.verificationResult === "not_attempted") denied();
        record.monitorBinding = binding;
        finalizeProvisionalAttempts(record, binding);
      }
      pendingBatch = null;
      batchFields.clear();
    },
    write() {
      if (written || records.size === 0) return null;
      written = true;
      try {
        const questions = [...records.values()].map(freezeRecord);
        const publicUiStrings = questions.flatMap((question) => [
          question.label,
          ...question.possibleAnswers,
          ...(typeof question.chosenAnswer === "string" &&
              question.provenance !== "owner_provided" &&
              question.provenance !== "configured_template"
            ? [question.chosenAnswer]
            : []),
        ]);
        const pending = admitPendingProfileQuestionsEvidence({
          schemaVersion: 1,
          evidenceRevision: "s2-pending-profile-questions-v1",
          pendingProfileQuestions: [
            ...profilePending.values(),
            ...[...records.values()]
              .filter(needsPendingProfileQuestion)
              .map(pendingProfileQuestion),
          ],
        });
        const sensitiveValues = (input.sensitiveValues ?? []).filter((sensitive) =>
          !publicUiStrings.some((value) => value.includes(sensitive))
        );
        writeAtomicJsonEvidence({
          root: input.root,
          value: pending,
          sensitiveValues,
          reviewedOpaqueIdKeys: [],
          label: "pending profile questions",
          fileName: "pending-profile-questions.json",
        });
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
        return writeAtomicJsonEvidence({
          root: input.root,
          value: evidence,
          sensitiveValues,
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

function observeQuestion(
  records: Map<string, MutableQuestionRecord>,
  value: Parameters<QuestionAnswerLearningCapture["recordObserved"]>[0],
): void {
  const prior = records.get(value.field.fieldId);
  if (prior?.interactionState === "attempted") return;
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
    provisionalAttempts: prior === undefined ? [] : [...prior.provisionalAttempts],
    conditionalReveal: value.conditionalReveal ?? false,
    semanticQuestionType: value.semanticQuestionType ?? "unknown",
    constraints: observedQuestionConstraints(value.field),
  });
}

function normalizeAnswer(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function answerIntentFingerprint(intent: FieldIntent): string {
  const desired = intent.kind === "text"
    ? intent.value
    : intent.kind === "choice"
      ? intent.expectedOption
      : intent.kind === "toggle"
        ? String(intent.checked)
        : intent.kind === "date"
          ? intent.isoDate
          : `${intent.artifact.resumeId}\0${intent.artifact.sha256}`;
  const behavior = intent.kind === "choice" ? "choice" : intent.behavior;
  return createHash("sha256").update(
    `${intent.kind}\0${behavior}\0${intent.provenance}\0${desired}`,
    "utf8",
  ).digest("hex");
}

export function admitPendingProfileQuestionsEvidence(
  value: PendingProfileQuestionsEvidenceV1,
): PendingProfileQuestionsEvidenceV1 {
  if (
    !exactKeys(value, ["schemaVersion", "evidenceRevision", "pendingProfileQuestions"]) ||
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-pending-profile-questions-v1" ||
    !Array.isArray(value.pendingProfileQuestions) ||
    value.pendingProfileQuestions.length > 128
  ) denied();
  const fields = new Set<string>();
  for (const question of value.pendingProfileQuestions) {
    if (
      !exactKeys(question, [
        "questionId", "fieldId", "exactQuestion", "required", "semanticQuestionType",
        "answerType", "controlType", "options", "constraints", "conditionalReveal",
        "testDefault", "actualOwnerValue", "needsUserValue", "provenance", "validation",
        "committedReadback",
      ]) ||
      !identifier(question.questionId) || !identifier(question.fieldId) ||
      fields.has(question.fieldId) || !bounded(question.exactQuestion, 512) ||
      typeof question.required !== "boolean" ||
      !testingQuestionTypes.has(question.semanticQuestionType) ||
      !answerTypes.has(question.answerType) || !isSupportedUiBehavior(question.controlType) ||
      !Array.isArray(question.options) || question.options.length > 128 ||
      question.options.some((option: string) => !bounded(option, 512)) ||
      !validPendingConstraints(question.constraints) ||
      typeof question.conditionalReveal !== "boolean" ||
      !(question.testDefault === null || bounded(question.testDefault, 512)) ||
      question.actualOwnerValue !== null || question.needsUserValue !== true ||
      (question.provenance !== null && !provenances.has(question.provenance)) ||
      !["not_attempted", "verified", "driver_failed", "verification_failed"]
        .includes(question.validation) ||
      !(question.committedReadback === null || bounded(question.committedReadback, 512)) ||
      (question.validation === "verified"
        ? question.testDefault === null || question.committedReadback !== question.testDefault
        : question.committedReadback !== null)
    ) denied();
    fields.add(question.fieldId);
  }
  return Object.freeze({
    ...value,
    pendingProfileQuestions: Object.freeze(value.pendingProfileQuestions.map((question) =>
      Object.freeze({ ...question, options: Object.freeze([...question.options]) })
    )),
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
      typeof record.required !== "boolean" || !isSupportedUiBehavior(record.uiType) ||
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
  const eligible = value.executionMode === "live" &&
    value.questions.every(liveEligibleQuestion);
  if (value.liveAcceptanceEligible !== eligible) denied();
  return Object.freeze({
    ...value,
    questions: Object.freeze(value.questions.map(freezeRecord)),
  });
}

function answerType(intent: FieldIntent, field?: FieldObservation): string {
  if ((field as ApplicationFieldObservation | undefined)?.selectionMode === "multiple") {
    return "multi_select";
  }
  if (intent.kind === "choice") return "single_select";
  if (intent.kind === "toggle") return "boolean";
  if (intent.kind === "date") return "date";
  if (intent.kind === "resume_upload") return "file";
  return "text";
}

function chosenAnswer(intent: FieldIntent, lane: AnswerProvenanceLane): string {
  if (intent.provenance === "owner_provided") return "owner_answer_applied";
  if (intent.provenance === "configured_template") return "configured_template_applied";
  if (intent.provenance === "resume_verified") return "resume_artifact_applied";
  if (lane === "synthetic_test_default") {
    if (intent.kind === "choice") return intent.expectedOption;
    if (intent.kind === "toggle") return intent.checked ? "Yes" : "No";
    if (intent.kind === "date") return intent.isoDate;
    if (intent.kind === "text") return intent.value;
  }
  if (intent.kind === "resume_upload") return "resume_artifact_applied";
  return "synthetic_text_applied";
}

function observedAnswerType(field: FieldObservation): string {
  if ((field as FieldObservation & { readonly selectionMode?: string }).selectionMode === "multiple") {
    return "multi_select";
  }
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
  lane: AnswerProvenanceLane,
  protectedCategory: string | null,
  generatedDefault: boolean,
): QuestionAnswerLearningStrategy {
  if (generatedDefault) {
    if (intent.kind === "toggle") return "generated_toggle";
    if (intent.kind === "date") return "generated_date";
    return intent.kind === "choice" ? "random_visible_option" : "generated_text";
  }
  if (intent.provenance === "owner_provided") return "owner_answer";
  if (intent.provenance === "configured_template") return "configured_template";
  if (intent.provenance === "resume_verified") return "resume";
  if (intent.provenance === "visible_option") {
    return lane === "synthetic_test_default"
      ? "random_visible_option"
      : "first_visible_option";
  }
  if (intent.provenance === "reviewed_catalog") {
    return protectedCategory === "demographic" || protectedCategory === "disclosure"
      ? "privacy_match"
      : "catalog_default";
  }
  return "catalog_default";
}

function freezeRecord(value: QuestionAnswerLearningRecordV2 | MutableQuestionRecord): QuestionAnswerLearningRecordV2 {
  const {
    pendingMonitor: _pendingMonitor,
    provisionalAttempts: _provisionalAttempts,
    conditionalReveal: _conditionalReveal,
    semanticQuestionType: _semanticQuestionType,
    constraints: _constraints,
    ...record
  } = value as MutableQuestionRecord;
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
  provisionalAttempts: ProvisionalQuestionAnswerAttempt[];
  conditionalReveal: boolean;
  semanticQuestionType: TestingQuestionSemanticType;
  constraints: PendingQuestionConstraintsV1 | null;
}

function answerRecord(value: {
  readonly operationId: string;
  readonly questionId: QuestionId;
  readonly field: FieldObservation;
  readonly intent: FieldIntent;
  readonly lane: AnswerProvenanceLane;
  readonly protectedCategory: string | null;
  readonly generatedDefault: boolean;
  readonly conditionalReveal?: boolean;
  readonly semanticQuestionType?: TestingQuestionSemanticType;
}, disposition: "pending"): MutableQuestionRecord {
  return {
    questionId: value.questionId,
    fieldId: value.field.fieldId,
    label: value.field.label,
    required: value.field.required,
    uiType: value.field.behavior,
    answerType: answerType(value.intent, value.field),
    possibleAnswers: value.field.options.map(({ label }) => String(label)),
    answerState: "answered",
    lane: value.lane,
    chosenAnswer: chosenAnswer(value.intent, value.lane),
    strategy: strategy(
      value.intent,
      value.lane,
      value.protectedCategory,
      value.generatedDefault,
    ),
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
    provisionalAttempts: [],
    conditionalReveal: value.conditionalReveal ?? false,
    semanticQuestionType: value.semanticQuestionType ?? "unknown",
    constraints: observedQuestionConstraints(value.field),
  };
}

function needsPendingProfileQuestion(record: MutableQuestionRecord): boolean {
  return record.replaceWithOwnerAnswer && record.provenance !== "resume_verified";
}

function pendingProfileQuestion(record: MutableQuestionRecord): PendingProfileQuestionV1 {
  const testDefault = record.answerState === "answered" ? record.chosenAnswer : null;
  return Object.freeze({
    questionId: record.questionId,
    fieldId: record.fieldId,
    exactQuestion: record.label,
    required: record.required,
    semanticQuestionType: record.semanticQuestionType,
    answerType: record.answerType,
    controlType: record.uiType,
    options: Object.freeze([...record.possibleAnswers]),
    constraints: record.constraints,
    conditionalReveal: record.conditionalReveal,
    testDefault,
    actualOwnerValue: null,
    needsUserValue: true,
    provenance: record.provenance,
    validation: record.verificationResult,
    committedReadback: record.verificationResult === "verified" ? testDefault : null,
  });
}

function observedQuestionConstraints(
  field: FieldObservation,
): PendingQuestionConstraintsV1 | null {
  if (field.behavior === "date") {
    return Object.freeze({ displayFormat: "YYYY-MM-DD" as const });
  }
  const constraints = (field as ApplicationFieldObservation).constraints;
  if (constraints === undefined) return null;
  return Object.freeze({
    inputType: constraints.inputType,
    min: constraints.min,
    max: constraints.max,
    step: constraints.step ?? null,
    minLength: constraints.minLength ?? null,
    maxLength: constraints.maxLength,
    pattern: constraints.pattern,
  });
}

function validPendingConstraints(value: unknown): value is PendingQuestionConstraintsV1 | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === null) return false;
  if (exactKeys(value, ["displayFormat"])) {
    return (value as { readonly displayFormat?: unknown }).displayFormat === "YYYY-MM-DD";
  }
  if (!exactKeys(value, ["inputType", "min", "max", "step", "minLength", "maxLength", "pattern"])) return false;
  const constraints = value as {
    readonly inputType?: unknown;
    readonly min?: unknown;
    readonly max?: unknown;
    readonly step?: unknown;
    readonly minLength?: unknown;
    readonly maxLength?: unknown;
    readonly pattern?: unknown;
  };
  return ["text", "email", "url", "number"].includes(String(constraints.inputType)) &&
    (constraints.min === null || typeof constraints.min === "number" && Number.isFinite(constraints.min)) &&
    (constraints.max === null || typeof constraints.max === "number" && Number.isFinite(constraints.max)) &&
    (constraints.step === null || typeof constraints.step === "number" &&
      Number.isFinite(constraints.step) && constraints.step > 0) &&
    (constraints.minLength === null || typeof constraints.minLength === "number" &&
      Number.isSafeInteger(constraints.minLength) && constraints.minLength >= 0) &&
    (constraints.maxLength === null || typeof constraints.maxLength === "number" &&
      Number.isSafeInteger(constraints.maxLength) && constraints.maxLength >= 0) &&
    (constraints.pattern === null || typeof constraints.pattern === "string" &&
      bounded(constraints.pattern, 512));
}

interface ProvisionalQuestionAnswerAttempt {
  readonly operationId: string;
  readonly outcome: QuestionAnswerAttemptV1["outcome"];
  readonly failureCode: string | null;
  readonly retryable: boolean;
}

function retainedOrProvisionalAttempts(record: MutableQuestionRecord): number {
  return record.attemptHistory.length + record.provisionalAttempts.length;
}

function retainProvisionalAttempt(record: MutableQuestionRecord, operationId: string): void {
  if (record.verificationResult === "not_attempted" ||
      record.provisionalAttempts.some((attempt) => attempt.operationId === operationId) ||
      retainedOrProvisionalAttempts(record) >= 256) denied();
  record.provisionalAttempts.push(Object.freeze({
    operationId,
    outcome: record.verificationResult,
    failureCode: record.failureCode,
    retryable: record.retryable,
  }));
}

function finalizeProvisionalAttempts(
  record: MutableQuestionRecord,
  binding: NonNullable<QuestionAnswerLearningRecordV2["monitorBinding"]>,
): void {
  if (record.provisionalAttempts.length === 0) denied();
  for (const attempt of record.provisionalAttempts) {
    if (record.attemptHistory.some(({ operationId }) => operationId === attempt.operationId)) denied();
    record.attemptHistory.push(Object.freeze({
      operationId: attempt.operationId,
      attempt: binding.attempt,
      beforeMutationAck: true,
      afterReadbackAck: true,
      outcome: attempt.outcome,
      failureCode: attempt.failureCode,
      retryable: attempt.retryable,
    }));
  }
  record.provisionalAttempts = [];
}

function retainAttempt(record: MutableQuestionRecord, operationId: string): void {
  const binding = record.monitorBinding;
  if (binding === null || record.verificationResult === "not_attempted") denied();
  if (record.attemptHistory.some((attempt) => attempt.operationId === operationId)) denied();
  if (record.attemptHistory.length >= 256) denied();
  record.attemptHistory.push(Object.freeze({
    operationId,
    attempt: binding.attempt,
    beforeMutationAck: true,
    afterReadbackAck: true,
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
