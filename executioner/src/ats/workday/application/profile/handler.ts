import {
  profileOwnerInputCatalog,
  retainedProfileControlGuide,
  profileRepeatableCatalog,
  profileScalarControlCatalog,
} from "./catalog.ts";
import type {
  ProfileCommitRequest,
  ProfileControlSnapshot,
  CommittedProfileField,
  ProfileFieldPlan,
  ProfilePageCompletionResult,
  ProfilePagePlan,
  ProfilePageSnapshot,
  ProfileInteractionSnapshot,
  ProfileRepeatableSection,
  ProfileRowSnapshot,
  VerifiedProfileField,
  WorkdayProfilePagePort,
} from "./types.ts";
import { profileLearningConversionFromFailure } from "./types.ts";
import {
  profileInspectionDiagnostic,
  profileInspectionFailureFromError,
} from "./inspection.ts";
import { answerLaneAdmitted } from "../../../../form/answers/application-types.ts";
import { generateSyntheticTextValue } from "../../../../deterministic/synthetic-value.ts";
import type { AnswerFallbackPolicy } from
  "../../../../contracts/application-execution-policy.ts";
import { boundedOptionalSkillFacts } from "./site-answer-routing.ts";
import {
  evaluateSharedUiState,
  sharedUiKnownSemanticAliasMatches,
  sharedUiTypeForBehavior,
  sharedUiUsesDerivedBacking,
  sharedUiValueMatches,
} from "../../../../deterministic/ui-state-model.ts";

const reviewedVariants = new Set([
  "workday_text_v1",
  "workday_text_v2",
  "workday_checkbox_v2",
  "workday_phone_v1",
  "workday_phone_v2",
  "workday_date_v1",
  "workday_month_v1",
  "workday_year_v1",
  "workday_number_v1",
  "workday_textarea_v1",
  "workday_select_v1",
  "workday_multi_select_v1",
  "workday_search_select_v1",
  "workday_search_select_v2",
  "workday_source_select_v1",
  "workday_previous_worker_radio_v1",
  "workday_unknown_required_v1",
]);
const answerProvenances = new Set([
  "owner_provided",
  "resume_verified",
  "configured_template",
  "generated_default",
  "journey_derived",
]);
const pageTypes = new Set(["profile", "contact"]);
const questionTypes = new Set([
  "identity",
  "address",
  "phone",
  "application_source",
  "prior_employment",
  "employment",
  "experience",
  "education",
  "skill",
  "language",
  "website",
  "social_network",
  "unknown",
]);
const answerTypes = new Set([
  "text", "phone", "date", "month", "year", "number", "url", "boolean",
  "option", "single_select", "multi_select", "file",
]);
const repeatableSections = new Set(["experience", "education", "skills", "websites"]);
const optionalOwnerInputIds = new Set(
  profileOwnerInputCatalog.map(({ fieldId }) => fieldId),
);

type BlockedResult = Extract<
  ProfilePageCompletionResult,
  { readonly kind: "blocked" }
>;

const blocked = (
  code: BlockedResult["code"],
  detail: {
    readonly fieldId?: string;
    readonly uiBehavior?: ProfileControlSnapshot["uiBehavior"];
    readonly uiVariant?: string;
    readonly metadataReconciliationFailure?: BlockedResult["metadataReconciliationFailure"];
    readonly learningConversion?: BlockedResult["learningConversion"];
  } = {},
): BlockedResult => ({ kind: "blocked", code, ...detail });

const portFailure = (
  signal: AbortSignal,
  detail: {
    readonly fieldId?: string;
    readonly profileInspectionDiagnostic?: BlockedResult["profileInspectionDiagnostic"];
  } = {},
): BlockedResult => signal.aborted
  ? blocked("operation_cancelled")
  : blocked("profile_port_unavailable", detail);

export async function completeWorkdayProfilePage(
  plan: ProfilePagePlan,
  page: WorkdayProfilePagePort,
  signal: AbortSignal,
  answerFallbackPolicy: AnswerFallbackPolicy = plan.mode === "synthetic_test_non_submittable"
    ? "deterministic_site_valid_editable"
    : "owner_facts_only",
): Promise<ProfilePageCompletionResult> {
  if (signal.aborted) return blocked("operation_cancelled");
  const observed = await inspect(page, signal);
  if (observed.metadataReconciliationFailure !== undefined) {
    return blocked("profile_metadata_reconciliation_failed", {
      metadataReconciliationFailure: observed.metadataReconciliationFailure,
      learningConversion: profileLearningConversionFromFailure(
        observed.metadataReconciliationFailure,
      ),
    });
  }
  if (observed.snapshot === undefined) {
    return portFailure(signal, {
      profileInspectionDiagnostic: observed.profileInspectionDiagnostic,
    });
  }
  const syntheticFallbacks = new Map<string, ProfileFieldPlan>();
  const fallbackEnabled = answerFallbackPolicy === "deterministic_site_valid_editable";
  const executionPlan = fallbackEnabled && plan.mode === "live"
    ? Object.freeze({ ...plan, mode: "synthetic_test_non_submittable" as const })
    : plan;
  const preparedPlan = fallbackEnabled
    ? withSupportedSyntheticUnknowns(executionPlan, observed.snapshot, syntheticFallbacks)
    : executionPlan;
  registerGeneratedFields(plan, preparedPlan, page);
  const preflight = validatePlan(preparedPlan) ?? preflightSnapshot(preparedPlan, observed.snapshot);
  if (preflight !== undefined) return preflight;
  let snapshot = observed.snapshot;
  let effectivePlan = routeSiteAnswers(preparedPlan, snapshot);
  const routedPreflight = validatePlan(effectivePlan) ??
    preflightSnapshot(effectivePlan, snapshot);
  if (routedPreflight !== undefined) return routedPreflight;

  const cleaned = await cleanOwnedRows(snapshot, page, signal);
  if (cleaned === undefined) return portFailure(signal);
  const cleanedPreflight = preflightSnapshot(effectivePlan, cleaned);
  if (cleanedPreflight !== undefined) return cleanedPreflight;
  snapshot = cleaned;

  const verified: VerifiedProfileField[] = [];
  for (const repeatable of effectivePlan.repeatables) {
    if (
      snapshot.repeatableSections !== undefined &&
      !snapshot.repeatableSections.includes(repeatable.section)
    ) continue;
    const result = await reconcileSection(
      effectivePlan,
      repeatable.section,
      repeatable.rows,
      snapshot,
      page,
      signal,
    );
    if (result.kind === "blocked") return result;
    verified.push(...result.fields);
    snapshot = result.snapshot;
  }

  // Reconcile row-shaped employment and education state before optional
  // page-level controls such as Skills and LinkedIn. A tenant-specific
  // optional widget can then fail closed without preventing the required
  // repeatable rows from being learned and verified first.
  for (const plannedItem of effectivePlan.fields) {
    if (plannedItem.answer.kind === "profile_answer_missing") continue;
    const matches = snapshot.controls.filter(({ fieldId }) => fieldId === plannedItem.fieldId);
    if (matches.length === 0) continue;
    const current = matches.length === 1 ? matches[0] : undefined;
    const item = plannedItem;
    if (
      current?.required === false &&
      item.answerType === "multi_select" &&
      current.readback !== null &&
      normalize(current.readback) !== "" &&
      !readbackMatches(item, current.readback, visibleValue(item))
    ) continue;
    const result = await reconcileField(
      item,
      () => page.inspect(signal).then(({ controls }) => controls),
      page,
      signal,
      effectivePlan.mode === "synthetic_test_non_submittable" &&
          plannedItem.fieldId.startsWith("unknown.required.")
        ? (control) => {
            const rebound = syntheticProfileField(
              control,
              syntheticFallbacks,
              `scalar\u0000${plannedItem.fieldId}`,
            );
            if (rebound !== undefined) page.registerSyntheticField?.(rebound);
            return rebound;
          }
        : undefined,
    );
    if (result.kind === "blocked") {
      const control = snapshot.controls.find(({ fieldId }) => fieldId === item.fieldId);
      if (
        control?.required === false &&
        (result.code === "profile_port_unavailable" ||
          result.code === "profile_commit_unverified")
      ) {
        const refreshed = await inspectAndPreflight(effectivePlan, page, signal);
        if (refreshed.kind === "blocked") return refreshed;
        snapshot = refreshed.snapshot;
        continue;
      }
      return result;
    }
    verified.push(result.field);
    const refreshed = await inspectAndPreflight(effectivePlan, page, signal);
    if (refreshed.kind === "blocked") return refreshed;
    snapshot = refreshed.snapshot;
  }

  if (effectivePlan.mode === "synthetic_test_non_submittable") {
    const synthetic = await reconcileSupportedSyntheticUnknowns(
      effectivePlan,
      snapshot,
      verified,
      page,
      signal,
      syntheticFallbacks,
    );
    if (synthetic.kind === "blocked") return synthetic;
    snapshot = synthetic.snapshot;
    effectivePlan = withGeneratedSyntheticFields(effectivePlan, synthetic.generatedFields);
  }

  const final = await inspectAndPreflight(effectivePlan, page, signal);
  if (final.kind === "blocked") return final;
  if (ownedDuplicateCount(final.snapshot.rows) !== 0) {
    return blocked("profile_row_unverified");
  }
  return {
    kind: "verified",
    pageType: plan.pageType,
    verifiedFields: Object.freeze(verified),
    effectivePlan,
    committedFields: committedProfileFields(effectivePlan, final.snapshot, verified),
    ownedDuplicateRows: 0,
  };
}

function committedProfileFields(
  plan: ProfilePagePlan,
  snapshot: ProfilePageSnapshot,
  verified: readonly VerifiedProfileField[],
): readonly CommittedProfileField[] {
  const rowKeys = repeatableRowKeys(plan, snapshot.rows);
  return Object.freeze(verified.flatMap((field) => {
    const planned = field.rowKey === undefined
      ? plan.fields.filter((candidate) => candidate.fieldId === field.fieldId)
      : plan.repeatables.flatMap(({ rows }) => rows)
        .filter(({ rowKey }) => rowKey === field.rowKey)
        .flatMap(({ fields }) => fields)
        .filter((candidate) => candidate.fieldId === field.fieldId);
    const item = planned[0];
    if (planned.length !== 1 || item === undefined || item.answer.kind !== "answered" ||
        item.answer.lane !== "synthetic_test_default") return [];
    const controls = field.rowKey === undefined
      ? snapshot.controls.filter((control) => control.fieldId === field.fieldId)
      : snapshot.rows.filter(({ rowId }) => rowKeys.get(rowId) === field.rowKey)
        .flatMap(({ controls }) => controls)
        .filter((control) => control.fieldId === field.fieldId);
    const control = controls[0];
    if (controls.length !== 1 || control === undefined || control.readback === null) {
      throw new TypeError("profile committed readback unavailable");
    }
    const answer = item.answer;
    const committedReadback = control.readback;
    return [Object.freeze({
      ...field,
      label: control.label ?? field.fieldId,
      required: control.required,
      committedReadback,
      allowedOptions: Object.freeze([...(control.allowedOptions ?? item.allowedOptions)]),
      constraints: control.constraints === undefined ? null : Object.freeze({ ...control.constraints }),
      synthetic: answer.lane === "synthetic_test_default",
    })];
  }));
}

function preflightRequiredControls(
  plan: ProfilePagePlan,
  snapshot: ProfilePageSnapshot,
): BlockedResult | undefined {
  const deniedLane = [
    ...plan.fields,
    ...plan.repeatables.flatMap(({ rows }) => rows.flatMap(({ fields }) => fields)),
  ].find(({ answer }) =>
    answer.kind === "answered" && !answerLaneAdmitted(plan.mode, answer.lane)
  );
  if (deniedLane !== undefined) {
    return blocked("profile_answer_provenance_denied", { fieldId: deniedLane.fieldId });
  }
  const admittedScalarIds = new Set([
    ...profileScalarControlCatalog.map(({ fieldId }) => fieldId),
    ...profileRepeatableCatalog.flatMap(({ fields }) =>
      fields.map(({ fieldId }) => fieldId)
    ),
  ]);
  const plannedScalar = new Map(plan.fields.map((field) => [field.fieldId, field]));
  const unknownScalar = snapshot.controls.find(({ fieldId, required }) =>
    required && !admittedScalarIds.has(fieldId) && !(
      plan.mode === "synthetic_test_non_submittable" && (
        plannedScalar.has(fieldId) ||
        syntheticProfileField(snapshot.controls.find((item) => item.fieldId === fieldId)!) !== undefined
      )
    )
  );
  if (unknownScalar !== undefined) {
    return blocked(plan.mode === "synthetic_test_non_submittable"
      ? syntheticProfileBlockCode(unknownScalar)
      : "answer_type_unknown", {
      fieldId: unknownScalar.fieldId,
      uiBehavior: unknownScalar.uiBehavior,
      uiVariant: unknownScalar.uiVariant,
    });
  }

  const unsafeProtectedScalar = plan.mode === "live"
    ? snapshot.controls.find(({ fieldId }) => {
    const field = plannedScalar.get(fieldId);
    return field?.questionType === "prior_employment" &&
      field.answer.kind === "answered" &&
      field.answer.provenance !== "owner_provided";
    })
    : undefined;
  if (unsafeProtectedScalar !== undefined) {
    return blocked("profile_answer_missing", { fieldId: unsafeProtectedScalar.fieldId });
  }
  const unplannedScalar = snapshot.controls.find(({ fieldId, required }) =>
    required && !plannedScalar.has(fieldId) && !(
      plan.mode === "synthetic_test_non_submittable" &&
      syntheticProfileField(snapshot.controls.find((item) => item.fieldId === fieldId)!) !== undefined
    )
  );
  if (unplannedScalar !== undefined) {
    return blocked("profile_answer_missing", { fieldId: unplannedScalar.fieldId });
  }
  const unresolvedScalar = snapshot.controls.find(({ fieldId, required }) =>
    required && plannedScalar.get(fieldId)?.answer.kind === "profile_answer_missing"
  );
  if (unresolvedScalar !== undefined) {
    return blocked("profile_answer_missing", { fieldId: unresolvedScalar.fieldId });
  }

  for (const catalog of profileRepeatableCatalog) {
    const visibleRows = snapshot.rows.filter(({ section }) =>
      section === catalog.section
    );
    const admittedIds = new Set(catalog.fields.map(({ fieldId }) => fieldId));
    const unknownRepeatable = visibleRows
      .flatMap(({ controls }) => controls)
      .find((control) => control.required && !admittedIds.has(control.fieldId) && !(
        plan.mode === "synthetic_test_non_submittable" &&
        syntheticProfileField(control) !== undefined
      ));
    if (unknownRepeatable !== undefined) {
      return blocked(plan.mode === "synthetic_test_non_submittable"
        ? syntheticProfileBlockCode(unknownRepeatable)
        : "answer_type_unknown", {
        fieldId: unknownRepeatable.fieldId,
        uiBehavior: unknownRepeatable.uiBehavior,
        uiVariant: unknownRepeatable.uiVariant,
      });
    }

    const repeatable = plan.repeatables.find(({ section }) =>
      section === catalog.section
    );
    if (repeatable === undefined) continue;
    const removed = ownedRowsToRemove(snapshot.rows);
    const candidates = visibleRows.filter(({ rowId }) => !removed.has(rowId));
    const used = new Set<string>();
    for (const desired of repeatable.rows) {
      const current = selectRepeatableRow(
        candidates,
        catalog.section,
        used,
        desired.fields,
      );
      if (current === undefined) continue;
      used.add(current.rowId);
      const planned = new Set(desired.fields.map(({ fieldId }) => fieldId));
      const missing = current.controls.find(({ fieldId, required }) =>
        required && !planned.has(fieldId) && !(
          plan.mode === "synthetic_test_non_submittable" &&
          syntheticProfileField(current.controls.find((item) => item.fieldId === fieldId)!) !== undefined
        )
      );
      if (missing !== undefined) {
        return blocked("profile_answer_missing", { fieldId: missing.fieldId });
      }
    }
  }
  return undefined;
}

function withSupportedSyntheticUnknowns(
  plan: ProfilePagePlan,
  snapshot: ProfilePageSnapshot,
  fallbacks: Map<string, ProfileFieldPlan>,
): ProfilePagePlan {
  const controls = new Map(snapshot.controls.map((control) => [control.fieldId, control]));
  const prepared = plan.fields.map((field): ProfileFieldPlan => {
    if (field.answer.kind !== "profile_answer_missing") return field;
    const control = controls.get(field.fieldId);
    return control === undefined
      ? field
      : syntheticProfileField(control, fallbacks, `scalar\u0000${field.fieldId}`, field) ?? field;
  });
  const planned = new Set(prepared.map(({ fieldId }) => fieldId));
  const generated = snapshot.controls.flatMap((control): ProfileFieldPlan[] => {
    if (planned.has(control.fieldId)) return [];
    const guide = retainedProfileControlGuide.find(({ identity }) => identity === control.fieldId);
    if (guide === undefined && (!control.required ||
        !control.fieldId.startsWith("unknown.required."))) return [];
    const template = guide === undefined ? undefined : Object.freeze({
      fieldId: control.fieldId,
      questionType: guide.normalizedQuestionType,
      answerType: syntheticProfileAnswerType(control.uiBehavior, guide.answerType) ?? guide.answerType,
      allowedOptions: Object.freeze([...(control.allowedOptions ?? guide.allowedOptions)]),
      answer: Object.freeze({ kind: "profile_answer_missing" as const }),
    });
    const field = syntheticProfileField(
      control,
      fallbacks,
      `scalar\u0000${control.fieldId}`,
      template,
    );
    return field === undefined ? [] : [field];
  });
  const changed = prepared.some((field, index) => field !== plan.fields[index]);
  return generated.length === 0 && !changed ? plan : {
    ...plan,
    fields: Object.freeze([...prepared, ...generated]),
  };
}

function syntheticProfileField(
  control: ProfileControlSnapshot,
  fallbacks: Map<string, ProfileFieldPlan> = new Map(),
  slot = control.fieldId,
  template?: ProfileFieldPlan,
): ProfileFieldPlan | undefined {
  const unknownRequired = control.required && control.fieldId.startsWith("unknown.required.");
  if (!unknownRequired && (template === undefined ||
      template.answer.kind !== "profile_answer_missing")) return undefined;
  const options = [...control.allowedOptions ?? []].filter((value) => normalize(value) !== "");
  const prior = fallbacks.get(slot);
  if (prior?.answer.kind === "answered") {
    const selected = syntheticProfileSelectedValues(prior.answer.value);
    if (selected.length === 0 || selected.every((value) =>
      options.some((option) => normalize(option) === normalize(value))
    )) return prior;
  }
  const committed = control.readback === null
    ? undefined
    : syntheticProfileSelectedValues(control.readback).find((value) =>
      options.some((option) => normalize(option) === normalize(value))
    );
  const choice = committed ?? syntheticProfileOption(control.fieldId, options);
  const answerType = syntheticProfileAnswerType(control.uiBehavior, template?.answerType);
  const answer = syntheticProfileValue(control, choice, answerType);
  if (answer === undefined || answerType === undefined) return undefined;
  const field = Object.freeze({
    fieldId: control.fieldId,
    questionType: template?.questionType ?? "unknown" as const,
    answerType,
    allowedOptions: Object.freeze(options),
    answer: Object.freeze({
      kind: "answered" as const,
      value: control.uiBehavior === "multi_select" ? JSON.stringify([answer]) : answer,
      provenance: "generated_default" as const,
      lane: "synthetic_test_default" as const,
    }),
    ...(choice === undefined ? {} : {
      optionMapping: Object.freeze({
        canonicalValue: answerType === "multi_select" ? JSON.stringify([choice]) : choice,
        visibleOption: choice,
        provenance: "visible_option" as const,
      }),
    }),
  });
  fallbacks.set(slot, field);
  return field;
}

function registerGeneratedFields(
  original: ProfilePagePlan,
  prepared: ProfilePagePlan,
  page: WorkdayProfilePagePort,
): void {
  const originalAnsweredIds = new Set([
    ...original.fields,
    ...original.repeatables.flatMap(({ rows }) => rows.flatMap(({ fields }) => fields)),
  ].filter(({ answer }) => answer.kind === "answered").map(({ fieldId }) => fieldId));
  for (const field of prepared.fields) {
    if (!originalAnsweredIds.has(field.fieldId) && field.answer.kind === "answered") {
      page.registerSyntheticField?.(field);
    }
  }
}

async function reconcileSupportedSyntheticUnknowns(
  plan: ProfilePagePlan,
  initial: ProfilePageSnapshot,
  verified: VerifiedProfileField[],
  page: WorkdayProfilePagePort,
  signal: AbortSignal,
  fallbacks: Map<string, ProfileFieldPlan>,
): Promise<
  | {
      readonly kind: "verified";
      readonly snapshot: ProfilePageSnapshot;
      readonly generatedFields: readonly {
        readonly field: ProfileFieldPlan;
        readonly rowKey?: string;
      }[];
    }
  | BlockedResult
> {
  let snapshot = initial;
  const generated = new Map<string, { field: ProfileFieldPlan; rowKey?: string }>();
  const completed = new Set(verified.map(({ fieldId, rowKey }) => `${rowKey ?? "scalar"}\u0000${fieldId}`));
  for (let pass = 0; pass < 16; pass += 1) {
    const rowKeys = repeatableRowKeys(plan, snapshot.rows);
    const candidates = [
      ...snapshot.controls.map((control) => ({
        control,
        rowId: undefined as string | undefined,
        rowKey: undefined as string | undefined,
      })),
      ...snapshot.rows.flatMap((row) => row.controls.map((control) => ({
        control,
        rowId: row.rowId,
        rowKey: rowKeys.get(row.rowId),
      }))),
    ].filter(({ control, rowId, rowKey }) =>
      control.required && control.fieldId.startsWith("unknown.required.") &&
      (rowId === undefined || rowKey !== undefined)
    );
    const pending = candidates.find(({ control, rowKey }) =>
      !completed.has(`${rowKey ?? "scalar"}\u0000${control.fieldId}`)
    );
    if (pending === undefined) {
      return { kind: "verified", snapshot, generatedFields: Object.freeze([...generated.values()]) };
    }
    const fallbackKey = `${pending.rowKey ?? "scalar"}\u0000${pending.control.fieldId}`;
    const field = syntheticProfileField(pending.control, fallbacks, fallbackKey);
    if (field === undefined) {
      return blocked(syntheticProfileBlockCode(pending.control), {
        fieldId: pending.control.fieldId,
        uiBehavior: pending.control.uiBehavior,
        uiVariant: pending.control.uiVariant,
      });
    }
    generated.set(fallbackKey, pending.rowKey === undefined
      ? { field }
      : { field, rowKey: pending.rowKey });
    page.registerSyntheticField?.(field);
    const readControls = pending.rowId === undefined
      ? () => page.inspect(signal).then(({ controls }) => controls)
      : () => page.inspect(signal).then(({ rows }) =>
        rows.find(({ rowId }) => rowId === pending.rowId)?.controls ?? []
      );
    const result = await reconcileField(
      field,
      readControls,
      page,
      signal,
      (control) => {
        const rebound = syntheticProfileField(control, fallbacks, fallbackKey);
        if (rebound !== undefined) {
          generated.set(fallbackKey, pending.rowKey === undefined
            ? { field: rebound }
            : { field: rebound, rowKey: pending.rowKey });
          page.registerSyntheticField?.(rebound);
        }
        return rebound;
      },
    );
    if (result.kind === "blocked") return result;
    verified.push(pending.rowKey === undefined
      ? result.field
      : { ...result.field, rowKey: pending.rowKey });
    completed.add(`${pending.rowKey ?? "scalar"}\u0000${pending.control.fieldId}`);
    const refreshed = await inspect(page, signal);
    if (refreshed.snapshot === undefined) return portFailure(signal, {
      profileInspectionDiagnostic: refreshed.profileInspectionDiagnostic,
    });
    snapshot = refreshed.snapshot;
  }
  return blocked("profile_commit_unverified");
}

function withGeneratedSyntheticFields(
  plan: ProfilePagePlan,
  generated: readonly { readonly field: ProfileFieldPlan; readonly rowKey?: string }[],
): ProfilePagePlan {
  const scalars = generated.filter(({ rowKey }) => rowKey === undefined).map(({ field }) => field);
  const scalarIds = new Set(scalars.map(({ fieldId }) => fieldId));
  return Object.freeze({
    ...plan,
    fields: Object.freeze([
      ...plan.fields.filter(({ fieldId }) => !scalarIds.has(fieldId)),
      ...scalars,
    ]),
    repeatables: Object.freeze(plan.repeatables.map((repeatable) => Object.freeze({
      ...repeatable,
      rows: Object.freeze(repeatable.rows.map((row) => {
        const additions = generated.filter(({ rowKey }) => rowKey === row.rowKey)
          .map(({ field }) => field);
        const ids = new Set(additions.map(({ fieldId }) => fieldId));
        return Object.freeze({
          ...row,
          fields: Object.freeze([
            ...row.fields.filter(({ fieldId }) => !ids.has(fieldId)),
            ...additions,
          ]),
        });
      })),
    }))),
  });
}

function repeatableRowKeys(
  plan: ProfilePagePlan,
  rows: readonly ProfileRowSnapshot[],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const repeatable of plan.repeatables) {
    const used = new Set<string>();
    for (const desired of repeatable.rows) {
      const current = selectRepeatableRow(rows, repeatable.section, used, desired.fields);
      if (current === undefined) continue;
      used.add(current.rowId);
      result.set(current.rowId, desired.rowKey);
    }
  }
  return result;
}

function syntheticProfileAnswerType(
  behavior: ProfileControlSnapshot["uiBehavior"],
  requested?: ProfileFieldPlan["answerType"],
): ProfileFieldPlan["answerType"] | undefined {
  if (requested === "url" && (behavior === "url" || behavior === "text")) return "url";
  if (behavior === "text" || behavior === "textarea") return "text";
  if (behavior === "phone") return "phone";
  if (behavior === "date") return "date";
  if (behavior === "month") return "month";
  if (behavior === "year") return "year";
  if (behavior === "number") return "number";
  if (behavior === "url") return "url";
  if (behavior === "checkbox") return "boolean";
  if (behavior === "multi_select") return "multi_select";
  if (behavior === "file") return "file";
  if (behavior === "select") return "single_select";
  if (behavior === "search_select" || behavior === "radio_group") return "option";
  return undefined;
}

function syntheticProfileBlockCode(control: ProfileControlSnapshot): BlockedResult["code"] {
  if (syntheticProfileAnswerType(control.uiBehavior) === undefined) return "answer_type_unknown";
  if (["select", "search_select", "radio_group", "multi_select"].includes(control.uiBehavior) &&
      (control.allowedOptions?.length ?? 0) === 0) return "profile_ui_behavior_mismatch";
  return "profile_constraint_unsupported";
}

function syntheticProfileValue(
  control: ProfileControlSnapshot,
  choice: string | undefined,
  answerType = syntheticProfileAnswerType(control.uiBehavior),
): string | undefined {
  if (control.uiBehavior === "checkbox") {
    return control.fieldId === "identity.has_preferred_name" ? "false" : "true";
  }
  if (control.uiBehavior === "file") {
    const file = syntheticProfileFile(control);
    const name = file?.name;
    file?.bytes.fill(0);
    return name;
  }
  if (control.uiBehavior === "date") return control.readback ?? "2000-01-01";
  if (control.uiBehavior === "month") return control.readback ?? "1";
  if (control.uiBehavior === "year") return control.readback ?? "2000";
  if (["select", "search_select", "radio_group", "multi_select"].includes(control.uiBehavior)) {
    return choice;
  }
  if (control.readback !== null && normalize(control.readback) !== "") return control.readback;
  if (control.uiBehavior === "phone") return "5550100";
  if (control.fieldId === "social.facebook") {
    return "https://www.facebook.com/hunt.test.owner.review";
  }
  if (control.fieldId === "social.twitter") {
    return "https://twitter.com/hunt_test_26";
  }
  if (answerType === "url") return "https://example.invalid/owner-review";
  if (control.uiBehavior !== "text" && control.uiBehavior !== "textarea" &&
      control.uiBehavior !== "number" && control.uiBehavior !== "url") return undefined;
  const generated = generateSyntheticTextValue(control.constraints === undefined
    ? undefined
    : {
        inputType: control.constraints.inputType,
        min: control.constraints.min,
        max: control.constraints.max,
        step: control.constraints.step,
        minLength: control.constraints.minLength,
        maxLength: control.constraints.maxLength,
        pattern: control.constraints.pattern,
      });
  return generated.kind === "generated" ? generated.value : undefined;
}

function syntheticProfileOption(fieldId: string, options: readonly string[]): string | undefined {
  if (options.length === 0) return undefined;
  const preferred = fieldId === "employment.previously_worked_for_organization"
    ? [/^no$/iu]
    : fieldId === "source.how_did_you_hear"
    ? [/company.*website/iu, /career.*site/iu, /website/iu]
    : fieldId === "phone.device_type"
    ? [/mobile/iu, /cell/iu]
    : fieldId === "phone.country_code"
    ? [/united states.*\+?1/iu, /\+1.*united states/iu, /^\+?1$/u]
    : [];
  for (const pattern of preferred) {
    const match = options.find((option) => pattern.test(normalize(option)));
    if (match !== undefined) return match;
  }
  return [...options].sort((left, right) =>
    normalize(left).localeCompare(normalize(right), "en-US")
  )[0];
}

function syntheticProfileFile(control: ProfileControlSnapshot): {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
} | undefined {
  const accepted = control.constraints?.acceptedExtensions ?? [];
  const extension = accepted.length === 0 || accepted.includes(".pdf")
    ? ".pdf"
    : accepted.includes(".txt") ? ".txt" : undefined;
  if (extension === undefined) return undefined;
  const source = extension === ".pdf"
    ? "%PDF-1.1\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
    : "Synthetic test artifact. Owner value pending.\n";
  const bytes = new TextEncoder().encode(source);
  const maximum = control.constraints?.maxFileBytes;
  if (maximum !== null && maximum !== undefined && bytes.byteLength > maximum) {
    bytes.fill(0);
    return undefined;
  }
  return {
    name: `synthetic-owner-review${extension}`,
    mimeType: extension === ".pdf" ? "application/pdf" : "text/plain",
    bytes,
  };
}

function syntheticProfileSelectedValues(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed as string[];
    }
  } catch {}
  return normalize(value) === "" ? [] : [value];
}

function preflightSnapshot(
  plan: ProfilePagePlan,
  snapshot: ProfilePageSnapshot,
): BlockedResult | undefined {
  if (snapshot.pageType !== plan.pageType) return blocked("profile_page_mismatch");
  return preflightRequiredControls(plan, snapshot);
}

async function inspectAndPreflight(
  plan: ProfilePagePlan,
  page: WorkdayProfilePagePort,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "inspected"; readonly snapshot: ProfilePageSnapshot }
  | BlockedResult
> {
  const snapshot = await inspect(page, signal);
  if (snapshot.snapshot === undefined) {
    return portFailure(signal, {
      profileInspectionDiagnostic: snapshot.profileInspectionDiagnostic,
    });
  }
  const preflight = preflightSnapshot(plan, snapshot.snapshot);
  return preflight ?? { kind: "inspected", snapshot: snapshot.snapshot };
}

function validatePlan(plan: ProfilePagePlan): ProfilePageCompletionResult | undefined {
  if (
    !pageTypes.has(plan.pageType) ||
    !new Set(["live", "synthetic_test_non_submittable"]).has(plan.mode)
  ) return blocked("profile_plan_invalid");
  const fieldIds = new Set<string>();
  for (const item of plan.fields) {
    if (fieldIds.has(item.fieldId)) {
      return blocked("profile_plan_invalid", { fieldId: item.fieldId });
    }
    if (item.answer.kind === "profile_answer_missing") {
      if (
        !optionalOwnerInputIds.has(item.fieldId) ||
        !Array.isArray(item.allowedOptions) ||
        item.allowedOptions.some((value) => typeof value !== "string" || normalize(value) === "")
      ) {
        return blocked("profile_answer_missing", { fieldId: item.fieldId });
      }
      fieldIds.add(item.fieldId);
      continue;
    }
    if (!validField(item, plan.mode)) {
      return blocked("profile_plan_invalid", { fieldId: item.fieldId });
    }
    fieldIds.add(item.fieldId);
  }
  const sections = new Set<ProfileRepeatableSection>();
  for (const repeatable of plan.repeatables) {
    if (
      !repeatableSections.has(repeatable.section) ||
      sections.has(repeatable.section)
    ) return blocked("profile_plan_invalid");
    sections.add(repeatable.section);
    const rowKeys = new Set<string>();
    const fingerprints = new Set<string>();
    for (const row of repeatable.rows) {
      const missing = row.fields.find(({ answer }) =>
        answer.kind === "profile_answer_missing"
      );
      if (missing !== undefined) {
        return blocked("profile_answer_missing", { fieldId: missing.fieldId });
      }
      const fingerprint = desiredFingerprint(row.fields);
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(row.rowKey) ||
        rowKeys.has(row.rowKey) ||
        fingerprints.has(fingerprint) ||
        row.fields.length === 0 ||
        row.fields.some((item) => !validField(item, plan.mode))
      ) return blocked("profile_plan_invalid");
      rowKeys.add(row.rowKey);
      fingerprints.add(fingerprint);
    }
  }
  return undefined;
}

function validField(
  field: ProfileFieldPlan,
  mode: NonNullable<ProfilePagePlan["mode"]>,
): boolean {
  const allowedOptions = field.allowedOptions;
  const lane = field.answer.kind === "answered"
    ? field.answer.lane
    : "synthetic_test_default";
  if (
    !/^[a-z][a-z0-9_.-]{0,127}$/u.test(field.fieldId) ||
    !questionTypes.has(field.questionType) ||
    !answerTypes.has(field.answerType) ||
    field.answer.kind !== "answered" ||
    !answerProvenances.has(field.answer.provenance) ||
    normalize(field.answer.value) === "" ||
    allowedOptions.some((value) => typeof value !== "string" || normalize(value) === "") ||
    new Set(allowedOptions.map(normalize)).size !== allowedOptions.length ||
    (field.answer.provenance === "owner_provided" && lane !== "live_owner_fact") ||
    (field.answer.provenance === "generated_default" && lane !== "synthetic_test_default")
  ) return false;
  if (field.answerType === "date" && !validIsoDate(field.answer.value)) return false;
  if (field.answerType === "month" && !/^(?:0?[1-9]|1[0-2])$/u.test(field.answer.value)) return false;
  if (field.answerType === "year" && !/^\d{4}$/u.test(field.answer.value)) return false;
  if (field.answerType === "number" && !Number.isFinite(Number(field.answer.value))) return false;
  if (field.answerType === "url" && !/^https:\/\//u.test(field.answer.value)) return false;
  if (field.answerType === "multi_select" && optionList(field.answer.value) === undefined) {
    return false;
  }
  if (field.answerType === "phone" && field.answer.value.replace(/\D/gu, "").length < 7) {
    return false;
  }
  if (field.answerType === "boolean" &&
      field.answer.value !== "true" && field.answer.value !== "false") return false;
  return !new Set(["option", "single_select", "multi_select"]).has(field.answerType) || (
    field.optionMapping?.provenance === "visible_option" &&
    field.optionMapping.canonicalValue === field.answer.value &&
    normalize(field.optionMapping.visibleOption) !== ""
  );
}

function routeSiteAnswers(
  plan: ProfilePagePlan,
  snapshot: ProfilePageSnapshot,
): ProfilePagePlan {
  const canonicalPlan: ProfilePagePlan = {
    ...plan,
    fields: plan.fields.map((field) => boundedOptionalSkillFacts(canonicalSiteField(field), snapshot)),
    repeatables: plan.repeatables.map((repeatable) => ({
      ...repeatable,
      rows: repeatable.rows.map((row) => ({
        ...row,
        fields: row.fields.map(canonicalSiteField),
      })),
    })),
  };
  if (!snapshot.repeatableSections?.includes("websites")) return canonicalPlan;
  const visibleDedicated = new Set(snapshot.controls
    .filter(({ fieldId }) => isDedicatedSiteField(fieldId))
    .map(({ fieldId }) => fieldId));
  const dedicatedUrls = new Set(canonicalPlan.fields.flatMap((field) =>
    visibleDedicated.has(field.fieldId) && isSiteUrl(field)
      ? [normalize(visibleValue(field))]
      : []
  ));
  const website = canonicalPlan.repeatables.find(({ section }) => section === "websites");
  const routedRows = [...website?.rows ?? []].filter((row) => {
    const url = row.fields.find(({ fieldId }) => fieldId === "website.url");
    return url === undefined || !dedicatedUrls.has(normalize(visibleValue(url)));
  });
  const moved = canonicalPlan.fields.filter((field) =>
    isDedicatedSiteField(field.fieldId) && isSiteUrl(field) &&
    !visibleDedicated.has(field.fieldId)
  );
  for (const field of moved) {
    const url = normalize(visibleValue(field));
    if (routedRows.some((row) => row.fields.some((candidate) =>
      candidate.fieldId === "website.url" && normalize(visibleValue(candidate)) === url
    ))) continue;
    routedRows.push({
      rowKey: `website-route-${routedRows.length + 1}`,
      fields: [{
        ...field,
        fieldId: "website.url",
        questionType: "website",
      }],
    });
  }
  return {
    ...canonicalPlan,
    fields: canonicalPlan.fields.filter((field) =>
      !moved.some(({ fieldId }) => fieldId === field.fieldId)
    ),
    repeatables: [
      ...canonicalPlan.repeatables.filter(({ section }) => section !== "websites"),
      ...(routedRows.length === 0 ? [] : [{ section: "websites" as const, rows: routedRows }]),
    ],
  };
}

function canonicalSiteField(field: ProfileFieldPlan): ProfileFieldPlan {
  if (!isSiteUrl(field) || field.answer.kind !== "answered") return field;
  try {
    const url = new URL(field.answer.value);
    if (url.hostname.toLocaleLowerCase("en-US") !== "linkedin.com") return field;
    url.hostname = "www.linkedin.com";
    return { ...field, answer: { ...field.answer, value: url.href } };
  } catch {
    return field;
  }
}

function isDedicatedSiteField(fieldId: string): boolean {
  return fieldId === "social.linkedin" || fieldId === "social.github" ||
    fieldId === "website.portfolio";
}

function isSiteUrl(field: ProfileFieldPlan): boolean {
  return field.answerType === "url" && field.answer.kind === "answered";
}

async function cleanOwnedRows(
  initial: ProfilePageSnapshot,
  page: WorkdayProfilePagePort,
  signal: AbortSignal,
): Promise<ProfilePageSnapshot | undefined> {
  const remove = ownedRowsToRemove(initial.rows);
  try {
    for (const row of initial.rows) {
      if (!remove.has(row.rowId)) continue;
      if (signal.aborted) return undefined;
      await page.removeOwnedRow(row.section, row.rowId, signal);
    }
    return remove.size === 0 ? initial : await page.inspect(signal);
  } catch {
    return undefined;
  }
}

function ownedRowsToRemove(
  rows: readonly ProfileRowSnapshot[],
): ReadonlySet<string> {
  const remove = new Set<string>();
  const groups = new Map<string, ProfileRowSnapshot[]>();
  for (const row of rows) {
    const fingerprint = actualFingerprint(row.controls);
    if (fingerprint === "") {
      if (row.ownedByC3) remove.add(row.rowId);
      continue;
    }
    const matches = groups.get(`${row.section}:${fingerprint}`) ?? [];
    matches.push(row);
    groups.set(`${row.section}:${fingerprint}`, matches);
  }
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const foreign = rows.some(({ ownedByC3 }) => !ownedByC3);
    let keptOwned = false;
    for (const row of rows) {
      if (!row.ownedByC3) continue;
      if (foreign || keptOwned) remove.add(row.rowId);
      else keptOwned = true;
    }
  }
  return remove;
}

async function reconcileSection(
  plan: ProfilePagePlan,
  section: ProfileRepeatableSection,
  rows: readonly {
    readonly rowKey: string;
    readonly fields: readonly ProfileFieldPlan[];
  }[],
  initial: ProfilePageSnapshot,
  page: WorkdayProfilePagePort,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "verified"; readonly fields: readonly VerifiedProfileField[]; readonly snapshot: ProfilePageSnapshot }
  | Extract<ProfilePageCompletionResult, { readonly kind: "blocked" }>
> {
  let snapshot = initial;
  const used = new Set<string>();
  const verified: VerifiedProfileField[] = [];
  for (const desired of rows) {
    let current = selectRepeatableRow(snapshot.rows, section, used, desired.fields);
    if (current === undefined) {
      let rowId: string;
      try {
        rowId = await page.addOwnedRow(section, signal);
      } catch {
        return portFailure(signal);
      }
      const refreshed = await inspectAndPreflight(plan, page, signal);
      if (refreshed.kind === "blocked") return refreshed;
      snapshot = refreshed.snapshot;
      current = snapshot.rows.find((row) =>
        row.section === section && row.rowId === rowId && row.ownedByC3
      );
      if (current === undefined) return blocked("profile_row_unverified");
    }
    const planned = new Set(desired.fields.map(({ fieldId }) => fieldId));
    const unplannedRequired = current.controls.find((control) =>
      control.required && !planned.has(control.fieldId) && !(
        plan.mode === "synthetic_test_non_submittable" &&
        syntheticProfileField(control) !== undefined
      )
    );
    if (unplannedRequired !== undefined) {
      return blocked("profile_answer_missing", {
        fieldId: unplannedRequired.fieldId,
      });
    }
    used.add(current.rowId);
    for (const item of desired.fields) {
      const rowId: string = current.rowId;
      // Repeatable rows are one semantic record made from independent controls.
      // A tenant may omit an optional subfield (for example Location), and a
      // current-role checkbox may remove the end-date controls after commit.
      if (!current.controls.some(({ fieldId }) => fieldId === item.fieldId)) continue;
      const result = await reconcileField(
        item,
        async () => {
          const fresh = await page.inspect(signal);
          return fresh.rows.find((row) => row.rowId === rowId)?.controls ?? [];
        },
        page,
        signal,
      );
      if (result.kind === "blocked") {
        const control = current.controls.find(({ fieldId }) => fieldId === item.fieldId);
        if (
          control?.required === false &&
          (result.code === "profile_port_unavailable" ||
            result.code === "profile_commit_unverified")
        ) {
          const refreshed = await inspectAndPreflight(plan, page, signal);
          if (refreshed.kind === "blocked") return refreshed;
          snapshot = refreshed.snapshot;
          current = snapshot.rows.find((row) => row.rowId === rowId) ?? current;
          continue;
        }
        return result;
      }
      verified.push({ ...result.field, rowKey: desired.rowKey });
      const refreshed = await inspectAndPreflight(plan, page, signal);
      if (refreshed.kind === "blocked") return refreshed;
      snapshot = refreshed.snapshot;
      current = snapshot.rows.find((row) => row.rowId === rowId) ?? current;
    }
  }
  try {
    for (const row of snapshot.rows) {
      if (row.section !== section || !row.ownedByC3 || used.has(row.rowId)) continue;
      await page.removeOwnedRow(section, row.rowId, signal);
    }
  } catch {
    return portFailure(signal);
  }
  const refreshed = await inspectAndPreflight(plan, page, signal);
  if (refreshed.kind === "blocked") return refreshed;
  snapshot = refreshed.snapshot;
  return { kind: "verified", fields: verified, snapshot };
}

function selectRepeatableRow(
  rows: readonly ProfileRowSnapshot[],
  section: ProfileRepeatableSection,
  used: ReadonlySet<string>,
  desired: readonly ProfileFieldPlan[],
): ProfileRowSnapshot | undefined {
  return rows.find((row) =>
    row.section === section &&
    !used.has(row.rowId) &&
    rowMatches(row, desired)
  ) ?? rows.find((row) =>
    row.section === section && row.ownedByC3 && !used.has(row.rowId)
  ) ?? rows.find((row) =>
    row.section === section && !used.has(row.rowId) && actualFingerprint(row.controls) === ""
  );
}

async function reconcileField(
  field: ProfileFieldPlan,
  readControls: () => Promise<readonly ProfileControlSnapshot[]>,
  page: WorkdayProfilePagePort,
  signal: AbortSignal,
  replanSynthetic?: (control: ProfileControlSnapshot) => ProfileFieldPlan | undefined,
): Promise<
  | { readonly kind: "verified"; readonly field: VerifiedProfileField }
  | Extract<ProfilePageCompletionResult, { readonly kind: "blocked" }>
> {
  let reboundControls: readonly ProfileControlSnapshot[];
  try {
    reboundControls = await readControls();
  } catch {
    if (signal.aborted) return portFailure(signal, { fieldId: field.fieldId });
    try {
      reboundControls = await readControls();
    } catch {
      return portFailure(signal, { fieldId: field.fieldId });
    }
  }
  const matches = reboundControls.filter(({ fieldId }) => fieldId === field.fieldId);
  if (matches.length !== 1) {
    return blocked(
      matches.length === 0 ? "profile_control_missing" : "profile_control_ambiguous",
      { fieldId: field.fieldId },
    );
  }
  const control = matches[0]!;
  const replanned = replanSynthetic?.(control);
  if (replanSynthetic !== undefined && replanned === undefined) {
    return blocked(syntheticProfileBlockCode(control), {
      fieldId: control.fieldId,
      uiBehavior: control.uiBehavior,
      uiVariant: control.uiVariant,
    });
  }
  const effectiveField = replanned ?? field;
  if (!reviewedVariants.has(control.uiVariant)) {
    return blocked("profile_ui_variant_unreviewed", {
      fieldId: field.fieldId,
      uiVariant: control.uiVariant,
    });
  }
  if (!compatible(effectiveField, control)) {
    return blocked("profile_ui_behavior_mismatch", { fieldId: field.fieldId });
  }
  const expected = visibleValue(effectiveField);
  const sharedType = sharedUiTypeForBehavior(control.uiBehavior);
  const syntheticCommitProofRequired = effectiveField.answer.kind === "answered" &&
    effectiveField.answer.lane === "synthetic_test_default" &&
    !(sharedType !== undefined && sharedUiUsesDerivedBacking(
      sharedType,
      effectiveField.fieldId,
    ));
  if (syntheticCommitProofRequired ||
      !readbackMatches(effectiveField, control.readback, expected)) {
    const syntheticFile = control.uiBehavior === "file" &&
        effectiveField.answer.kind === "answered" &&
        effectiveField.answer.lane === "synthetic_test_default"
      ? syntheticProfileFile(control)
      : undefined;
    if (control.uiBehavior === "file" && syntheticFile === undefined) {
      return blocked("profile_constraint_unsupported", { fieldId: field.fieldId });
    }
    const request: ProfileCommitRequest = {
      controlId: control.controlId,
      uiBehavior: control.uiBehavior,
      value: expected,
      ...(syntheticFile === undefined ? {} : { syntheticFile }),
    };
    try {
      await page.commit(request, signal);
      let observed: readonly ProfileControlSnapshot[];
      try {
        observed = await readControls();
      } catch {
        if (signal.aborted) return portFailure(signal, { fieldId: field.fieldId });
        observed = await readControls();
      }
      const fresh = observed.filter(({ fieldId }) =>
        fieldId === effectiveField.fieldId
      );
      if (
        fresh.length !== 1 ||
        !readbackMatches(effectiveField, fresh[0]!.readback, expected) ||
        !(page.interaction === undefined || profileInteractionEligible(
          control,
          page.interaction(control.controlId),
          true,
        ))
      ) return blocked("profile_commit_unverified", { fieldId: field.fieldId });
    } catch {
      try {
        const rebound = (await readControls()).filter(({ fieldId }) => fieldId === effectiveField.fieldId);
        if (rebound.length === 1 && readbackMatches(effectiveField, rebound[0]!.readback, expected) &&
            (page.interaction === undefined || profileInteractionEligible(
              control, page.interaction(control.controlId), true,
            ))) {
          return verifiedProfileField(effectiveField, rebound[0]!);
        }
        if (rebound.length === 1 && rebound[0]!.readback === null && syntheticFile === undefined) {
          await page.commit(request, signal);
          const retried = (await readControls()).filter(({ fieldId }) => fieldId === effectiveField.fieldId);
          if (retried.length === 1 && readbackMatches(effectiveField, retried[0]!.readback, expected) &&
              (page.interaction === undefined || profileInteractionEligible(
                control, page.interaction(control.controlId), true,
              ))) {
            return verifiedProfileField(effectiveField, retried[0]!);
          }
        }
        return blocked("profile_effect_uncertain", { fieldId: field.fieldId });
      } catch {
        return portFailure(signal, { fieldId: field.fieldId });
      }
    } finally {
      syntheticFile?.bytes.fill(0);
    }
  }
  return verifiedProfileField(effectiveField, control);
}

function verifiedProfileField(
  field: ProfileFieldPlan,
  control: ProfileControlSnapshot,
): { readonly kind: "verified"; readonly field: VerifiedProfileField } {
  return {
    kind: "verified",
    field: {
      fieldId: field.fieldId,
      questionType: field.questionType,
      answerType: field.answerType,
      uiBehavior: control.uiBehavior,
      uiVariant: control.uiVariant,
      provenance: field.answer.kind === "answered"
        ? field.answer.provenance
        : "owner_provided",
      lane: field.answer.kind === "answered"
        ? field.answer.lane
        : "synthetic_test_default",
      ...(field.optionMapping === undefined
        ? {}
        : { optionMappingProvenance: field.optionMapping.provenance }),
    },
  };
}

function compatible(field: ProfileFieldPlan, control: ProfileControlSnapshot): boolean {
  return (
    (field.answerType === "text" && control.uiBehavior === "text") ||
    (field.answerType === "text" && control.uiBehavior === "textarea") ||
    (field.answerType === "phone" && control.uiBehavior === "phone") ||
    (field.answerType === "date" && control.uiBehavior === "date") ||
    (field.answerType === "month" && control.uiBehavior === "month") ||
    (field.answerType === "year" && control.uiBehavior === "year") ||
    (field.answerType === "number" && control.uiBehavior === "number") ||
    (field.answerType === "url" &&
      (control.uiBehavior === "url" || control.uiBehavior === "text")) ||
    (field.answerType === "boolean" && control.uiBehavior === "checkbox") ||
    (field.answerType === "option" &&
      (control.uiBehavior === "search_select" || control.uiBehavior === "radio_group")) ||
    (field.answerType === "single_select" && control.uiBehavior === "select") ||
    (field.answerType === "multi_select" && control.uiBehavior === "multi_select")
    || (field.answerType === "file" && control.uiBehavior === "file")
  );
}

function visibleValue(field: ProfileFieldPlan): string {
  if (field.answer.kind !== "answered") return "";
  if (field.answerType === "multi_select") return field.answer.value;
  return field.optionMapping?.visibleOption ?? field.answer.value;
}

function readbackMatches(
  field: ProfileFieldPlan,
  actual: string | null,
  expected: string,
): boolean {
  if (actual === null) return false;
  const aliasMatch = sharedUiKnownSemanticAliasMatches(field.fieldId, actual, expected);
  if (aliasMatch !== undefined) return aliasMatch;
  if (field.answerType === "phone") {
    return sharedUiValueMatches("phone", expected, actual);
  }
  if (field.answerType === "boolean") {
    return normalize(actual) === (expected === "true" ? "true" : "false");
  }
  if (field.answerType === "month") {
    return sharedUiValueMatches("month", expected, actual);
  }
  if (field.answerType === "multi_select") {
    const actualOptions = optionList(actual) ?? [actual];
    const expectedOptions = optionList(expected);
    return expectedOptions !== undefined && sharedUiValueMatches(
      "multi_select",
      JSON.stringify(expectedOptions),
      JSON.stringify(actualOptions),
    );
  }
  if (field.answerType === "option" || field.answerType === "single_select") {
    return equivalentOption(actual, expected);
  }
  return normalize(actual) === normalize(expected);
}

function profileInteractionEligible(
  control: ProfileControlSnapshot,
  interaction: ProfileInteractionSnapshot | undefined,
  remounted: boolean,
): boolean {
  if (interaction === undefined) return false;
  const type = sharedUiTypeForBehavior(control.uiBehavior);
  if (type === undefined) return false;
  return evaluateSharedUiState({
    type,
    ownerState: "exact",
    backingState: interaction.backingValueCommitted ? "committed" : "empty",
    stabilizationState: remounted ? "remounted_stable" : "stable",
    readbackState: interaction.backingValueCommitted ? "matches" : "empty",
    validationState: interaction.validationCleared ? "clear" : "invalid",
  }).navigationEligible;
}

function optionList(value: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) || parsed.length === 0 || parsed.length > 128 ||
      parsed.some((item) => typeof item !== "string" || normalize(item) === "")
    ) return undefined;
    const normalized = parsed.map((item) => normalize(item as string));
    return new Set(normalized).size === normalized.length ? parsed as string[] : undefined;
  } catch {
    return undefined;
  }
}

function sameNormalizedOptions(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const remaining = [...right];
  for (const value of left) {
    const index = remaining.findIndex((candidate) => equivalentOption(value, candidate));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

function equivalentOption(left: string, right: string): boolean {
  const pair = new Set([
    normalize(left).toLocaleLowerCase("en-US"),
    normalize(right).toLocaleLowerCase("en-US"),
  ]);
  return pair.size === 1 || (
    pair.size === 2 &&
    (
      pair.has("computer science") && pair.has("computer and information science") ||
      pair.has("linkedin") && pair.has("linkedin corporate page")
    )
  );
}

function rowMatches(row: ProfileRowSnapshot, desired: readonly ProfileFieldPlan[]): boolean {
  const identityIds = row.section === "experience"
    ? new Set(["experience.company", "experience.title"])
    : row.section === "education"
      ? new Set(["education.school", "education.degree"])
      : row.section === "skills"
        ? new Set(["skills.name"])
        : new Set(["website.url"]);
  const visibleIdentity = desired.flatMap((field) => {
    if (!identityIds.has(field.fieldId)) return [];
    const controls = row.controls.filter(({ fieldId }) => fieldId === field.fieldId);
    return controls.length === 1 ? [{ field, control: controls[0]! }] : [];
  });
  return visibleIdentity.length > 0 && visibleIdentity.every(({ field, control }) =>
    readbackMatches(field, control.readback, visibleValue(field))
  );
}

function desiredFingerprint(fields: readonly ProfileFieldPlan[]): string {
  return fields.map((field) => `${field.fieldId}:${normalize(visibleValue(field))}`)
    .sort()
    .join("|");
}

function actualFingerprint(controls: readonly ProfileControlSnapshot[]): string {
  return controls.filter(({ uiBehavior, readback }) =>
    readback !== null && normalize(readback) !== "" &&
    !(uiBehavior === "checkbox" && normalize(readback) === "false")
  )
    .map(({ fieldId, readback }) => `${fieldId}:${normalize(readback ?? "")}`)
    .sort()
    .join("|");
}

function ownedDuplicateCount(rows: readonly ProfileRowSnapshot[]): number {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const fingerprint = actualFingerprint(row.controls);
    if (fingerprint === "") continue;
    const key = `${row.section}:${fingerprint}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return rows.filter((row) => {
    const fingerprint = actualFingerprint(row.controls);
    return row.ownedByC3 &&
      fingerprint !== "" &&
      (counts.get(`${row.section}:${fingerprint}`) ?? 0) > 1;
  }).length;
}

async function inspect(
  page: WorkdayProfilePagePort,
  signal: AbortSignal,
): Promise<{
  readonly snapshot?: ProfilePageSnapshot;
  readonly profileInspectionDiagnostic?: BlockedResult["profileInspectionDiagnostic"];
  readonly metadataReconciliationFailure?: BlockedResult["metadataReconciliationFailure"];
}> {
  const started = Date.now();
  const deadlineMs = 5_000;
  const deadline = started + deadlineMs;
  let retryCount = 0;
  let lastError: unknown;
  while (true) {
    try {
      if (signal.aborted) return {};
      return { snapshot: await page.inspect(signal) };
    } catch (error) {
      lastError = error;
      retryCount += 1;
      const metadataReconciliationFailure = page.metadataReconciliationFailure?.();
      if (metadataReconciliationFailure !== undefined) {
        return { metadataReconciliationFailure };
      }
      if (signal.aborted || Date.now() >= deadline) {
        const deadlineOutcome = signal.aborted || Date.now() < deadline
          ? undefined
          : "deadline_exceeded_before_return" as const;
        const diagnostic = profileInspectionDiagnostic(
          lastError,
          page.inspectionFailure?.() ?? profileInspectionFailureFromError(lastError),
          retryCount,
          deadlineMs,
          Date.now() - started,
          deadlineOutcome,
          page.inspectionFacts?.(),
        );
        return {
          profileInspectionDiagnostic: Object.freeze({
            ...diagnostic,
            profilePortState: deadlineOutcome === undefined
              ? "unavailable" as const
              : "deadline_exceeded_before_return" as const,
          }),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function normalize(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
