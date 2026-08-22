import type {
  ProfileCommitRequest,
  ProfileControlSnapshot,
  ProfileFieldPlan,
  ProfileInteractionSnapshot,
  ProfilePagePlan,
  ProfilePageSnapshot,
  ProfileRowSnapshot,
  WorkdayProfilePagePort,
} from "../../ats/workday/application/profile/index.ts";
import {
  answerLaneAdmitted,
  type AnswerProvenanceLane,
} from "../../form/answers/application-types.ts";
import {
  profileRepeatableCatalog,
  profileScalarControlCatalog,
} from "../../ats/workday/application/profile/catalog.ts";
import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

const uiTypes = new Set([
  "checkbox", "file", "text", "textarea", "phone", "date", "month", "year",
  "number", "url", "select", "multi_select", "search_select", "radio_group",
]);
const questionCategories = new Set([
  "identity", "address", "phone", "application_source", "prior_employment",
  "employment", "experience", "education", "skill", "language", "website",
  "social_network", "unknown",
]);
const answerCategories = new Set([
  "text", "phone", "date", "month", "year", "number", "url", "boolean",
  "option", "single_select", "multi_select", "unknown",
]);
const optionMappings = new Set([
  "not_applicable", "owner_visible_option", "unresolved", "visible_exact", "approved_alias",
]);
const prefillDispositions = new Set([
  "already_correct", "blank", "conflict", "needs_owner_input",
]);
const driverAttempts = new Set([
  "none", "text", "textarea", "phone", "date", "month", "year", "number", "url",
  "checkbox", "select", "multi_select", "search_select", "radio_group",
]);
const mechanicStatuses = new Set(["not_applicable", "not_observed", "observed"]);
const persistentReadbacks = new Set([
  "not_attempted", "pending_rescan", "verified_after_rescan",
  "unverified_after_rescan", "driver_failed",
]);
const reviewedUiVariants = new Set([
  ...profileScalarControlCatalog.map(({ uiVariant }) => uiVariant),
  ...profileRepeatableCatalog.flatMap(({ fields }) =>
    fields.map(({ uiVariant }) => uiVariant)
  ),
  "workday_unknown_required_v1",
]);
const scalarIdentities = new Set(
  profileScalarControlCatalog.map(({ fieldId }) => `profile.${fieldId}`),
);
const repeatableFields = new Map(
  profileRepeatableCatalog.map(({ section, fields }) => [
    section,
    new Set(fields.map(({ fieldId }) => fieldId)),
  ]),
);
const reviewedStructuralStrings = Object.freeze([
  ...uiTypes,
  ...questionCategories,
  ...answerCategories,
  ...optionMappings,
  ...prefillDispositions,
  ...driverAttempts,
  ...mechanicStatuses,
  ...persistentReadbacks,
  ...reviewedUiVariants,
  ...scalarIdentities,
  ...profileRepeatableCatalog.flatMap(({ section, fields }) => [
    section,
    ...fields.map(({ fieldId }) => fieldId),
  ]),
]);

export interface ProfileFieldMechanicsV1 {
  readonly popupBound: string;
  readonly optionFocused: string;
  readonly optionActivated: string;
  readonly popupClosed: string;
  readonly backingValueCommitted: string;
  readonly validationCleared: string;
  readonly persistentReadback: string;
}

export interface ProfileFieldLearningRecordV2 {
  readonly fieldIdentity: string;
  readonly uiType: string;
  readonly uiVariant: string;
  readonly questionCategory: string;
  readonly answerCategory: string;
  readonly required: boolean;
  readonly answerState: "answered" | "unset";
  readonly lane: AnswerProvenanceLane | null;
  readonly visibleOptionIds: readonly string[];
  readonly selectedOptionId: string | null;
  readonly optionMapping: string;
  readonly prefillDisposition: string;
  readonly driverAttempt: string;
  readonly monitorBinding: {
    readonly operationId: string;
    readonly attempt: number;
    readonly beforeMutationAck: true;
    readonly afterReadbackAck: true;
  } | {
    readonly operationId: string;
    readonly attempt: number;
    readonly stateObservedAck: true;
  } | null;
  readonly terminalDisposition:
    | "verified" | "verified_without_mutation" | "optional_unset"
    | "required_unset" | "driver_failed" | "verification_failed" | "pending";
  readonly mechanics: ProfileFieldMechanicsV1;
}

export interface ProfileFieldLearningEvidenceV2 {
  readonly schemaVersion: 4;
  readonly evidenceRevision: "s2-profile-field-learning-v4";
  readonly page: "profile";
  readonly executionMode: "live" | "synthetic_test_non_submittable";
  readonly testOnly: boolean;
  readonly liveAcceptanceEligible: boolean;
  readonly visibleControlCount: number;
  readonly fields: readonly ProfileFieldLearningRecordV2[];
}

export interface ProfileFieldLearningCapture {
  readonly page: WorkdayProfilePagePort;
  monitorAck(input: {
    readonly controlId: string;
    readonly operationId: string;
    readonly attempt: number;
    readonly moment: "before_mutation" | "after_readback";
  }): void;
  write(): string | null;
}

export function createProfileFieldLearningCapture(input: {
  readonly page: WorkdayProfilePagePort;
  readonly plan: ProfilePagePlan;
  readonly root?: string;
  readonly fileName?: "profile-field-learning.json" | "profile-field-learning-02.json";
  readonly sensitiveValues: readonly string[];
  readonly observationBinding?: {
    readonly operationId: string;
    readonly attempt: number;
    readonly stateObservedAck: true;
  };
}): ProfileFieldLearningCapture {
  const records = new Map<string, MutableRecord>();
  const controlBindings = new Map<string, string>();
  const pending = new Map<string, string>();
  const rowOrdinals = new Map<string, number>();
  const nextRowOrdinal = new Map<string, number>();
  const visibleIdentities = new Set<string>();
  const plans = plannedFields(input.plan);
  let written = false;

  const page: WorkdayProfilePagePort = {
    async inspect(signal) {
      const snapshot = await input.page.inspect(signal);
      observe(
        snapshot,
        plans,
        records,
        controlBindings,
        pending,
        rowOrdinals,
        nextRowOrdinal,
        visibleIdentities,
      );
      if (input.observationBinding !== undefined) {
        for (const record of records.values()) {
          if (record.driverAttempt === "none" && record.monitorBinding === null) {
            record.monitorBinding = Object.freeze({ ...input.observationBinding });
          }
        }
      }
      return snapshot;
    },
    async commit(request, signal) {
      const identity = controlBindings.get(request.controlId);
      if (identity !== undefined) {
        const record = records.get(identity);
        if (record !== undefined) {
          record.driverAttempt = request.uiBehavior;
          record.mechanics.persistentReadback = "pending_rescan";
          pending.set(identity, request.value);
        }
      }
      try {
        await input.page.commit(request, signal);
        if (identity !== undefined) {
          applyInteraction(records.get(identity), input.page.interaction?.(request.controlId));
        }
      } catch (error) {
        if (identity !== undefined) {
          const record = records.get(identity);
          applyInteraction(record, input.page.interaction?.(request.controlId));
          if (record !== undefined) {
            record.mechanics.persistentReadback = "driver_failed";
            record.terminalDisposition = "driver_failed";
          }
          pending.delete(identity);
        }
        throw error;
      }
    },
    addOwnedRow(section, signal) {
      return input.page.addOwnedRow(section, signal);
    },
    removeOwnedRow(section, rowId, signal) {
      return input.page.removeOwnedRow(section, rowId, signal);
    },
  };

  return Object.freeze({
    page,
    monitorAck(binding: {
      readonly controlId: string;
      readonly operationId: string;
      readonly attempt: number;
      readonly moment: "before_mutation" | "after_readback";
    }) {
      const identity = controlBindings.get(binding.controlId);
      const record = identity === undefined ? undefined : records.get(identity);
      if (record === undefined) throw new TypeError("profile monitor binding unavailable");
      if (binding.moment === "before_mutation") {
        if (record.pendingMonitor !== null || isMutationBinding(record.monitorBinding)) {
          throw new TypeError("profile monitor binding duplicate");
        }
        record.monitorBinding = null;
        record.pendingMonitor = {
          operationId: binding.operationId,
          attempt: binding.attempt,
          beforeMutationAck: true,
        };
        return;
      }
      const pendingMonitor = record.pendingMonitor;
      if (pendingMonitor?.operationId !== binding.operationId ||
          pendingMonitor.attempt !== binding.attempt) {
        throw new TypeError("profile monitor binding mismatch");
      }
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
        const fields = [...records.entries()]
          .filter(([identity]) => visibleIdentities.has(identity))
          .map(([, record]) => freezeRecord(record));
        const liveAcceptanceEligible = input.plan.mode === "live" &&
          fields.every(liveEligibleField);
        return writeAtomicJsonEvidence({
          root: input.root ?? "",
          value: admitProfileFieldLearningEvidence({
            schemaVersion: 4,
            evidenceRevision: "s2-profile-field-learning-v4",
            page: "profile",
            executionMode: input.plan.mode,
            testOnly: input.plan.mode === "synthetic_test_non_submittable",
            liveAcceptanceEligible,
            visibleControlCount: fields.length,
            fields,
          }),
          sensitiveValues: input.sensitiveValues.filter((value) =>
            value.length < 3 || !reviewedStructuralStrings.some((structural) =>
              structural.includes(value)
            )
          ),
          label: "profile-field-learning",
          fileName: input.fileName ?? "profile-field-learning.json",
        });
      } catch (error) {
        if ((input.root ?? "") !== "") {
          process.stderr.write(`${JSON.stringify({
            profileFieldLearningWriteFailed: error instanceof Error ? error.message : "unknown",
          })}\n`);
        }
        return null;
      }
    },
  });
}

export function admitProfileFieldLearningEvidence(
  value: ProfileFieldLearningEvidenceV2,
): ProfileFieldLearningEvidenceV2 {
  if (
    !exactKeys(value, [
      "schemaVersion", "evidenceRevision", "page", "executionMode", "testOnly",
      "liveAcceptanceEligible", "visibleControlCount", "fields",
    ]) ||
    value.schemaVersion !== 4 ||
    value.evidenceRevision !== "s2-profile-field-learning-v4" ||
    value.page !== "profile" ||
    !validMode(value.executionMode, value.testOnly, value.liveAcceptanceEligible) ||
    value.fields.length < 1 || value.fields.length > 128 ||
    value.visibleControlCount !== value.fields.length
  ) denied();
  const identities = new Set<string>();
  for (const field of value.fields) {
    if (!validFieldIdentity(field.fieldIdentity)) denied("field_identity");
    if (!validIdentityBinding(field)) {
      denied(`identity_binding:${field.fieldIdentity}:${field.uiType}:${field.uiVariant}`);
    }
    if (!exactKeys(field, [
      "fieldIdentity", "uiType", "uiVariant", "questionCategory",
      "answerCategory", "required", "answerState", "lane",
      "visibleOptionIds", "selectedOptionId",
      "optionMapping", "prefillDisposition", "driverAttempt", "monitorBinding",
      "terminalDisposition", "mechanics",
    ])) denied("field_shape");
    if (
      identities.has(field.fieldIdentity) ||
      !uiTypes.has(field.uiType) ||
      !reviewedUiVariants.has(field.uiVariant) ||
      !questionCategories.has(field.questionCategory) ||
      !answerCategories.has(field.answerCategory) ||
      typeof field.required !== "boolean" ||
      !["answered", "unset"].includes(field.answerState) ||
      (field.lane !== null && !["live_owner_fact", "synthetic_test_default"].includes(field.lane)) ||
      (field.answerState === "answered" && field.lane === null) ||
      (field.answerState === "unset" && field.lane !== null) ||
      (field.lane === "live_owner_fact" && value.executionMode !== "live") ||
      (field.lane === "synthetic_test_default" &&
        value.executionMode !== "synthetic_test_non_submittable") ||
      field.visibleOptionIds.length > 64 ||
      new Set(field.visibleOptionIds).size !== field.visibleOptionIds.length ||
      field.visibleOptionIds.some((id, index) =>
        id !== `option_ref_${String(index + 1).padStart(2, "0")}`
      ) ||
      (field.selectedOptionId !== null &&
        !field.visibleOptionIds.includes(field.selectedOptionId)) ||
      !optionMappings.has(field.optionMapping) ||
      !prefillDispositions.has(field.prefillDisposition) ||
      !driverAttempts.has(field.driverAttempt) ||
      !validMonitorBinding(field.monitorBinding) ||
      ![
        "verified", "verified_without_mutation", "optional_unset", "required_unset",
        "driver_failed", "verification_failed", "pending",
      ].includes(field.terminalDisposition) ||
      !exactMechanics(field.mechanics)
    ) denied("field_value");
    if (!validMechanicsRelations(field)) denied(`mechanics_relation:${field.fieldIdentity}`);
    identities.add(field.fieldIdentity);
  }
  const operations = value.fields.flatMap(({ monitorBinding }) =>
    isMutationBinding(monitorBinding) ? [monitorBinding.operationId] : []
  );
  if (new Set(operations).size !== operations.length) denied();
  const eligible = value.executionMode === "live" && value.fields.every(liveEligibleField);
  if (value.liveAcceptanceEligible !== eligible) denied();
  return Object.freeze({
    ...value,
    fields: Object.freeze(value.fields.map((field) => Object.freeze({
      ...field,
      visibleOptionIds: Object.freeze([...field.visibleOptionIds]),
      mechanics: Object.freeze({ ...field.mechanics }),
    }))),
  });
}

function validFieldIdentity(value: string): boolean {
  if (
    scalarIdentities.has(value) ||
    /^profile\.unknown\.(required|optional)\.[1-9][0-9]{0,2}$/u.test(value)
  ) {
    return true;
  }
  const match = /^profile\.(experience|education|skills|websites)\.([1-9][0-9]{0,2})\.(.+)$/u.exec(value);
  if (match === null) return false;
  const section = match[1] as "experience" | "education" | "skills" | "websites";
  return repeatableFields.get(section)?.has(match[3]!) === true;
}

function validIdentityBinding(field: ProfileFieldLearningRecordV2): boolean {
  const scalar = profileScalarControlCatalog.some(
    ({ fieldId, uiBehavior, uiVariant }) =>
      field.fieldIdentity === `profile.${fieldId}` &&
      field.uiType === uiBehavior && field.uiVariant === uiVariant,
  );
  if (scalar) return true;
  const unknown = /^profile\.unknown\.(required|optional)\.[1-9][0-9]{0,2}$/u.exec(
    field.fieldIdentity,
  );
  if (unknown !== null) {
    const expectedMechanics = emptyMechanics(field.uiType as ProfileControlSnapshot["uiBehavior"]);
    return field.uiVariant === "workday_unknown_required_v1" &&
      field.questionCategory === "unknown" && field.answerCategory === "unknown" &&
      field.required === (unknown[1] === "required") &&
      field.visibleOptionIds.length === 0 && field.selectedOptionId === null &&
      field.optionMapping === "unresolved" &&
      field.prefillDisposition === "needs_owner_input" &&
      field.answerState === "unset" && field.lane === null &&
      field.driverAttempt === "none" &&
      sameMechanics(field.mechanics, expectedMechanics);
  }
  const repeatable = /^profile\.(experience|education|skills|websites)\.([1-9][0-9]{0,2})\.(.+)$/u.exec(
    field.fieldIdentity,
  );
  if (repeatable === null) return false;
  const section = repeatable[1] as "experience" | "education" | "skills" | "websites";
  const catalog = profileRepeatableCatalog.find((entry) => entry.section === section);
  return catalog?.fields.some(({ fieldId, uiBehavior, uiVariant }) =>
    fieldId === repeatable[3] && field.uiType === uiBehavior && field.uiVariant === uiVariant
  ) === true;
}

function sameMechanics(
  left: ProfileFieldMechanicsV1,
  right: MutableRecord["mechanics"],
): boolean {
  return left.popupBound === right.popupBound &&
    left.optionFocused === right.optionFocused &&
    left.optionActivated === right.optionActivated &&
    left.popupClosed === right.popupClosed &&
    left.backingValueCommitted === right.backingValueCommitted &&
    left.validationCleared === right.validationCleared &&
    left.persistentReadback === right.persistentReadback;
}

interface MutableRecord {
  fieldIdentity: string;
  uiType: string;
  uiVariant: string;
  questionCategory: string;
  answerCategory: string;
  required: boolean;
  answerState: "answered" | "unset";
  lane: AnswerProvenanceLane | null;
  visibleOptionIds: readonly string[];
  selectedOptionId: string | null;
  optionMapping: string;
  prefillDisposition: string;
  driverAttempt: string;
  monitorBinding: ProfileFieldLearningRecordV2["monitorBinding"];
  pendingMonitor: {
    operationId: string;
    attempt: number;
    beforeMutationAck: true;
  } | null;
  terminalDisposition: ProfileFieldLearningRecordV2["terminalDisposition"];
  mechanics: {
    popupBound: string;
    optionFocused: string;
    optionActivated: string;
    popupClosed: string;
    backingValueCommitted: string;
    validationCleared: string;
    persistentReadback: string;
  };
}

function plannedFields(plan: ProfilePagePlan): ReadonlyMap<string, ProfileFieldPlan> {
  const result = new Map<string, ProfileFieldPlan>();
  for (const field of [
    ...plan.fields,
    ...plan.repeatables.flatMap(({ rows }) => rows.flatMap(({ fields }) => fields)),
  ]) {
    const admitted = field.answer.kind === "answered" &&
        !answerLaneAdmitted(plan.mode, field.answer.lane)
      ? Object.freeze({
          ...field,
          answer: Object.freeze({ kind: "profile_answer_missing" as const }),
        })
      : field;
    const existing = result.get(admitted.fieldId);
    if (existing === undefined || sameCategories(existing, admitted)) {
      result.set(admitted.fieldId, admitted);
    }
  }
  return result;
}

function observe(
  snapshot: ProfilePageSnapshot,
  plans: ReadonlyMap<string, ProfileFieldPlan>,
  records: Map<string, MutableRecord>,
  controlBindings: Map<string, string>,
  pending: Map<string, string>,
  rowOrdinals: Map<string, number>,
  nextRowOrdinal: Map<string, number>,
  visibleIdentities: Set<string>,
): void {
  controlBindings.clear();
  visibleIdentities.clear();
  for (const control of snapshot.controls) {
    const identity = `profile.${control.fieldId}`;
    visibleIdentities.add(identity);
    learn(control, identity, plans.get(control.fieldId), records, controlBindings, pending);
  }
  for (const row of snapshot.rows) {
    const key = `${row.section}\u0000${row.rowId}`;
    let ordinal = rowOrdinals.get(key);
    if (ordinal === undefined) {
      ordinal = (nextRowOrdinal.get(row.section) ?? 0) + 1;
      nextRowOrdinal.set(row.section, ordinal);
      rowOrdinals.set(key, ordinal);
    }
    observeRow(row, ordinal, plans, records, controlBindings, pending);
    for (const control of row.controls) {
      visibleIdentities.add(`profile.${row.section}.${ordinal}.${control.fieldId}`);
    }
  }
}

function observeRow(
  row: ProfileRowSnapshot,
  ordinal: number,
  plans: ReadonlyMap<string, ProfileFieldPlan>,
  records: Map<string, MutableRecord>,
  controlBindings: Map<string, string>,
  pending: Map<string, string>,
): void {
  for (const control of row.controls) {
    learn(
      control,
      `profile.${row.section}.${ordinal}.${control.fieldId}`,
      plans.get(control.fieldId),
      records,
      controlBindings,
      pending,
    );
  }
}

function learn(
  control: ProfileControlSnapshot,
  identity: string,
  plan: ProfileFieldPlan | undefined,
  records: Map<string, MutableRecord>,
  controlBindings: Map<string, string>,
  pending: Map<string, string>,
): void {
  controlBindings.set(control.controlId, identity);
  let record = records.get(identity);
  if (record === undefined) {
    const answerState = plan?.answer.kind === "answered" ? "answered" : "unset";
    record = {
      fieldIdentity: identity,
      uiType: control.uiBehavior,
      uiVariant: control.uiVariant,
      questionCategory: plan?.questionType ?? "unknown",
      answerCategory: plan?.answerType ?? "unknown",
      required: control.required,
      answerState,
      lane: plan?.answer.kind === "answered" ? plan.answer.lane : null,
      visibleOptionIds: [],
      selectedOptionId: null,
      optionMapping: optionMapping(plan),
      prefillDisposition: prefillDisposition(plan, control.readback),
      driverAttempt: "none",
      monitorBinding: null,
      pendingMonitor: null,
      terminalDisposition: answerState === "unset"
        ? control.required ? "required_unset" : "optional_unset"
        : "pending",
      mechanics: emptyMechanics(control.uiBehavior),
    };
    records.set(identity, record);
  }
  const expected = pending.get(identity);
  if (expected !== undefined) {
    record.mechanics.persistentReadback = sameValue(expected, control.readback)
      ? "verified_after_rescan"
      : "unverified_after_rescan";
    if (record.mechanics.persistentReadback === "verified_after_rescan") {
      pending.delete(identity);
      record.terminalDisposition = "verified";
    } else {
      record.terminalDisposition = "verification_failed";
    }
  } else if (record.answerState === "answered" &&
      record.prefillDisposition === "already_correct") {
    record.terminalDisposition = "verified_without_mutation";
  }
}

function applyInteraction(
  record: MutableRecord | undefined,
  interaction: ProfileInteractionSnapshot | undefined,
): void {
  if (record === undefined || interaction === undefined) return;
  record.mechanics.popupBound = mechanicStatus(interaction.popupBound);
  record.mechanics.optionFocused = mechanicStatus(interaction.optionFocused);
  record.mechanics.optionActivated = mechanicStatus(interaction.optionActivated);
  record.mechanics.popupClosed = mechanicStatus(interaction.popupClosed);
  record.mechanics.backingValueCommitted = mechanicStatus(
    interaction.backingValueCommitted,
  );
  record.mechanics.validationCleared = mechanicStatus(interaction.validationCleared);
  if (
    Number.isInteger(interaction.visibleOptionCount) &&
    interaction.visibleOptionCount !== null &&
    interaction.visibleOptionCount >= 0 &&
    interaction.visibleOptionCount <= 64
  ) {
    record.visibleOptionIds = Object.freeze(Array.from(
      { length: interaction.visibleOptionCount },
      (_value, index) => `option_ref_${String(index + 1).padStart(2, "0")}`,
    ));
    record.selectedOptionId = interaction.selectedOptionOrdinal !== null &&
        Number.isInteger(interaction.selectedOptionOrdinal) &&
        interaction.selectedOptionOrdinal >= 1 &&
        interaction.selectedOptionOrdinal <= interaction.visibleOptionCount
      ? `option_ref_${String(interaction.selectedOptionOrdinal).padStart(2, "0")}`
      : null;
  }
}

function mechanicStatus(value: boolean | null): string {
  return value === null ? "not_applicable" : value ? "observed" : "not_observed";
}

function emptyMechanics(
  behavior: ProfileControlSnapshot["uiBehavior"],
): MutableRecord["mechanics"] {
  const choice = behavior === "search_select" || behavior === "select" ||
    behavior === "multi_select" || behavior === "radio_group";
  const popup = behavior === "search_select" || behavior === "select" ||
    behavior === "multi_select";
  return {
    popupBound: popup ? "not_observed" : "not_applicable",
    optionFocused: popup ? "not_observed" : "not_applicable",
    optionActivated: choice ? "not_observed" : "not_applicable",
    popupClosed: popup ? "not_observed" : "not_applicable",
    backingValueCommitted: "not_observed",
    validationCleared: "not_observed",
    persistentReadback: "not_attempted",
  };
}

function exactMechanics(value: unknown): value is ProfileFieldMechanicsV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const mechanics = value as unknown as ProfileFieldMechanicsV1;
  return exactKeys(mechanics, [
    "popupBound", "optionFocused", "optionActivated", "popupClosed",
    "backingValueCommitted", "validationCleared", "persistentReadback",
  ]) &&
    mechanicStatuses.has(mechanics.popupBound) &&
    mechanicStatuses.has(mechanics.optionFocused) &&
    mechanicStatuses.has(mechanics.optionActivated) &&
    mechanicStatuses.has(mechanics.popupClosed) &&
    mechanicStatuses.has(mechanics.backingValueCommitted) &&
    mechanicStatuses.has(mechanics.validationCleared) &&
    persistentReadbacks.has(mechanics.persistentReadback);
}

function validMechanicsRelations(field: ProfileFieldLearningRecordV2): boolean {
  const choice = field.uiType === "search_select" || field.uiType === "select" ||
    field.uiType === "multi_select" || field.uiType === "radio_group";
  const popup = field.uiType === "search_select" || field.uiType === "select" ||
    field.uiType === "multi_select";
  if (
    field.driverAttempt !== "none" && field.driverAttempt !== field.uiType ||
    field.driverAttempt === "none" &&
      field.mechanics.persistentReadback !== "not_attempted" ||
    field.driverAttempt !== "none" &&
      field.mechanics.persistentReadback === "not_attempted" ||
    field.driverAttempt === "none" && isMutationBinding(field.monitorBinding) ||
    (field.driverAttempt !== "none") !== isMutationBinding(field.monitorBinding) ||
    (field.answerState === "unset" && (
      isMutationBinding(field.monitorBinding) || field.driverAttempt !== "none" ||
      field.terminalDisposition !== (field.required ? "required_unset" : "optional_unset")
    )) ||
    (field.terminalDisposition === "verified_without_mutation" && (
      field.driverAttempt !== "none" || isMutationBinding(field.monitorBinding) ||
      field.answerState !== "answered" || field.lane === null
    )) ||
    (field.terminalDisposition === "verified" && (
      !isMutationBinding(field.monitorBinding) ||
      field.mechanics.persistentReadback !== "verified_after_rescan"
    )) ||
    (field.terminalDisposition === "driver_failed" &&
      field.mechanics.persistentReadback !== "driver_failed") ||
    (field.terminalDisposition === "verification_failed" &&
      !["unverified_after_rescan", "pending_rescan"].includes(
        field.mechanics.persistentReadback,
      )) ||
    !choice && (field.visibleOptionIds.length !== 0 || field.selectedOptionId !== null) ||
    !popup && (
      field.mechanics.popupBound !== "not_applicable" ||
      field.mechanics.optionFocused !== "not_applicable" ||
      field.mechanics.popupClosed !== "not_applicable"
    ) ||
    !choice && field.mechanics.optionActivated !== "not_applicable" ||
    field.mechanics.persistentReadback === "verified_after_rescan" && (
      field.mechanics.backingValueCommitted !== "observed" ||
      field.mechanics.validationCleared !== "observed"
    )
  ) return false;
  return true;
}

function optionMapping(plan: ProfileFieldPlan | undefined): string {
  if (plan === undefined) return "unresolved";
  if (!new Set(["option", "single_select", "multi_select"]).has(plan.answerType)) {
    return "not_applicable";
  }
  return plan.optionMapping === undefined ? "unresolved" : "owner_visible_option";
}

function prefillDisposition(
  plan: ProfileFieldPlan | undefined,
  readback: string | null,
): string {
  if (plan === undefined || plan.answer.kind === "profile_answer_missing") {
    return "needs_owner_input";
  }
  if (plan.answer.lane !== "live_owner_fact") return "needs_owner_input";
  if (readback === null || normalize(readback) === "") return "blank";
  const expected = plan.optionMapping?.visibleOption ?? plan.answer.value;
  return sameValue(expected, readback) ? "already_correct" : "conflict";
}

function freezeRecord(value: MutableRecord): ProfileFieldLearningRecordV2 {
  if (value.pendingMonitor !== null) value.terminalDisposition = "verification_failed";
  return Object.freeze({
    fieldIdentity: value.fieldIdentity,
    uiType: value.uiType,
    uiVariant: value.uiVariant,
    questionCategory: value.questionCategory,
    answerCategory: value.answerCategory,
    required: value.required,
    answerState: value.answerState,
    lane: value.lane,
    visibleOptionIds: Object.freeze([...value.visibleOptionIds]),
    selectedOptionId: value.selectedOptionId,
    optionMapping: value.optionMapping,
    prefillDisposition: value.prefillDisposition,
    driverAttempt: value.driverAttempt,
    monitorBinding: value.monitorBinding === null
      ? null
      : Object.freeze({ ...value.monitorBinding }),
    terminalDisposition: value.terminalDisposition,
    mechanics: Object.freeze({ ...value.mechanics }),
  });
}

function liveEligibleField(field: ProfileFieldLearningRecordV2): boolean {
  if (field.answerState === "unset") {
    return !field.required && field.lane === null && isObservationBinding(field.monitorBinding) &&
      field.terminalDisposition === "optional_unset";
  }
  return field.lane === "live_owner_fact" &&
    (field.terminalDisposition === "verified" ||
      field.terminalDisposition === "verified_without_mutation") &&
    (field.terminalDisposition === "verified"
      ? isMutationBinding(field.monitorBinding)
      : isObservationBinding(field.monitorBinding));
}

function validMonitorBinding(value: ProfileFieldLearningRecordV2["monitorBinding"]): boolean {
  return value === null || isMutationBinding(value) || isObservationBinding(value);
}

function isMutationBinding(
  value: ProfileFieldLearningRecordV2["monitorBinding"],
): value is Extract<NonNullable<ProfileFieldLearningRecordV2["monitorBinding"]>, {
  readonly beforeMutationAck: true;
}> {
  return value !== null && "beforeMutationAck" in value && exactKeys(value, [
    "operationId", "attempt", "beforeMutationAck", "afterReadbackAck",
  ]) && /^operation_[A-Za-z0-9_-]{16,64}$/u.test(value.operationId) &&
    Number.isSafeInteger(value.attempt) && value.attempt >= 1 && value.attempt <= 256 &&
    value.beforeMutationAck === true && value.afterReadbackAck === true;
}

function isObservationBinding(
  value: ProfileFieldLearningRecordV2["monitorBinding"],
): value is Extract<NonNullable<ProfileFieldLearningRecordV2["monitorBinding"]>, {
  readonly stateObservedAck: true;
}> {
  return value !== null && "stateObservedAck" in value && exactKeys(value, [
    "operationId", "attempt", "stateObservedAck",
  ]) && /^operation_[A-Za-z0-9_-]{16,64}$/u.test(value.operationId) &&
    Number.isSafeInteger(value.attempt) && value.attempt >= 1 && value.attempt <= 256 &&
    value.stateObservedAck === true;
}

function validMode(mode: string, testOnly: boolean, liveAcceptanceEligible: boolean): boolean {
  return mode === "live"
    ? testOnly === false
    : mode === "synthetic_test_non_submittable" &&
      testOnly === true && liveAcceptanceEligible === false;
}

function sameCategories(left: ProfileFieldPlan, right: ProfileFieldPlan): boolean {
  return left.questionType === right.questionType && left.answerType === right.answerType;
}

function sameValue(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const expectedOptions = optionList(expected);
  if (expectedOptions === undefined) return normalize(expected) === normalize(actual);
  const actualOptions = optionList(actual) ?? [actual];
  if (expectedOptions.length !== actualOptions.length) return false;
  const remaining = new Set(expectedOptions.map(normalize));
  return actualOptions.every((value) => remaining.delete(normalize(value))) && remaining.size === 0;
}

function optionList(value: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 &&
        parsed.every((item) => typeof item === "string" && normalize(item) !== "")
      ? parsed as string[]
      : undefined;
  } catch {
    return undefined;
  }
}

function normalize(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key, index) => keys[index] === key);
}

function denied(reason?: string): never {
  throw new TypeError(`profile field learning evidence denied${reason === undefined ? "" : `: ${reason}`}`);
}
