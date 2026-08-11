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
  profileRepeatableCatalog,
  profileScalarControlCatalog,
} from "../../ats/workday/application/profile/catalog.ts";
import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

const uiTypes = new Set([
  "checkbox", "file", "text", "phone", "date", "search_select", "radio_group",
]);
const questionCategories = new Set([
  "identity", "address", "phone", "application_source", "prior_employment",
  "experience", "education", "skill", "unknown",
]);
const answerCategories = new Set(["text", "phone", "date", "option", "unknown"]);
const optionMappings = new Set([
  "not_applicable", "owner_visible_option", "unresolved", "visible_exact", "approved_alias",
]);
const prefillDispositions = new Set([
  "already_correct", "blank", "conflict", "needs_owner_input",
]);
const driverAttempts = new Set([
  "none", "text", "phone", "date", "search_select", "radio_group",
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

export interface ProfileFieldMechanicsV1 {
  readonly popupBound: string;
  readonly optionFocused: string;
  readonly optionActivated: string;
  readonly popupClosed: string;
  readonly backingValueCommitted: string;
  readonly validationCleared: string;
  readonly persistentReadback: string;
}

export interface ProfileFieldLearningRecordV1 {
  readonly fieldIdentity: string;
  readonly uiType: string;
  readonly uiVariant: string;
  readonly questionCategory: string;
  readonly answerCategory: string;
  readonly required: boolean;
  readonly visibleOptionIds: readonly string[];
  readonly selectedOptionId: string | null;
  readonly optionMapping: string;
  readonly prefillDisposition: string;
  readonly driverAttempt: string;
  readonly mechanics: ProfileFieldMechanicsV1;
}

export interface ProfileFieldLearningEvidenceV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-profile-field-learning-v1";
  readonly page: "profile";
  readonly fields: readonly ProfileFieldLearningRecordV1[];
}

export interface ProfileFieldLearningCapture {
  readonly page: WorkdayProfilePagePort;
  write(): string | null;
}

export function createProfileFieldLearningCapture(input: {
  readonly page: WorkdayProfilePagePort;
  readonly plan: ProfilePagePlan;
  readonly root?: string;
  readonly sensitiveValues: readonly string[];
}): ProfileFieldLearningCapture {
  const records = new Map<string, MutableRecord>();
  const controlBindings = new Map<string, string>();
  const pending = new Map<string, string>();
  const rowOrdinals = new Map<string, number>();
  const nextRowOrdinal = new Map<string, number>();
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
      );
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
          if (record !== undefined) record.mechanics.persistentReadback = "driver_failed";
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
    write() {
      if (written || records.size === 0) return null;
      written = true;
      try {
        return writeAtomicJsonEvidence({
          root: input.root ?? "",
          value: admitProfileFieldLearningEvidence({
            schemaVersion: 1,
            evidenceRevision: "s2-profile-field-learning-v1",
            page: "profile",
            fields: [...records.values()].map(freezeRecord),
          }),
          sensitiveValues: input.sensitiveValues,
          label: "profile-field-learning",
          fileName: "profile-field-learning.json",
        });
      } catch {
        return null;
      }
    },
  });
}

export function admitProfileFieldLearningEvidence(
  value: ProfileFieldLearningEvidenceV1,
): ProfileFieldLearningEvidenceV1 {
  if (
    !exactKeys(value, ["schemaVersion", "evidenceRevision", "page", "fields"]) ||
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-profile-field-learning-v1" ||
    value.page !== "profile" ||
    value.fields.length < 1 || value.fields.length > 128
  ) denied();
  const identities = new Set<string>();
  for (const field of value.fields) {
    if (
      !exactKeys(field, [
        "fieldIdentity", "uiType", "uiVariant", "questionCategory",
        "answerCategory", "required", "visibleOptionIds", "selectedOptionId",
        "optionMapping", "prefillDisposition", "driverAttempt", "mechanics",
      ]) ||
      !validFieldIdentity(field.fieldIdentity) ||
      !validIdentityBinding(field) ||
      identities.has(field.fieldIdentity) ||
      !uiTypes.has(field.uiType) ||
      !reviewedUiVariants.has(field.uiVariant) ||
      !questionCategories.has(field.questionCategory) ||
      !answerCategories.has(field.answerCategory) ||
      typeof field.required !== "boolean" ||
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
      !exactMechanics(field.mechanics) ||
      !validMechanicsRelations(field)
    ) denied();
    identities.add(field.fieldIdentity);
  }
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
  const match = /^profile\.(experience|education|skills)\.([1-9][0-9]{0,2})\.(.+)$/u.exec(value);
  if (match === null) return false;
  const section = match[1] as "experience" | "education" | "skills";
  return repeatableFields.get(section)?.has(match[3]!) === true;
}

function validIdentityBinding(field: ProfileFieldLearningRecordV1): boolean {
  const scalar = profileScalarControlCatalog.find(
    ({ fieldId }) => field.fieldIdentity === `profile.${fieldId}`,
  );
  if (scalar !== undefined) {
    return field.uiType === scalar.uiBehavior && field.uiVariant === scalar.uiVariant;
  }
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
      field.driverAttempt === "none" &&
      sameMechanics(field.mechanics, expectedMechanics);
  }
  const repeatable = /^profile\.(experience|education|skills)\.[1-9][0-9]{0,2}\.(.+)$/u.exec(
    field.fieldIdentity,
  );
  if (repeatable === null) return false;
  const section = repeatable[1] as "experience" | "education" | "skills";
  const catalog = profileRepeatableCatalog.find((entry) => entry.section === section);
  const binding = catalog?.fields.find(({ fieldId }) => fieldId === repeatable[2]);
  return binding !== undefined &&
    field.uiType === binding.uiBehavior && field.uiVariant === binding.uiVariant;
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
  visibleOptionIds: readonly string[];
  selectedOptionId: string | null;
  optionMapping: string;
  prefillDisposition: string;
  driverAttempt: string;
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
    const existing = result.get(field.fieldId);
    if (existing === undefined || sameCategories(existing, field)) result.set(field.fieldId, field);
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
): void {
  controlBindings.clear();
  for (const control of snapshot.controls) {
    learn(control, `profile.${control.fieldId}`, plans.get(control.fieldId), records, controlBindings, pending);
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
    record = {
      fieldIdentity: identity,
      uiType: control.uiBehavior,
      uiVariant: control.uiVariant,
      questionCategory: plan?.questionType ?? "unknown",
      answerCategory: plan?.answerType ?? "unknown",
      required: control.required,
      visibleOptionIds: [],
      selectedOptionId: null,
      optionMapping: optionMapping(plan),
      prefillDisposition: prefillDisposition(plan, control.readback),
      driverAttempt: "none",
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
    }
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
  const choice = behavior === "search_select" || behavior === "radio_group";
  const popup = behavior === "search_select";
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

function validMechanicsRelations(field: ProfileFieldLearningRecordV1): boolean {
  const choice = field.uiType === "search_select" || field.uiType === "radio_group";
  const popup = field.uiType === "search_select";
  if (
    field.driverAttempt !== "none" && field.driverAttempt !== field.uiType ||
    field.driverAttempt === "none" &&
      field.mechanics.persistentReadback !== "not_attempted" ||
    field.driverAttempt !== "none" &&
      field.mechanics.persistentReadback === "not_attempted" ||
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
  if (plan.answerType !== "option") return "not_applicable";
  return plan.optionMapping === undefined ? "unresolved" : "owner_visible_option";
}

function prefillDisposition(
  plan: ProfileFieldPlan | undefined,
  readback: string | null,
): string {
  if (plan === undefined || plan.answer.kind === "profile_answer_missing") {
    return "needs_owner_input";
  }
  if (readback === null || normalize(readback) === "") return "blank";
  const expected = plan.optionMapping?.visibleOption ?? plan.answer.value;
  return sameValue(expected, readback) ? "already_correct" : "conflict";
}

function freezeRecord(value: MutableRecord): ProfileFieldLearningRecordV1 {
  return Object.freeze({
    ...value,
    visibleOptionIds: Object.freeze([...value.visibleOptionIds]),
    mechanics: Object.freeze({ ...value.mechanics }),
  });
}

function sameCategories(left: ProfileFieldPlan, right: ProfileFieldPlan): boolean {
  return left.questionType === right.questionType && left.answerType === right.answerType;
}

function sameValue(expected: string, actual: string | null): boolean {
  return actual !== null && normalize(expected) === normalize(actual);
}

function normalize(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key, index) => keys[index] === key);
}

function denied(): never {
  throw new TypeError("profile field learning evidence denied");
}
