import type {
  ProfileCommitRequest,
  ProfileControlSnapshot,
  ProfileControlObservation,
  ProfileFieldPlan,
  ProfileInteractionSnapshot,
  ProfileMetadataReconciliationFailure,
  ProfileMetadataMismatchReason,
  ProfilePagePlan,
  ProfilePageSnapshot,
  ProfileLearningConversion,
  ProfileRowSnapshot,
  WorkdayProfilePagePort,
} from "../../ats/workday/application/profile/index.ts";
import { profileLearningConversionFromFailure } from
  "../../ats/workday/application/profile/index.ts";
import {
  answerLaneAdmitted,
  type AnswerProvenanceLane,
} from "../../form/answers/application-types.ts";
import {
  profileRepeatableCatalog,
  profileMetadataMismatchReasons,
  profileScalarControlCatalog,
} from "../../ats/workday/application/profile/index.ts";
import {
  retainedProfileControlGuide,
  retainedProfileTextSha256,
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
const binderStrategies = new Set(["catalog_selector_exact", "opaque_machine_key"]);
const metadataReconciliations = new Set(["pending", "matched", "unresolved", "mismatch"]);
const backingStates = new Set(["unknown", "set", "unset"]);
const validationStates = new Set(["unknown", "clear", "invalid"]);
const optionCatalogStates = new Set(["not_applicable", "observed", "unknown"]);
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
const retainedProfileGuide = new Map(retainedProfileControlGuide
  .map((entry) => [entry.identity, entry]));
const reviewedStructuralStrings = Object.freeze([
  ...uiTypes,
  ...questionCategories,
  ...answerCategories,
  ...optionMappings,
  ...prefillDispositions,
  ...driverAttempts,
  ...mechanicStatuses,
  ...persistentReadbacks,
  ...binderStrategies,
  ...metadataReconciliations,
  ...backingStates,
  ...validationStates,
  ...optionCatalogStates,
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

type ObservedPlanBinding = Pick<ProfileFieldPlan, "questionType" | "answerType">;

export interface ProfileFieldLearningRecordV2 {
  readonly fieldIdentity: string;
  readonly uiType: string;
  readonly uiVariant: string;
  readonly questionCategory: string;
  readonly answerCategory: string;
  readonly planBinding?: ObservedPlanBinding | null;
  readonly required: boolean;
  readonly answerState: "answered" | "unset";
  readonly lane: AnswerProvenanceLane | null;
  readonly binderStrategy: "catalog_selector_exact" | "opaque_machine_key" | null;
  readonly sanitizedLabelSha256: string | null;
  readonly metadataReconciliation: "pending" | "matched" | "unresolved" | "mismatch";
  readonly backingState: "unknown" | "set" | "unset";
  readonly validationState: "unknown" | "clear" | "invalid";
  readonly optionCatalogState: "not_applicable" | "observed" | "unknown";
  readonly visibleOptionIds: readonly string[];
  readonly selectedOptionId: string | null;
  readonly optionMapping: string;
  readonly prefillDisposition: string;
  readonly driverAttempt: string;
  readonly observationBinding: {
    readonly operationId: string;
    readonly attempt: number;
    readonly stateObservedAck: true;
  } | null;
  readonly monitorBinding: {
    readonly operationId: string;
    readonly attempt: number;
    readonly beforeMutationAck: true;
    readonly afterReadbackAck: true;
  } | null;
  readonly terminalDisposition:
    | "verified" | "verified_without_mutation" | "optional_unset"
    | "required_unset" | "driver_failed" | "verification_failed" | "pending";
  readonly mechanics: ProfileFieldMechanicsV1;
}

export interface ProfileFieldLearningEvidenceV2 {
  readonly schemaVersion: 5;
  readonly evidenceRevision: "s2-profile-field-learning-v5";
  readonly page: "profile";
  readonly executionMode: "live" | "synthetic_test_non_submittable";
  readonly testOnly: boolean;
  readonly liveAcceptanceEligible: boolean;
  readonly learningConversion?: ProfileLearningConversion;
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
  readonly observeControl?: (
    control: ProfileControlSnapshot,
    signal: AbortSignal,
  ) => Promise<{
    readonly observation: ProfileControlObservation;
    readonly binding: NonNullable<ProfileFieldLearningRecordV2["observationBinding"]>;
  }>;
}): ProfileFieldLearningCapture {
  const records = new Map<string, MutableRecord>();
  const controlBindings = new Map<string, string>();
  const pending = new Map<string, string>();
  const rowOrdinals = new Map<string, number>();
  const nextRowOrdinal = new Map<string, number>();
  const visibleIdentities = new Set<string>();
  const plans = plannedFields(input.plan);
  let written = false;
  let metadataFailure: ProfileMetadataReconciliationFailure | undefined;

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
      let observationFailed = false;
      for (const control of snapshotControls(snapshot)) {
        const identity = controlBindings.get(control.controlId);
        const record = identity === undefined ? undefined : records.get(identity);
        if (record === undefined || record.observationBinding !== null) continue;
        if (input.observeControl === undefined) {
          observationFailed ||= input.plan.mode === "live";
          continue;
        }
        try {
          const observed = await input.observeControl(control, signal);
          if (operationUsedByAnotherRecord(records, record, observed.binding.operationId)) {
            throw new TypeError("profile control observation operation crossed");
          }
          applyControlObservation(record, control, plans.get(control.fieldId), observed);
        } catch (error) {
          record.metadataReconciliation = "mismatch";
          record.terminalDisposition = "verification_failed";
          throw error;
        }
      }
      metadataFailure = createMetadataReconciliationFailure(records, plans);
      if (metadataFailure !== undefined) {
        throw new TypeError("profile metadata reconciliation failed");
      }
      if (observationFailed) throw new TypeError("profile control observation denied");
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
          applyInteraction(
            records.get(identity), input.page.interaction?.(request.controlId), request.value,
          );
        }
      } catch (error) {
        if (identity !== undefined) {
          const record = records.get(identity);
          applyInteraction(record, input.page.interaction?.(request.controlId), request.value);
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
    metadataReconciliationFailure: () => metadataFailure,
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
        if (operationUsedByAnotherRecord(records, record, binding.operationId) ||
            record.observationBinding?.operationId === binding.operationId) {
          throw new TypeError("profile monitor binding crossed");
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
            schemaVersion: 5,
            evidenceRevision: "s2-profile-field-learning-v5",
            page: "profile",
            executionMode: metadataFailure === undefined
              ? input.plan.mode
              : "synthetic_test_non_submittable",
            testOnly: metadataFailure !== undefined ||
              input.plan.mode === "synthetic_test_non_submittable",
            liveAcceptanceEligible: metadataFailure === undefined && liveAcceptanceEligible,
            ...(metadataFailure === undefined ? {} : {
              learningConversion: conversion(metadataFailure),
            }),
            visibleControlCount: fields.length,
            fields: metadataFailure === undefined
              ? fields
              : fields.map((field) => convertedField(field)),
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

function operationUsedByAnotherRecord(
  records: ReadonlyMap<string, MutableRecord>,
  current: MutableRecord,
  operationId: string,
): boolean {
  return [...records.values()].some((record) => record !== current && (
    record.observationBinding?.operationId === operationId ||
    record.monitorBinding?.operationId === operationId ||
    record.pendingMonitor?.operationId === operationId
  ));
}

function conversion(
  failure: ProfileMetadataReconciliationFailure,
): ProfileLearningConversion {
  return profileLearningConversionFromFailure(failure);
}

function convertedField(
  field: ProfileFieldLearningRecordV2,
): ProfileFieldLearningRecordV2 {
  return Object.freeze({
    ...field,
    answerState: "unset" as const,
    lane: null,
    optionMapping: isChoiceType(field.uiType) ? "unresolved" : field.optionMapping,
    prefillDisposition: "needs_owner_input",
    driverAttempt: "none",
    monitorBinding: null,
    terminalDisposition: field.required ? "required_unset" as const : "optional_unset" as const,
    mechanics: Object.freeze({
      ...field.mechanics,
      backingValueCommitted: "not_observed",
      validationCleared: "not_observed",
      persistentReadback: "not_attempted",
    }),
  });
}

function createMetadataReconciliationFailure(
  records: ReadonlyMap<string, MutableRecord>,
  plans: ReadonlyMap<string, ProfileFieldPlan>,
): ProfileMetadataReconciliationFailure | undefined {
  const mismatches = [...records.values()]
    .filter(({ metadataReconciliation }) => metadataReconciliation === "mismatch")
    .map((record) => Object.freeze({
      fieldId: record.fieldIdentity,
      uiBehavior: record.uiType as ProfileControlSnapshot["uiBehavior"],
      uiVariant: record.uiVariant,
      reasons: metadataMismatchReasons(record, plans.get(record.fieldIdentity.slice("profile.".length))),
    }));
  return mismatches.length === 0
    ? undefined
    : Object.freeze({
        code: "profile_metadata_reconciliation_failed" as const,
        mismatches: Object.freeze(mismatches),
      });
}

function metadataMismatchReasons(
  record: MetadataRecord,
  plan: ProfileFieldPlan | ObservedPlanBinding | null | undefined,
): readonly ProfileMetadataMismatchReason[] {
  const fieldId = record.fieldIdentity.slice("profile.".length);
  const guide = retainedProfileGuide.get(fieldId);
  if (guide === undefined) return Object.freeze([
    ...(record.binderStrategy !== "catalog_selector_exact" ? ["binder_strategy" as const] : []),
    "plan_binding" as const,
  ]);
  const reasons: ProfileMetadataMismatchReason[] = [];
  if (record.binderStrategy !== "catalog_selector_exact") reasons.push("binder_strategy");
  if (record.sanitizedLabelSha256 !== retainedProfileTextSha256(guide.sanitizedLabel)) {
    reasons.push("label_digest");
  }
  if (record.questionCategory !== guide.normalizedQuestionType) {
    reasons.push("question_category");
  }
  if (record.answerCategory !== guide.answerType) reasons.push("answer_category");
  if (!guideBehaviorMatches(guide.behavior, record.uiType, record.uiVariant)) {
    reasons.push("ui_behavior");
  }
  if (record.uiVariant !== guide.uiVariant) reasons.push("ui_variant");
  if (record.required !== guide.required) reasons.push("required_state");
  const expectedOptions = guide.allowedOptions.map((value) =>
    `option_sha256_${retainedProfileTextSha256(value)}`
  );
  if (expectedOptions.length > 0 && (
    record.optionCatalogState !== "observed" ||
    JSON.stringify(record.visibleOptionIds) !== JSON.stringify(expectedOptions)
  )) reasons.push("option_catalog");
  if (!planBindingMatchesGuide(plan, guide)) reasons.push("plan_binding");
  return Object.freeze(reasons.length === 0 ? ["plan_binding"] : reasons);
}

export function admitProfileFieldLearningEvidence(
  value: ProfileFieldLearningEvidenceV2,
): ProfileFieldLearningEvidenceV2 {
  if (
    !exactKeys(value, [
      "schemaVersion", "evidenceRevision", "page", "executionMode", "testOnly",
      "liveAcceptanceEligible",
      ...(value.learningConversion === undefined ? [] : ["learningConversion"]),
      "visibleControlCount", "fields",
    ]) ||
    value.schemaVersion !== 5 ||
    value.evidenceRevision !== "s2-profile-field-learning-v5" ||
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
    if (!validMetadataReconciliation(field)) {
      denied(`metadata_reconciliation:${field.fieldIdentity}`);
    }
    const expectedFieldKeys = [
      "fieldIdentity", "uiType", "uiVariant", "questionCategory",
      "answerCategory",
      ...(Object.hasOwn(field, "planBinding") ? ["planBinding"] : []),
      "required", "answerState", "lane", "binderStrategy",
      "sanitizedLabelSha256", "metadataReconciliation", "backingState",
      "validationState", "optionCatalogState", "observationBinding",
      "visibleOptionIds", "selectedOptionId",
      "optionMapping", "prefillDisposition", "driverAttempt", "monitorBinding",
      "terminalDisposition", "mechanics",
    ];
    if (!exactKeys(field, expectedFieldKeys)) denied("field_shape");
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
      (field.lane === "synthetic_test_default" &&
        value.executionMode !== "synthetic_test_non_submittable") ||
      (field.binderStrategy !== null && !binderStrategies.has(field.binderStrategy)) ||
      (field.planBinding !== undefined && field.planBinding !== null &&
        !validPlanBinding(field.planBinding)) ||
      (field.sanitizedLabelSha256 !== null &&
        !/^[0-9a-f]{64}$/u.test(field.sanitizedLabelSha256)) ||
      !metadataReconciliations.has(field.metadataReconciliation) ||
      !backingStates.has(field.backingState) ||
      !validationStates.has(field.validationState) ||
      !optionCatalogStates.has(field.optionCatalogState) ||
      !(field.observationBinding === null || isObservationBinding(field.observationBinding)) ||
      field.visibleOptionIds.length > 64 ||
      new Set(field.visibleOptionIds).size !== field.visibleOptionIds.length ||
      field.visibleOptionIds.some((id) => !/^option_sha256_[0-9a-f]{64}$/u.test(id)) ||
      (field.optionCatalogState === "observed") !== (field.visibleOptionIds.length > 0) ||
      (field.optionCatalogState === "not_applicable" && isChoiceType(field.uiType)) ||
      (field.optionCatalogState !== "not_applicable" && !isChoiceType(field.uiType) &&
        field.metadataReconciliation !== "unresolved") ||
      (field.selectedOptionId !== null &&
        !field.visibleOptionIds.includes(field.selectedOptionId)) ||
      !optionMappings.has(field.optionMapping) ||
      !prefillDispositions.has(field.prefillDisposition) ||
      !driverAttempts.has(field.driverAttempt) ||
      !(field.monitorBinding === null || isMutationBinding(field.monitorBinding)) ||
      ![
        "verified", "verified_without_mutation", "optional_unset", "required_unset",
        "driver_failed", "verification_failed", "pending",
      ].includes(field.terminalDisposition) ||
      !exactMechanics(field.mechanics)
    ) denied("field_value");
    if (!validMechanicsRelations(field)) denied(`mechanics_relation:${field.fieldIdentity}`);
    identities.add(field.fieldIdentity);
  }
  const mismatchIds = value.fields
    .filter(({ metadataReconciliation }) => metadataReconciliation === "mismatch")
    .map(({ fieldIdentity }) => fieldIdentity);
  if ((mismatchIds.length > 0) !== (value.learningConversion !== undefined) ||
      value.learningConversion !== undefined &&
        !validConversion(value.learningConversion, value)) {
    denied("learning_conversion");
  }
  const operations = value.fields.flatMap(({ observationBinding, monitorBinding }) => [
    ...(observationBinding === null ? [] : [observationBinding.operationId]),
    ...(monitorBinding === null ? [] : [monitorBinding.operationId]),
  ]);
  if (new Set(operations).size !== operations.length) denied();
  const eligible = value.executionMode === "live" && value.fields.every(liveEligibleField);
  if (value.liveAcceptanceEligible !== eligible) denied();
  return Object.freeze({
    ...value,
    fields: Object.freeze(value.fields.map((field) => Object.freeze({
      ...field,
      visibleOptionIds: Object.freeze([...field.visibleOptionIds]),
      observationBinding: field.observationBinding === null
        ? null
        : Object.freeze({ ...field.observationBinding }),
      monitorBinding: field.monitorBinding === null
        ? null
        : Object.freeze({ ...field.monitorBinding }),
      mechanics: Object.freeze({ ...field.mechanics }),
    }))),
  });
}

function validConversion(
  value: ProfileLearningConversion,
  evidence: ProfileFieldLearningEvidenceV2,
): boolean {
  const mismatches = evidence.fields.filter(({ metadataReconciliation }) =>
    metadataReconciliation === "mismatch"
  );
  const mismatchIds = mismatches.map(({ fieldIdentity }) => fieldIdentity);
  return exactKeys(value, [
    "kind", "executionMode", "testOnly", "mutationAllowed", "defaultsGenerated",
    "liveAcceptanceEligible", "fieldIds", "affected",
  ]) && value.kind === "profile_ui_learning" &&
    value.executionMode === "synthetic_test_non_submittable" &&
    value.testOnly === true && value.mutationAllowed === false &&
    value.defaultsGenerated === false && value.liveAcceptanceEligible === false &&
    value.fieldIds.length === mismatchIds.length && value.fieldIds.length > 0 &&
    new Set(value.fieldIds).size === value.fieldIds.length &&
    sameList(value.fieldIds, mismatchIds) &&
    value.affected.length === mismatchIds.length &&
    value.affected.every((affected, index) =>
      exactKeys(affected, ["fieldId", "reasons"]) &&
      affected.fieldId === mismatchIds[index] &&
      validFieldIdentity(affected.fieldId) &&
      affected.reasons.length > 0 &&
      affected.reasons.length <= profileMetadataMismatchReasons.length &&
      new Set(affected.reasons).size === affected.reasons.length &&
      affected.reasons.every((reason) =>
        (profileMetadataMismatchReasons as readonly string[]).includes(reason)
      ) && sameList(
        affected.reasons,
        metadataMismatchReasons(mismatches[index]!, mismatches[index]!.planBinding),
      ) && validConvertedField(mismatches[index]!)
    ) && evidence.executionMode === "synthetic_test_non_submittable" &&
    evidence.testOnly === true && evidence.liveAcceptanceEligible === false;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validConvertedField(field: ProfileFieldLearningRecordV2): boolean {
  return isObservationBinding(field.observationBinding) &&
    (field.planBinding === null || validPlanBinding(field.planBinding)) &&
    field.answerState === "unset" &&
    field.lane === null &&
    field.prefillDisposition === "needs_owner_input" &&
    field.driverAttempt === "none" &&
    field.monitorBinding === null &&
    field.terminalDisposition === (field.required ? "required_unset" : "optional_unset") &&
    field.mechanics.backingValueCommitted === "not_observed" &&
    field.mechanics.validationCleared === "not_observed" &&
    field.mechanics.persistentReadback === "not_attempted" &&
    (!isChoiceType(field.uiType) || field.optionMapping === "unresolved");
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

function validPlanBinding(value: unknown): value is ObservedPlanBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return exactKeys(candidate, ["questionType", "answerType"]) &&
    typeof candidate.questionType === "string" &&
    typeof candidate.answerType === "string" &&
    questionCategories.has(candidate.questionType) &&
    answerCategories.has(candidate.answerType);
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

function validMetadataReconciliation(field: ProfileFieldLearningRecordV2): boolean {
  const identity = field.fieldIdentity.slice("profile.".length);
  const guide = retainedProfileGuide.get(identity);
  if (guide !== undefined) {
    const matches = guideMetadataMatches(field, guide);
    return field.metadataReconciliation === (matches ? "matched" : "mismatch");
  }
  if (identity.startsWith("unknown.")) {
    return field.metadataReconciliation === "unresolved" &&
      field.binderStrategy === "opaque_machine_key" &&
      field.sanitizedLabelSha256 === null && field.questionCategory === "unknown" &&
      field.answerCategory === "unknown" && field.optionCatalogState === "unknown" &&
      field.visibleOptionIds.length === 0 && field.selectedOptionId === null;
  }
  const repeatable = /^profile\.(experience|education|skills|websites)\.[1-9][0-9]{0,2}\./u
    .test(field.fieldIdentity);
  return repeatable && field.metadataReconciliation === "matched" &&
    field.binderStrategy === "catalog_selector_exact" &&
    field.sanitizedLabelSha256 === null;
}

function guideMetadataMatches(
  field: Pick<ProfileFieldLearningRecordV2,
    "binderStrategy" | "sanitizedLabelSha256" | "questionCategory" | "answerCategory" |
    "uiType" | "uiVariant" | "required" | "optionCatalogState" | "visibleOptionIds">,
  guide: (typeof retainedProfileControlGuide)[number],
): boolean {
  const expectedOptions = guide.allowedOptions.map((value) =>
    `option_sha256_${retainedProfileTextSha256(value)}`
  );
  const optionsMatch = expectedOptions.length === 0 || !isChoiceType(field.uiType) || (
    field.optionCatalogState === "observed" &&
    JSON.stringify(field.visibleOptionIds) === JSON.stringify(expectedOptions)
  );
  return field.binderStrategy === "catalog_selector_exact" &&
    field.sanitizedLabelSha256 === retainedProfileTextSha256(guide.sanitizedLabel) &&
    field.questionCategory === guide.normalizedQuestionType &&
    field.answerCategory === guide.answerType &&
    guideBehaviorMatches(guide.behavior, field.uiType, field.uiVariant) &&
    field.uiVariant === guide.uiVariant &&
    (guide.required === null || field.required === guide.required) && optionsMatch;
}

function guideBehaviorMatches(
  expected: (typeof retainedProfileControlGuide)[number]["behavior"],
  observed: string,
  variant: string,
): boolean {
  return expected === observed || expected === "radio" && observed === "radio_group" ||
    expected === "text" && observed === "phone" && variant === "workday_phone_v2";
}

function isChoiceType(value: string): boolean {
  return value === "search_select" || value === "select" ||
    value === "multi_select" || value === "radio_group";
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
  planBinding: ObservedPlanBinding | null;
  required: boolean;
  answerState: "answered" | "unset";
  lane: AnswerProvenanceLane | null;
  binderStrategy: ProfileFieldLearningRecordV2["binderStrategy"];
  sanitizedLabelSha256: string | null;
  metadataReconciliation: ProfileFieldLearningRecordV2["metadataReconciliation"];
  backingState: ProfileFieldLearningRecordV2["backingState"];
  validationState: ProfileFieldLearningRecordV2["validationState"];
  optionCatalogState: ProfileFieldLearningRecordV2["optionCatalogState"];
  visibleOptionIds: readonly string[];
  selectedOptionId: string | null;
  optionMapping: string;
  prefillDisposition: string;
  driverAttempt: string;
  observationBinding: ProfileFieldLearningRecordV2["observationBinding"];
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

type MetadataRecord = Pick<MutableRecord,
  "fieldIdentity" | "uiType" | "uiVariant" | "questionCategory" |
  "answerCategory" | "required" | "binderStrategy" |
  "sanitizedLabelSha256" | "optionCatalogState" | "visibleOptionIds"
>;

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
    if (visibleIdentities.has(identity)) {
      throw new TypeError("duplicate profile control binding denied");
    }
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
      const identity = `profile.${row.section}.${ordinal}.${control.fieldId}`;
      if (visibleIdentities.has(identity)) {
        throw new TypeError("duplicate profile control binding denied");
      }
      visibleIdentities.add(identity);
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
    const guide = retainedProfileGuide.get(control.fieldId);
    record = {
      fieldIdentity: identity,
      uiType: control.uiBehavior,
      uiVariant: control.uiVariant,
      questionCategory: guide?.normalizedQuestionType ?? plan?.questionType ?? "unknown",
      answerCategory: guide?.answerType ?? plan?.answerType ?? "unknown",
      planBinding: plan === undefined ? null : planBindingFromPlan(plan),
      required: control.required,
      answerState,
      lane: plan?.answer.kind === "answered" ? plan.answer.lane : null,
      binderStrategy: null,
      sanitizedLabelSha256: null,
      metadataReconciliation: "pending",
      backingState: "unknown",
      validationState: "unknown",
      optionCatalogState: isChoiceType(control.uiBehavior) ? "unknown" : "not_applicable",
      visibleOptionIds: [],
      selectedOptionId: null,
      optionMapping: optionMapping(plan),
      prefillDisposition: prefillDisposition(plan, control.readback),
      driverAttempt: "none",
      observationBinding: null,
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

function snapshotControls(snapshot: ProfilePageSnapshot): readonly ProfileControlSnapshot[] {
  return [
    ...snapshot.controls,
    ...snapshot.rows.flatMap(({ controls }) => controls),
  ];
}

function applyControlObservation(
  record: MutableRecord,
  control: ProfileControlSnapshot,
  plan: ProfileFieldPlan | undefined,
  observed: {
    readonly observation: ProfileControlObservation;
    readonly binding: NonNullable<ProfileFieldLearningRecordV2["observationBinding"]>;
  },
): void {
  if (observed.observation.controlId !== control.controlId ||
      !isObservationBinding(observed.binding)) {
    throw new TypeError("profile control observation binding mismatch");
  }
  record.binderStrategy = observed.observation.binderStrategy;
  record.backingState = observed.observation.backingState;
  record.validationState = observed.observation.validationState;
  record.optionCatalogState = observed.observation.optionCatalogState;
  record.observationBinding = Object.freeze({ ...observed.binding });
  const guide = retainedProfileGuide.get(control.fieldId);
  if (guide === undefined && control.fieldId.startsWith("unknown.")) {
    record.sanitizedLabelSha256 = null;
    record.visibleOptionIds = Object.freeze([]);
    record.selectedOptionId = null;
    record.optionCatalogState = "unknown";
    record.metadataReconciliation = "unresolved";
    return;
  }
  if (guide === undefined) {
    record.sanitizedLabelSha256 = null;
    record.visibleOptionIds = observed.observation.visibleOptionIds;
    record.selectedOptionId = observed.observation.selectedOptionId;
    record.metadataReconciliation = record.binderStrategy === "catalog_selector_exact" &&
        plan !== undefined && plan.questionType === record.questionCategory &&
        plan.answerType === record.answerCategory
      ? "matched"
      : "mismatch";
    return;
  }
  record.sanitizedLabelSha256 = observed.observation.sanitizedLabelSha256;
  record.visibleOptionIds = observed.observation.visibleOptionIds;
  record.selectedOptionId = observed.observation.selectedOptionId;
  record.metadataReconciliation = guideMetadataMatches(record, guide) &&
      planMatchesGuide(plan, guide)
    ? "matched"
    : "mismatch";
}

function planMatchesGuide(
  plan: ProfileFieldPlan | undefined,
  guide: (typeof retainedProfileControlGuide)[number],
): boolean {
  return planBindingMatchesGuide(plan, guide);
}

function planBindingMatchesGuide(
  plan: ProfileFieldPlan | ObservedPlanBinding | null | undefined,
  guide: (typeof retainedProfileControlGuide)[number],
): boolean {
  if (plan === undefined || plan === null) return true;
  const answerMatches = plan.answerType === guide.answerType ||
    plan.answerType === "option" && guide.answerType === "single_select" ||
    plan.answerType === "phone" && guide.answerType === "text";
  return plan.questionType === guide.normalizedQuestionType && answerMatches;
}

function planBindingFromPlan(plan: ProfileFieldPlan): ObservedPlanBinding {
  return Object.freeze({
    questionType: plan.questionType,
    answerType: plan.answerType,
  });
}

function applyInteraction(
  record: MutableRecord | undefined,
  interaction: ProfileInteractionSnapshot | undefined,
  expectedValue: string,
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
    if (record.optionCatalogState === "observed" &&
        interaction.visibleOptionCount !== record.visibleOptionIds.length) {
      record.metadataReconciliation = "mismatch";
    }
    const expectedId = `option_sha256_${retainedProfileTextSha256(expectedValue)}`;
    record.selectedOptionId = record.visibleOptionIds.includes(expectedId) ? expectedId : null;
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
  const planBinding = value.metadataReconciliation === "mismatch"
    ? value.planBinding
    : undefined;
  return Object.freeze({
    fieldIdentity: value.fieldIdentity,
    uiType: value.uiType,
    uiVariant: value.uiVariant,
    questionCategory: value.questionCategory,
    answerCategory: value.answerCategory,
    ...(planBinding === undefined || planBinding === null ? (planBinding === null ? { planBinding: null } : {}) : {
      planBinding: Object.freeze({ ...planBinding }),
    }),
    required: value.required,
    answerState: value.answerState,
    lane: value.lane,
    binderStrategy: value.binderStrategy,
    sanitizedLabelSha256: value.sanitizedLabelSha256,
    metadataReconciliation: value.metadataReconciliation,
    backingState: value.backingState,
    validationState: value.validationState,
    optionCatalogState: value.optionCatalogState,
    observationBinding: value.observationBinding === null
      ? null
      : Object.freeze({ ...value.observationBinding }),
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
  if (
    field.metadataReconciliation !== "matched" ||
    field.binderStrategy !== "catalog_selector_exact" ||
    field.backingState === "unknown" || field.validationState !== "clear" ||
    !isObservationBinding(field.observationBinding)
  ) return false;
  if (field.answerState === "unset") {
    return !field.required && field.lane === null && field.monitorBinding === null &&
      field.terminalDisposition === "optional_unset";
  }
  return field.lane === "live_owner_fact" &&
    (field.terminalDisposition === "verified" ||
      field.terminalDisposition === "verified_without_mutation") &&
    (field.terminalDisposition === "verified"
      ? isMutationBinding(field.monitorBinding)
      : field.monitorBinding === null);
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
  value: ProfileFieldLearningRecordV2["observationBinding"],
): value is NonNullable<ProfileFieldLearningRecordV2["observationBinding"]> {
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
