import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

const FILE_NAME = "value-free-trace.ndjson";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 4_096;
const states = new Map<string, { sequence: number; bytes: number; sealed: boolean }>();

export interface ValueFreeRunTrace {
  (event: string, details?: object): void;
  seal(): void;
}

export interface ValueFreeRunTraceRecordV1 {
  readonly schemaVersion: 1;
  readonly traceRevision: "c3-value-free-run-trace-v1";
  readonly sequence: number;
  readonly event: string;
  readonly details: Readonly<Record<string, boolean | number | string | readonly string[] | readonly number[]>>;
}

export function createValueFreeRunTrace(
  rootValue: string,
  stream: (line: string) => void = (line) => process.stderr.write(line),
): ValueFreeRunTrace {
  const root = admittedRoot(rootValue);
  const path = join(root, FILE_NAME);
  const state = states.get(path) ?? loadState(path);
  states.set(path, state);
  const trace = ((event: string, details?: object) => {
    try {
      if (state.sealed || !identifier(event) || state.sequence >= MAX_EVENTS) return;
      const record: ValueFreeRunTraceRecordV1 = Object.freeze({
        schemaVersion: 1,
        traceRevision: "c3-value-free-run-trace-v1",
        sequence: state.sequence + 1,
        event,
        details: sanitize(details),
      });
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line, "utf8");
      if (state.bytes + bytes > MAX_BYTES) return;
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
      state.sequence = record.sequence;
      state.bytes += bytes;
      try { stream(line); } catch { /* diagnostics never alter behavior */ }
    } catch {
      // Diagnostics never alter behavior.
    }
  }) as ValueFreeRunTrace;
  trace.seal = () => {
    state.sealed = true;
    if (existsSync(path)) {
      try { chmodSync(path, 0o400); } catch { /* best-effort platform hardening */ }
    }
  };
  return trace;
}

export function readValueFreeRunTrace(pathValue: string): readonly ValueFreeRunTraceRecordV1[] {
  const path = admittedFile(pathValue);
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES || !text.endsWith("\n")) denied();
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > MAX_EVENTS) denied();
  return Object.freeze(lines.map((line, index) => admitRecord(JSON.parse(line), index + 1)));
}

function loadState(path: string): { sequence: number; bytes: number; sealed: boolean } {
  if (!existsSync(path)) return { sequence: 0, bytes: 0, sealed: false };
  const records = readValueFreeRunTrace(path);
  return { sequence: records.length, bytes: statSync(path).size, sealed: false };
}

const STRING_KEYS = new Set([
  "chain", "page", "moment", "operationId", "failureStage", "validationState",
  "code", "fieldId", "uiBehavior", "uiVariant", "kind", "journeyId", "stopAfter",
  "checkpoint", "browserPage", "status", "classifier", "primitive", "unknownLayer",
  "phase", "failureName",
  "profileInspectionClassification", "profileInspectionPhase",
  "profileInspectionDeadlineOutcome", "profileInspectionProfilePortState",
  "profileInspectionSessionState", "profileInspectionCleanupState",
  "profileInspectionPreservationReason", "learningConversion", "executionMode",
  "errorType", "priorCommittedState", "observedState", "underlyingError",
  "operation", "replacementReason",
  "monotonicClock",
]);
const NUMBER_KEYS = new Set([
  "ordinal", "attempt", "fieldCount", "requiredFieldCount", "completedPages",
  "requiredFields", "verifiedFields", "duplicateRows", "inputCount", "itemCount",
  "successCount", "removeCount", "errorCount", "inputFileCount", "buttonCount",
  "progressCount", "groupCount", "checkboxCount", "checkedCount", "optionRowCount",
  "ownerSurfaceCount", "visualSurfaceCount", "candidateCount", "sharedSelectCount",
  "sharedOptionSelectCount", "exactObjectCallCount", "exactIdCallCount",
  "exactCommitCount", "exactRejectedCount", "exactThrowCount",
  "admissionCheckboxIndex", "admissionGroupCheckboxCount", "admissionOwnerIdCount",
  "originalOptionCount", "stableGroupCount", "stableCheckboxCount", "stableExactLabelCount",
  "adapterSelectCount", "adapterExclusiveSelectCount",
  "directPropCount", "directOnChangeCount", "directOnChangeArity",
  "directOnBlurCount", "directOnInputCount",
  "calendarCandidateCount", "nativeDateInputCount", "formattedDateReboundCount", "dateInputCount", "fieldButtonCount", "fieldRoleButtonCount",
  "fieldSvgCount", "fieldAutomationCount", "rightHitReactClickAncestorCount",
  "allTextTelInputCount", "maskedInputCount", "visibleMaskedInputCount", "exactDateLabelCount",
  "exactMaskTextCount", "exactMaskTextSpanCount", "exactMaskTextDivCount",
  "exactMaskTextRoleTextboxCount", "exactMaskTextContentEditableCount", "dateOwnerCandidateCount",
  "dateOwnerInputCount", "dateOwnerTextTelInputCount", "dateOwnerVisibleTextTelInputCount",
  "dateOwnerButtonCount", "dateOwnerRoleButtonCount", "dateOwnerSvgCount", "dateOwnerAutomationCount",
  "boundDateInputCount", "boundDateExactLabelCount", "boundDateAssociatedLabelCount",
  "boundDateClosestFormFieldCount", "boundDateClosestDateSectionCount",
  "boundDatePlaceholderMaskCount", "boundDateValueMaskCount", "boundDateReactOnChangeCount",
  "dateSvgOwnerCandidateCount", "dateSvgOwnerDepth", "dateSvgOwnerExactLabelCount",
  "dateSvgOwnerLabelCount", "dateSvgOwnerSvgCount", "dateSvgOwnerInputCount",
  "dateSvgOwnerButtonCount", "dateSvgOwnerRoleButtonCount", "dateSvgOwnerAutomationCount",
  "dateSvgOwnerReactClickCount", "boundRightReactClickAncestorCount",
  "ownedDateLabelOwnerDepth", "ownedDateLabelOwnerVisibleLabelCount",
  "ownedDateLabelOwnerExactLabelCount", "ownedDateLabelOwnerVisibleTextTelInputCount",
  "ownedDateLabelOwnerSvgCount", "ownedDateLabelOwnerButtonCount",
  "reboundDateExactLabelCount", "reboundDateLabelInputOwnerCount",
  "reboundDateLabelSvgOwnerCount", "reboundDateDistinctInputCount",
  "reboundDateDistinctSvgCount", "reboundDateJointOwnerCount",
  "profileInspectionRetryCount", "profileInspectionDeadlineMs", "profileInspectionElapsedMs",
  "durationMs",
  "applicationWalkDurationMs", "totalWallDurationMs",
  "pageReadinessDurationMs", "navigationWaitDurationMs",
  "activeFillDurationMs", "independentMonitorDurationMs", "committedReadbackDurationMs",
  "reconciliationDurationMs",
  "activeFillSloMs",
  "remountGeneration", "conditionalDelta", "observedOptionCount",
  "profileInspectionAttemptCount", "profileInspectionFrameCount", "profileMetadataMismatchCount",
  "profileInspectionProfileRootCandidateCount", "profileInspectionProfileRootVisibleCount",
  "profileInspectionDomOwnerCandidateCount", "profileInspectionControlCandidateCount",
  "selectedItemCount", "productionOwnerCount", "productionOwnedSelectedItemCount",
  "unownedSelectedItemCount", "canonicalItemCount", "fallbackItemCount",
  "chosenItemCount", "chosenUniqueCount", "fieldOwnerSelectedItemCount",
  "derivedVisibleUpstreamCount",
]);
const BOOLEAN_KEYS = new Set([
  "submitPresent", "submitActivated", "mutationAttempted", "requiredErrorVisible",
  "identityResultValid", "identityMatches", "itemVisible", "itemBusy",
  "digitAccepted", "fillAccepted", "sequentialAccepted", "ownerCallSucceeded", "ownerAccepted",
  "calendarOpened", "calendarAccepted", "nativeDateAccepted",
  "rightHitInput", "rightHitWithinField", "rightHitButtonAncestor",
  "rightHitRoleButtonAncestor", "rightHitSvgAncestor", "rightHitAutomationAncestor",
  "boundRightHitInput", "boundRightHitWithinSvgOwner", "boundRightHitSvgAncestor",
  "profileInspectionPreservationEligible", "profileInspectionContinueAllowed",
  "testOnly", "mutationAllowed", "defaultsGenerated",
  "learningPresent", "committedReadbackMatches",
  "activeFillWithinSlo",
  "phasePassed",
  "usedProductionOwners",
  "derivedBackingRuleMatched", "derivedUpstreamBackingCommitted",
]);
const TIMESTAMP_KEYS = new Set([
  "startedAt", "pageReadyAt", "pageFillCompletedAt",
]);
const ARRAY_KEYS = new Set([
  "controlTypes", "questionTypes", "answerTypes", "browserLanes", "uiBehaviors", "provenances",
  "profileMetadataMismatchFields", "profileMetadataMismatchReasons", "learningFieldIds",
  "learningFieldReasons", "conditionalAdded", "conditionalRemoved",
  "secondaryFailures",
  "unverifiedFieldIds", "unverifiedFieldReasons",
]);
const PROFILE_INSPECTION_ARRAY_KEYS = new Set([
  "profileInspectionBindingIds", "profileInspectionBindingPaths", "profileInspectionBindingDigests",
  "profileInspectionControlIdDigests", "profileInspectionSemanticIdDigests",
  "profileInspectionFrameIdentityDigests", "profileInspectionFrameOwnerControlRelationshipDigests",
  "profileInspectionFrameOwnerControlTupleDigests",
]);
const PROFILE_INSPECTION_NUMBER_ARRAY_KEYS = new Set([
  "profileInspectionFrameDomOwnerCandidateCounts", "profileInspectionFrameControlCandidateCounts",
]);
const PROFILE_INSPECTION_DIGEST_KEYS = new Set([
  "profileInspectionStructuralIdentityDigest", "profileInspectionBindingDigest",
]);
const PROFILE_INSPECTION_STRING_KEYS = new Set([
  "profileInspectionClassification", "profileInspectionPhase",
  "profileInspectionDeadlineOutcome", "profileInspectionProfilePortState",
  "profileInspectionSessionState", "profileInspectionCleanupState",
  "profileInspectionPreservationReason",
]);

function sanitize(value: object | undefined): Readonly<Record<string, boolean | number | string | readonly string[] | readonly number[]>> {
  if (value === undefined || value === null || Array.isArray(value)) return Object.freeze({});
  const output: Record<string, boolean | number | string | readonly string[] | readonly number[]> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (TIMESTAMP_KEYS.has(key) && typeof candidate === "string" &&
        canonicalTimestamp(candidate)) {
      output[key] = candidate;
    } else if (PROFILE_INSPECTION_DIGEST_KEYS.has(key) && typeof candidate === "string" &&
        /^[0-9a-f]{64}$/u.test(candidate)) {
      output[key] = candidate;
    } else if (STRING_KEYS.has(key) && typeof candidate === "string" &&
        (PROFILE_INSPECTION_STRING_KEYS.has(key)
          ? profileInspectionString(key, candidate)
          : structural(candidate))) {
      output[key] = candidate;
    } else if (NUMBER_KEYS.has(key) && Number.isSafeInteger(candidate) &&
        typeof candidate === "number" && candidate >= 0 && candidate <= 1_000_000) {
      output[key] = candidate;
    } else if (BOOLEAN_KEYS.has(key) && typeof candidate === "boolean") {
      output[key] = candidate;
    } else if (PROFILE_INSPECTION_ARRAY_KEYS.has(key) && Array.isArray(candidate) &&
        candidate.length <= 64 && candidate.every((item) =>
          typeof item === "string" && profileInspectionIdentifier(key, item)
        )) {
      output[key] = Object.freeze([...candidate]);
    } else if (PROFILE_INSPECTION_NUMBER_ARRAY_KEYS.has(key) && Array.isArray(candidate) &&
        candidate.length <= 32 && candidate.every((item) =>
          Number.isSafeInteger(item) && item >= 0 && item <= 1_000_000
        )) {
      output[key] = Object.freeze([...candidate]);
    } else if (ARRAY_KEYS.has(key) && Array.isArray(candidate) && candidate.length <= 64 &&
        candidate.every((item) => typeof item === "string" && structural(item))) {
      output[key] = Object.freeze([...candidate]);
    }
  }
  return Object.freeze(output);
}

function canonicalTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    new Date(Date.parse(value)).toISOString() === value;
}

function profileInspectionIdentifier(key: string, value: string): boolean {
  if (key === "profileInspectionBindingDigests" ||
      key === "profileInspectionControlIdDigests" ||
      key === "profileInspectionSemanticIdDigests" ||
      key === "profileInspectionFrameIdentityDigests" ||
      key === "profileInspectionFrameOwnerControlRelationshipDigests" ||
      key === "profileInspectionFrameOwnerControlTupleDigests") {
    return /^[0-9a-f]{64}$/u.test(value);
  }
  return /^[a-z][a-z0-9._-]{0,127}$/u.test(value);
}

function profileInspectionString(key: string, value: string): boolean {
  const allowed: Record<string, ReadonlySet<string>> = {
    profileInspectionClassification: new Set(["liveness", "dom_owner_binding", "unknown"]),
    profileInspectionPhase: new Set(["scalar", "repeatable", "unknown_controls", "unknown"]),
    profileInspectionDeadlineOutcome: new Set(["deadline_exceeded_before_return"]),
    profileInspectionProfilePortState: new Set([
      "unknown", "inspecting", "unavailable", "deadline_exceeded_before_return",
    ]),
    profileInspectionSessionState: new Set(["unknown", "bound", "invalid"]),
    profileInspectionCleanupState: new Set(["not_started", "started", "completed", "failed"]),
    profileInspectionPreservationReason: new Set([
      "session_validation_required", "mutation_attempted", "page_or_context_not_live",
      "owner_session_target_binding_mismatch", "lease_invalid", "cleanup_started", "eligible",
    ]),
  };
  return allowed[key]?.has(value) ?? false;
}

function admitRecord(value: unknown, sequence: number): ValueFreeRunTraceRecordV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).join("\0") !== "schemaVersion\0traceRevision\0sequence\0event\0details" ||
      record.schemaVersion !== 1 || record.traceRevision !== "c3-value-free-run-trace-v1" ||
      record.sequence !== sequence || !identifier(record.event) ||
      typeof record.details !== "object" || record.details === null || Array.isArray(record.details) ||
      JSON.stringify(sanitize(record.details as object)) !== JSON.stringify(record.details)) denied();
  return deepFreeze(record) as unknown as ValueFreeRunTraceRecordV1;
}

function admittedRoot(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || !existsSync(value) ||
      lstatSync(value).isSymbolicLink() || !statSync(value).isDirectory() ||
      comparable(realpathSync.native(value)) !== comparable(resolve(value))) denied();
  return realpathSync.native(value);
}

function admittedFile(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || !existsSync(value) ||
      lstatSync(value).isSymbolicLink() || !statSync(value).isFile() ||
      statSync(value).size < 2 || statSync(value).size > MAX_BYTES ||
      comparable(realpathSync.native(value)) !== comparable(resolve(value))) denied();
  return realpathSync.native(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{2,127}$/u.test(value);
}

function structural(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new TypeError("value-free run trace denied");
}
