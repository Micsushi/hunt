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

const reviewedVariants = new Set([
  "workday_text_v1",
  "workday_phone_v1",
  "workday_date_v1",
  "workday_search_select_v1",
  "workday_source_select_v1",
  "workday_previous_worker_radio_v1",
]);
const answerProvenances = new Set([
  "owner_provided",
  "resume_verified",
  "configured_template",
  "journey_derived",
]);
const pageTypes = new Set(["profile", "contact"]);
const questionTypes = new Set([
  "identity",
  "address",
  "phone",
  "application_source",
  "prior_employment",
  "experience",
  "education",
  "skill",
]);
const answerTypes = new Set(["text", "phone", "date", "option"]);
const repeatableSections = new Set(["experience", "education", "skills"]);
const optionalOwnerInputIds = new Set(
  profileOwnerInputCatalog.map(({ fieldId }) => fieldId),
);

type BlockedResult = Extract<
  ProfilePageCompletionResult,
  { readonly kind: "blocked" }
>;

const blocked = (
  code: BlockedResult["code"],
  detail: { readonly fieldId?: string; readonly uiVariant?: string } = {},
): BlockedResult => ({ kind: "blocked", code, ...detail });

const portFailure = (
  signal: AbortSignal,
  detail: { readonly fieldId?: string } = {},
): BlockedResult => signal.aborted
  ? blocked("operation_cancelled")
  : blocked("profile_port_unavailable", detail);

export async function completeWorkdayProfilePage(
  plan: ProfilePagePlan,
  page: WorkdayProfilePagePort,
  signal: AbortSignal,
): Promise<ProfilePageCompletionResult> {
  const preflight = validatePlan(plan);
  if (preflight !== undefined) return preflight;
  if (signal.aborted) return blocked("operation_cancelled");

  const initial = await inspectAndPreflight(plan, page, signal);
  if (initial.kind === "blocked") return initial;
  let snapshot = initial.snapshot;

  const cleaned = await cleanOwnedRows(snapshot, page, signal);
  if (cleaned === undefined) return portFailure(signal);
  const cleanedPreflight = preflightSnapshot(plan, cleaned);
  if (cleanedPreflight !== undefined) return cleanedPreflight;
  snapshot = cleaned;

  const verified: VerifiedProfileField[] = [];
  for (const item of plan.fields) {
    if (item.answer.kind === "profile_answer_missing") continue;
    if (
      optionalOwnerInputIds.has(item.fieldId) &&
      !snapshot.controls.some(({ fieldId }) => fieldId === item.fieldId)
    ) continue;
    const result = await reconcileField(
      item,
      () => page.inspect(signal).then(({ controls }) => controls),
      snapshot.controls,
      page,
      signal,
    );
    if (result.kind === "blocked") return result;
    verified.push(result.field);
    const refreshed = await inspectAndPreflight(plan, page, signal);
    if (refreshed.kind === "blocked") return refreshed;
    snapshot = refreshed.snapshot;
  }

  for (const repeatable of plan.repeatables) {
    const result = await reconcileSection(
      plan,
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

  const final = await inspectAndPreflight(plan, page, signal);
  if (final.kind === "blocked") return final;
  if (ownedDuplicateCount(final.snapshot.rows) !== 0) {
    return blocked("profile_row_unverified");
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
  const admittedScalarIds = new Set([
    ...profileScalarControlCatalog.map(({ fieldId }) => fieldId),
    ...profileRepeatableCatalog.flatMap(({ fields }) =>
      fields.map(({ fieldId }) => fieldId)
    ),
  ]);
  if (snapshot.controls.some(({ fieldId, required }) =>
    required && !admittedScalarIds.has(fieldId)
  )) return blocked("answer_type_unknown");

  const plannedScalar = new Map(plan.fields.map((field) => [field.fieldId, field]));
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
    if (visibleRows.some(({ controls }) => controls.some(({ fieldId, required }) =>
      required && !admittedIds.has(fieldId)
    ))) return blocked("answer_type_unknown");

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
  if (snapshot === undefined) return portFailure(signal);
  const preflight = preflightSnapshot(plan, snapshot);
  return preflight ?? { kind: "inspected", snapshot };
}

function validatePlan(plan: ProfilePagePlan): ProfilePageCompletionResult | undefined {
  if (!pageTypes.has(plan.pageType)) return blocked("profile_plan_invalid");
  const fieldIds = new Set<string>();
  for (const item of plan.fields) {
    if (fieldIds.has(item.fieldId)) {
      return blocked("profile_plan_invalid", { fieldId: item.fieldId });
    }
    if (item.answer.kind === "profile_answer_missing") {
      if (!optionalOwnerInputIds.has(item.fieldId)) {
        return blocked("profile_answer_missing", { fieldId: item.fieldId });
      }
      fieldIds.add(item.fieldId);
      continue;
    }
    if (!validField(item)) {
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
        row.fields.some((item) => !validField(item))
      ) return blocked("profile_plan_invalid");
      rowKeys.add(row.rowKey);
      fingerprints.add(fingerprint);
    }
  }
  return undefined;
}

function validField(field: ProfileFieldPlan): boolean {
  if (
    !/^[a-z][a-z0-9_.-]{0,127}$/u.test(field.fieldId) ||
    !questionTypes.has(field.questionType) ||
    !answerTypes.has(field.answerType) ||
    field.answer.kind !== "answered" ||
    !answerProvenances.has(field.answer.provenance) ||
    normalize(field.answer.value) === ""
  ) return false;
  if (field.answerType === "date" && !validIsoDate(field.answer.value)) return false;
  if (field.answerType === "phone" && field.answer.value.replace(/\D/gu, "").length < 7) {
    return false;
  }
  if (
    field.answer.provenance === "journey_derived" &&
    (
      field.fieldId !== "source.how_did_you_hear" ||
      field.questionType !== "application_source" ||
      field.answerType !== "option"
    )
  ) return false;
  return field.answerType !== "option" || (
    field.optionMapping?.provenance === "visible_option" &&
    field.optionMapping.canonicalValue === field.answer.value &&
    normalize(field.optionMapping.visibleOption) !== ""
  );
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
      if (result.kind === "blocked") return result;
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
      ...(field.optionMapping === undefined
        ? {}
        : { optionMappingProvenance: field.optionMapping.provenance }),
    },
  };
}

function compatible(field: ProfileFieldPlan, control: ProfileControlSnapshot): boolean {
  return (
    (field.answerType === "text" && control.uiBehavior === "text") ||
    (field.answerType === "phone" && control.uiBehavior === "phone") ||
    (field.answerType === "date" && control.uiBehavior === "date") ||
    (field.answerType === "option" &&
      (control.uiBehavior === "search_select" || control.uiBehavior === "radio_group"))
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
  if (field.answerType === "phone") {
    return actual.replace(/\D/gu, "") === expected.replace(/\D/gu, "");
  }
  return normalize(actual) === normalize(expected);
}

function rowMatches(row: ProfileRowSnapshot, desired: readonly ProfileFieldPlan[]): boolean {
  return desired.every((field) => {
    const controls = row.controls.filter(({ fieldId }) => fieldId === field.fieldId);
    return controls.length === 1 &&
      readbackMatches(field, controls[0]!.readback, visibleValue(field));
  });
}

function desiredFingerprint(fields: readonly ProfileFieldPlan[]): string {
  return fields.map((field) => `${field.fieldId}:${normalize(visibleValue(field))}`)
    .sort()
    .join("|");
}

function actualFingerprint(controls: readonly ProfileControlSnapshot[]): string {
  return controls.filter(({ readback }) => readback !== null && normalize(readback) !== "")
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
): Promise<ProfilePageSnapshot | undefined> {
  try {
    if (signal.aborted) return undefined;
    return await page.inspect(signal);
  } catch {
    return undefined;
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
