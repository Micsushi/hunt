import { findArtifactPrivacyViolations } from "../../corpus/audit/privacy.ts";
import { retainedIntakeControlGuide } from "../../form/questions/catalog.ts";
import { writeAtomicJsonEvidence } from "../../live/evidence/private/atomic-json-evidence.ts";

const pages = new Set(["voluntary_disclosures", "self_identify", "resume"]);
const uiTypes = new Set([
  "text", "date", "radio", "select", "checkbox", "repeatable", "search_select",
  "file_upload",
]);
const answerTypes = new Set([
  "text", "date", "single_select", "boolean", "repeatable", "multi_select", "file",
]);
const readbacks = new Set([
  "value_committed", "option_selected", "checked", "row_added", "file_verified", "unset",
]);

export interface RetainedFixtureControlMetadata {
  readonly controlId: string;
  readonly identity: string | "unresolved";
  readonly label: string | null;
  readonly questionType: string;
  readonly uiType: string;
  readonly answerType: string;
  readonly uiVariant: string;
  readonly required: boolean | null;
  readonly allowedOptions: readonly string[] | null;
}

export interface RetainedFixtureControlRecordV1 extends RetainedFixtureControlMetadata {
  readonly lane: "synthetic_test_default" | null;
  readonly interaction: string | null;
  readonly immediateReadback:
    | "value_committed" | "option_selected" | "checked" | "row_added"
    | "file_verified" | "unset";
  readonly validation: "pass" | "not_attempted";
  readonly monitorBinding: {
    readonly operationId: string;
    readonly attempt: number;
    readonly beforeMutationAck: true;
    readonly afterReadbackAck: true;
  } | null;
  readonly observationBinding: {
    readonly operationId: string;
    readonly attempt: number;
    readonly stateObservedAck: true;
  } | null;
  readonly transition: "fixture_retained";
  readonly terminalDisposition: "verified" | "needs_owner_input";
}

export interface RetainedFixtureControlEvidenceV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-retained-fixture-control-learning-v1";
  readonly executionMode: "synthetic_test_non_submittable";
  readonly testOnly: true;
  readonly liveAcceptanceEligible: false;
  readonly page: "voluntary_disclosures" | "self_identify" | "resume";
  readonly submitPresent: false;
  readonly submitActivated: false;
  readonly reviewExpectationEligible: false;
  readonly reviewCompletionEligible: false;
  readonly privacyScan: "pass";
  readonly controls: readonly RetainedFixtureControlRecordV1[];
}

export interface RetainedFixtureControlCapture {
  recordAttempt(input: {
    readonly metadata: RetainedFixtureControlMetadata;
    readonly operationId: string;
    readonly attempt: number;
    readonly interaction: string;
  }): void;
  monitorAck(input: {
    readonly controlId: string;
    readonly operationId: string;
    readonly attempt: number;
    readonly moment: "before_mutation" | "after_readback";
  }): void;
  recordVerified(input: {
    readonly controlId: string;
    readonly operationId: string;
    readonly readback: Exclude<RetainedFixtureControlRecordV1["immediateReadback"], "unset">;
  }): void;
  recordObserved(input: {
    readonly metadata: RetainedFixtureControlMetadata;
    readonly operationId: string;
    readonly attempt: number;
  }): void;
  write(input: { readonly submitPresent: boolean; readonly submitActivated: boolean }): string;
}

interface PendingAttempt {
  readonly metadata: RetainedFixtureControlMetadata;
  readonly operationId: string;
  readonly attempt: number;
  readonly interaction: string;
  beforeMutationAck: boolean;
  afterReadbackAck: boolean;
}

export function createRetainedFixtureControlCapture(input: {
  readonly root: string;
  readonly page: RetainedFixtureControlEvidenceV1["page"];
  readonly sensitiveValues?: readonly string[];
}): RetainedFixtureControlCapture {
  if (!pages.has(input.page)) denied();
  const pending = new Map<string, PendingAttempt>();
  const records = new Map<string, RetainedFixtureControlRecordV1>();
  const operations = new Set<string>();
  let written = false;
  return Object.freeze({
    recordAttempt(value: Parameters<RetainedFixtureControlCapture["recordAttempt"]>[0]) {
      admitMetadata(value.metadata, input.page);
      if (records.has(value.metadata.controlId) || pending.has(value.metadata.controlId) ||
          operations.has(value.operationId) || !operationId(value.operationId) ||
          !positiveInteger(value.attempt) || !bounded(value.interaction, 128)) denied();
      operations.add(value.operationId);
      pending.set(value.metadata.controlId, {
        ...value,
        beforeMutationAck: false,
        afterReadbackAck: false,
      });
    },
    monitorAck(value: Parameters<RetainedFixtureControlCapture["monitorAck"]>[0]) {
      const attempt = pending.get(value.controlId);
      if (attempt === undefined || attempt.operationId !== value.operationId ||
          attempt.attempt !== value.attempt) denied();
      if (value.moment === "before_mutation") {
        if (attempt.beforeMutationAck || attempt.afterReadbackAck) denied();
        attempt.beforeMutationAck = true;
      } else {
        if (!attempt.beforeMutationAck || attempt.afterReadbackAck) denied();
        attempt.afterReadbackAck = true;
      }
    },
    recordVerified(value: Parameters<RetainedFixtureControlCapture["recordVerified"]>[0]) {
      const attempt = pending.get(value.controlId);
      if (attempt === undefined || attempt.operationId !== value.operationId ||
          !attempt.beforeMutationAck || !attempt.afterReadbackAck ||
          !readbacks.has(value.readback)) denied();
      records.set(value.controlId, Object.freeze({
        ...freezeMetadata(attempt.metadata),
        lane: "synthetic_test_default",
        interaction: attempt.interaction,
        immediateReadback: value.readback,
        validation: "pass",
        monitorBinding: Object.freeze({
          operationId: attempt.operationId,
          attempt: attempt.attempt,
          beforeMutationAck: true,
          afterReadbackAck: true,
        }),
        observationBinding: null,
        transition: "fixture_retained",
        terminalDisposition: "verified",
      }));
      pending.delete(value.controlId);
    },
    recordObserved(value: Parameters<RetainedFixtureControlCapture["recordObserved"]>[0]) {
      admitMetadata(value.metadata, input.page);
      if (value.metadata.identity !== "unresolved" || value.metadata.label !== null ||
          records.has(value.metadata.controlId) || pending.has(value.metadata.controlId) ||
          operations.has(value.operationId) || !operationId(value.operationId) ||
          !positiveInteger(value.attempt)) denied();
      operations.add(value.operationId);
      records.set(value.metadata.controlId, Object.freeze({
        ...freezeMetadata(value.metadata),
        lane: null,
        interaction: null,
        immediateReadback: "unset",
        validation: "not_attempted",
        monitorBinding: null,
        observationBinding: Object.freeze({
          operationId: value.operationId,
          attempt: value.attempt,
          stateObservedAck: true,
        }),
        transition: "fixture_retained",
        terminalDisposition: "needs_owner_input",
      }));
    },
    write(value: { readonly submitPresent: boolean; readonly submitActivated: boolean }) {
      if (written || pending.size !== 0 || records.size === 0 ||
          value.submitPresent || value.submitActivated) denied();
      written = true;
      const structural = {
        schemaVersion: 1 as const,
        evidenceRevision: "s2-retained-fixture-control-learning-v1" as const,
        executionMode: "synthetic_test_non_submittable" as const,
        testOnly: true as const,
        liveAcceptanceEligible: false as const,
        page: input.page,
        submitPresent: false as const,
        submitActivated: false as const,
        reviewExpectationEligible: false as const,
        reviewCompletionEligible: false as const,
        privacyScan: "pass" as const,
        controls: Object.freeze([...records.values()]),
      };
      if (findArtifactPrivacyViolations(structural).length !== 0) denied();
      const evidence = admitRetainedFixtureControlEvidence(structural);
      return writeAtomicJsonEvidence({
        root: input.root,
        value: evidence,
        sensitiveValues: input.sensitiveValues ?? [],
        reviewedStructuralValues: evidence.controls.flatMap((control) => [
          ...(control.label === null ? [] : [control.label]),
          ...(control.allowedOptions ?? []),
        ]),
        label: "retained fixture control learning",
        fileName: "retained-fixture-control-learning.json",
      });
    },
  });
}

export function admitRetainedFixtureControlEvidence(
  value: RetainedFixtureControlEvidenceV1,
): RetainedFixtureControlEvidenceV1 {
  if (!exactKeys(value, [
    "schemaVersion", "evidenceRevision", "executionMode", "testOnly",
    "liveAcceptanceEligible", "page", "submitPresent", "submitActivated",
    "reviewExpectationEligible", "reviewCompletionEligible", "privacyScan", "controls",
  ]) || value.schemaVersion !== 1 ||
      value.evidenceRevision !== "s2-retained-fixture-control-learning-v1" ||
      value.executionMode !== "synthetic_test_non_submittable" || value.testOnly !== true ||
      value.liveAcceptanceEligible !== false || !pages.has(value.page) ||
      value.submitPresent !== false || value.submitActivated !== false ||
      value.reviewExpectationEligible !== false || value.reviewCompletionEligible !== false ||
      value.privacyScan !== "pass" || value.controls.length < 1 || value.controls.length > 64) denied();
  const controls = new Set<string>();
  const operations = new Set<string>();
  for (const control of value.controls) {
    admitRecord(control, value.page);
    if (controls.has(control.controlId)) denied();
    controls.add(control.controlId);
    const binding = control.monitorBinding ?? control.observationBinding;
    if (binding === null || operations.has(binding.operationId)) denied();
    operations.add(binding.operationId);
  }
  return Object.freeze({
    ...value,
    controls: Object.freeze(value.controls.map((control) => Object.freeze({
      ...control,
      allowedOptions: control.allowedOptions === null
        ? null
        : Object.freeze([...control.allowedOptions]),
      monitorBinding: control.monitorBinding === null ? null : Object.freeze(control.monitorBinding),
      observationBinding: control.observationBinding === null
        ? null
        : Object.freeze(control.observationBinding),
    }))),
  });
}

function admitRecord(
  value: RetainedFixtureControlRecordV1,
  page: RetainedFixtureControlEvidenceV1["page"],
): void {
  if (!exactKeys(value, [
    "controlId", "identity", "label", "questionType", "uiType", "answerType",
    "uiVariant", "required", "allowedOptions", "lane", "interaction",
    "immediateReadback", "validation", "monitorBinding", "observationBinding",
    "transition", "terminalDisposition",
  ])) denied();
  admitMetadata(metadataFrom(value), page);
  const attempted = value.terminalDisposition === "verified";
  if (!readbacks.has(value.immediateReadback) || value.transition !== "fixture_retained" ||
      (attempted && (value.lane !== "synthetic_test_default" ||
        !bounded(value.interaction, 128) || value.immediateReadback === "unset" ||
        value.validation !== "pass" || !monitorBinding(value.monitorBinding) ||
        value.observationBinding !== null)) ||
      (!attempted && (value.terminalDisposition !== "needs_owner_input" || value.lane !== null ||
        value.interaction !== null || value.immediateReadback !== "unset" ||
        value.validation !== "not_attempted" || value.monitorBinding !== null ||
        !observationBinding(value.observationBinding) || value.identity !== "unresolved" ||
        value.label !== null))) denied();
}

function admitMetadata(
  value: RetainedFixtureControlMetadata,
  page: RetainedFixtureControlEvidenceV1["page"],
): void {
  if (!exactKeys(value, [
    "controlId", "identity", "label", "questionType", "uiType", "answerType",
    "uiVariant", "required", "allowedOptions",
  ]) || !identifier(value.controlId) || !identifier(value.identity) ||
      (value.label !== null && !bounded(value.label, 512)) || !identifier(value.questionType) ||
      !uiTypes.has(value.uiType) || !answerTypes.has(value.answerType) ||
      !/^workday_[a-z0-9_]+_v\d+$/u.test(value.uiVariant) ||
      (value.required !== null && typeof value.required !== "boolean") ||
      (value.allowedOptions !== null && (value.allowedOptions.length < 1 ||
        value.allowedOptions.length > 64 || value.allowedOptions.some((option) => !bounded(option, 512)))) ||
      (value.identity === "unresolved") !== (value.label === null)) denied();
  const guide = retainedIntakeControlGuide.find((entry) =>
    entry.page === page && entry.identity === value.identity
  );
  const expectedOptions = guide?.allowedOptions ?? [];
  if (guide === undefined || value.label !== guide.sanitizedLabel ||
      value.questionType !== guide.normalizedQuestionType || value.uiType !== guide.behavior ||
      value.answerType !== guide.answerType || value.uiVariant !== guide.uiVariant ||
      value.required !== guide.required ||
      (expectedOptions.length === 0
        ? value.allowedOptions !== null
        : value.allowedOptions === null || !sameOptions(value.allowedOptions, expectedOptions))) denied();
}

function sameOptions(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    actual.every((option, index) => option === expected[index]);
}

function freezeMetadata(value: RetainedFixtureControlMetadata): RetainedFixtureControlMetadata {
  return Object.freeze({
    ...value,
    allowedOptions: value.allowedOptions === null ? null : Object.freeze([...value.allowedOptions]),
  });
}

function metadataFrom(value: RetainedFixtureControlRecordV1): RetainedFixtureControlMetadata {
  return {
    controlId: value.controlId,
    identity: value.identity,
    label: value.label,
    questionType: value.questionType,
    uiType: value.uiType,
    answerType: value.answerType,
    uiVariant: value.uiVariant,
    required: value.required,
    allowedOptions: value.allowedOptions,
  };
}

function monitorBinding(value: RetainedFixtureControlRecordV1["monitorBinding"]): boolean {
  return value !== null && exactKeys(value, [
    "operationId", "attempt", "beforeMutationAck", "afterReadbackAck",
  ]) && operationId(value.operationId) && positiveInteger(value.attempt) &&
    value.beforeMutationAck === true && value.afterReadbackAck === true;
}

function observationBinding(value: RetainedFixtureControlRecordV1["observationBinding"]): boolean {
  return value !== null && exactKeys(value, ["operationId", "attempt", "stateObservedAck"]) &&
    operationId(value.operationId) && positiveInteger(value.attempt) && value.stateObservedAck === true;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9._-]{0,127}$/u.test(value);
}

function operationId(value: unknown): value is string {
  return typeof value === "string" && /^operation_[A-Za-z0-9_-]{8,128}$/u.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 256;
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum &&
    value.trim() === value;
}

function denied(): never {
  throw new TypeError("retained fixture control evidence denied");
}
