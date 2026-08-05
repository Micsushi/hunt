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
]);
const answerProvenances = new Set([
  "owner_provided",
  "resume_verified",
  "configured_template",
]);
const pageTypes = new Set(["profile", "contact"]);
const questionTypes = new Set([
  "identity",
  "address",
  "phone",
  "experience",
  "education",
  "skill",
]);
const answerTypes = new Set(["text", "phone", "date", "option"]);
const repeatableSections = new Set(["experience", "education", "skills"]);

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

  let snapshot = await inspect(page, signal);
  if (snapshot === undefined) return portFailure(signal);
  if (snapshot.pageType !== plan.pageType) return blocked("profile_page_mismatch");
  const plannedScalarFields = new Set(plan.fields.map(({ fieldId }) => fieldId));
  const unplannedRequired = snapshot.controls.find(({ fieldId, required }) =>
    required && !plannedScalarFields.has(fieldId)
  );
  if (unplannedRequired !== undefined) {
    return blocked("profile_answer_missing", { fieldId: unplannedRequired.fieldId });
  }

  const cleaned = await cleanOwnedRows(snapshot, page, signal);
  if (cleaned === undefined) return portFailure(signal);
  snapshot = cleaned;

  const verified: VerifiedProfileField[] = [];
  for (const item of plan.fields) {
    const result = await reconcileField(
      item,
      () => page.inspect(signal).then(({ controls }) => controls),
      snapshot.controls,
      page,
      signal,
    );
    if (result.kind === "blocked") return result;
    verified.push(result.field);
    const refreshed = await inspect(page, signal);
    if (refreshed === undefined) return portFailure(signal);
    snapshot = refreshed;
  }

  for (const repeatable of plan.repeatables) {
    const result = await reconcileSection(
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

  const finalSnapshot = await inspect(page, signal);
  if (finalSnapshot === undefined) return portFailure(signal);
  if (ownedDuplicateCount(finalSnapshot.rows) !== 0) {
    return blocked("profile_row_unverified");
  }
  return {
    kind: "verified",
    pageType: plan.pageType,
    verifiedFields: verified,
    ownedDuplicateRows: 0,
  };
}

function validatePlan(plan: ProfilePagePlan): ProfilePageCompletionResult | undefined {
  if (!pageTypes.has(plan.pageType)) return blocked("profile_plan_invalid");
  const allFields = [
    ...plan.fields,
    ...plan.repeatables.flatMap(({ rows }) => rows.flatMap(({ fields }) => fields)),
  ];
  const missing = allFields.find(({ answer }) => answer.kind === "profile_answer_missing");
  if (missing !== undefined) {
    return blocked("profile_answer_missing", { fieldId: missing.fieldId });
  }
  const fieldIds = new Set<string>();
  for (const item of plan.fields) {
    if (fieldIds.has(item.fieldId) || !validField(item)) {
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
  const remove = new Set<string>();
  const groups = new Map<string, ProfileRowSnapshot[]>();
  for (const row of initial.rows) {
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

async function reconcileSection(
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
    let current = snapshot.rows.find((row) =>
      row.section === section &&
      !used.has(row.rowId) &&
      rowMatches(row, desired.fields)
    );
    if (current === undefined) {
      current = snapshot.rows.find((row) =>
        row.section === section && row.ownedByC3 && !used.has(row.rowId)
      );
    }
    if (current === undefined) {
      let rowId: string;
      try {
        rowId = await page.addOwnedRow(section, signal);
        snapshot = await page.inspect(signal);
      } catch {
        return portFailure(signal);
      }
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
      const refreshed = await inspect(page, signal);
      if (refreshed === undefined) return portFailure(signal);
      snapshot = refreshed;
      current = snapshot.rows.find((row) => row.rowId === rowId) ?? current;
    }
  }
  try {
    for (const row of snapshot.rows) {
      if (row.section !== section || !row.ownedByC3 || used.has(row.rowId)) continue;
      await page.removeOwnedRow(section, row.rowId, signal);
    }
    snapshot = await page.inspect(signal);
  } catch {
    return portFailure(signal);
  }
  return { kind: "verified", fields: verified, snapshot };
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
    (field.answerType === "option" && control.uiBehavior === "search_select")
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
