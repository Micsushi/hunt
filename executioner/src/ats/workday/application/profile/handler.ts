import {
  profileOwnerInputCatalog,
  profileRepeatableCatalog,
  profileScalarControlCatalog,
} from "./catalog.ts";
import type {
  ProfileCommitRequest,
  ProfileControlSnapshot,
  ProfileFieldPlan,
  ProfilePageCompletionResult,
  ProfilePagePlan,
  ProfilePageSnapshot,
  ProfileRepeatableSection,
  ProfileRowSnapshot,
  VerifiedProfileField,
  WorkdayProfilePagePort,
} from "./types.ts";
import {
  profileInspectionDiagnostic,
  profileInspectionFailureFromError,
} from "./inspection.ts";
import { answerLaneAdmitted } from "../../../../form/answers/application-types.ts";

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
]);
const answerTypes = new Set([
  "text", "phone", "date", "month", "year", "number", "url", "boolean",
  "option", "single_select", "multi_select",
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
): Promise<ProfilePageCompletionResult> {
  if (signal.aborted) return blocked("operation_cancelled");
  const observed = await inspect(page, signal);
  if (observed.snapshot === undefined) {
    return portFailure(signal, {
      profileInspectionDiagnostic: observed.profileInspectionDiagnostic,
    });
  }
  const preflight = validatePlan(plan) ?? preflightSnapshot(plan, observed.snapshot);
  if (preflight !== undefined) return preflight;
  let snapshot = observed.snapshot;
  const effectivePlan = routeSiteAnswers(plan, snapshot);
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
  for (const item of effectivePlan.fields) {
    if (item.answer.kind === "profile_answer_missing") continue;
    if (!snapshot.controls.some(({ fieldId }) => fieldId === item.fieldId)) continue;
    const result = await reconcileField(
      item,
      () => page.inspect(signal).then(({ controls }) => controls),
      snapshot.controls,
      page,
      signal,
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

  const final = await inspectAndPreflight(effectivePlan, page, signal);
  if (final.kind === "blocked") return final;
  if (ownedDuplicateCount(final.snapshot.rows) !== 0) {
    return blocked("profile_row_unverified");
  }
  if (plan.mode === "synthetic_test_non_submittable") {
    return blocked("profile_answer_provenance_denied");
  }
  return {
    kind: "verified",
    pageType: plan.pageType,
    verifiedFields: verified,
    ownedDuplicateRows: 0,
  };
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
  const unknownScalar = snapshot.controls.find(({ fieldId, required }) =>
    required && !admittedScalarIds.has(fieldId)
  );
  if (unknownScalar !== undefined) {
    return blocked("answer_type_unknown", {
      fieldId: unknownScalar.fieldId,
      uiBehavior: unknownScalar.uiBehavior,
      uiVariant: unknownScalar.uiVariant,
    });
  }

  const plannedScalar = new Map(plan.fields.map((field) => [field.fieldId, field]));
  const unsafeProtectedScalar = snapshot.controls.find(({ fieldId }) => {
    const field = plannedScalar.get(fieldId);
    return field?.questionType === "prior_employment" &&
      field.answer.kind === "answered" &&
      field.answer.provenance !== "owner_provided";
  });
  if (unsafeProtectedScalar !== undefined) {
    return blocked("profile_answer_missing", { fieldId: unsafeProtectedScalar.fieldId });
  }
  const unplannedScalar = snapshot.controls.find(({ fieldId, required }) =>
    required && !plannedScalar.has(fieldId)
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
      .find(({ fieldId, required }) => required && !admittedIds.has(fieldId));
    if (unknownRepeatable !== undefined) {
      return blocked("answer_type_unknown", {
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
        required && !planned.has(fieldId)
      );
      if (missing !== undefined) {
        return blocked("profile_answer_missing", { fieldId: missing.fieldId });
      }
    }
  }
  return undefined;
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
    fields: plan.fields.map(canonicalSiteField),
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
    const unplannedRequired = current.controls.find(({ fieldId, required }) =>
      required && !planned.has(fieldId)
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
        current.controls,
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
  currentControls: readonly ProfileControlSnapshot[],
  page: WorkdayProfilePagePort,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "verified"; readonly field: VerifiedProfileField }
  | Extract<ProfilePageCompletionResult, { readonly kind: "blocked" }>
> {
  const matches = currentControls.filter(({ fieldId }) => fieldId === field.fieldId);
  if (matches.length !== 1) {
    return blocked(
      matches.length === 0 ? "profile_control_missing" : "profile_control_ambiguous",
      { fieldId: field.fieldId },
    );
  }
  const control = matches[0]!;
  if (!reviewedVariants.has(control.uiVariant)) {
    return blocked("profile_ui_variant_unreviewed", {
      fieldId: field.fieldId,
      uiVariant: control.uiVariant,
    });
  }
  if (!compatible(field, control)) {
    return blocked("profile_ui_behavior_mismatch", { fieldId: field.fieldId });
  }
  const expected = visibleValue(field);
  if (!readbackMatches(field, control.readback, expected)) {
    const request: ProfileCommitRequest = {
      controlId: control.controlId,
      uiBehavior: control.uiBehavior,
      value: expected,
    };
    try {
      await page.commit(request, signal);
      const fresh = (await readControls()).filter(({ controlId }) =>
        controlId === control.controlId
      );
      if (
        fresh.length !== 1 ||
        !readbackMatches(field, fresh[0]!.readback, expected)
      ) return blocked("profile_commit_unverified", { fieldId: field.fieldId });
    } catch {
      return portFailure(signal, { fieldId: field.fieldId });
    }
  }
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
  );
}

function visibleValue(field: ProfileFieldPlan): string {
  if (field.answer.kind !== "answered") return "";
  return field.optionMapping?.visibleOption ?? field.answer.value;
}

function readbackMatches(
  field: ProfileFieldPlan,
  actual: string | null,
  expected: string,
): boolean {
  if (actual === null) return false;
  if (field.fieldId === "phone.device_type" && field.answerType === "option") {
    return phoneDeviceTypeEquivalent(actual, expected);
  }
  if (field.answerType === "phone") {
    return actual.replace(/\D/gu, "") === expected.replace(/\D/gu, "");
  }
  if (field.answerType === "boolean") {
    return normalize(actual) === (expected === "true" ? "true" : "false");
  }
  if (field.answerType === "month") {
    return /^(?:0?[1-9]|1[0-2])$/u.test(actual) && Number(actual) === Number(expected);
  }
  if (field.answerType === "multi_select") {
    const actualOptions = optionList(actual) ?? [actual];
    const expectedOptions = optionList(expected);
    return expectedOptions !== undefined && sameNormalizedOptions(actualOptions, expectedOptions);
  }
  if (field.answerType === "option" || field.answerType === "single_select") {
    return equivalentOption(actual, expected);
  }
  return normalize(actual) === normalize(expected);
}

function phoneDeviceTypeEquivalent(actual: string, expected: string): boolean {
  const pair = new Set([
    normalize(actual).toLocaleLowerCase("en-US"),
    normalize(expected).toLocaleLowerCase("en-US"),
  ]);
  return pair.size === 1 || (pair.size === 2 && pair.has("mobile") && pair.has("cell"));
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
}> {
  const started = Date.now();
  const deadline = started + 1_000;
  let retryCount = 0;
  let lastError: unknown;
  while (true) {
    try {
      if (signal.aborted) return {};
      return { snapshot: await page.inspect(signal) };
    } catch (error) {
      lastError = error;
      retryCount += 1;
      if (signal.aborted || Date.now() >= deadline) {
        const deadlineOutcome = signal.aborted || Date.now() < deadline
          ? undefined
          : "deadline_exceeded_before_return" as const;
        const diagnostic = profileInspectionDiagnostic(
          lastError,
          page.inspectionFailure?.() ?? profileInspectionFailureFromError(lastError),
          retryCount,
          1_000,
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
