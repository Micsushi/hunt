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
const states = new Map<string, { sequence: number; bytes: number }>();

export interface ValueFreeRunTraceRecordV1 {
  readonly schemaVersion: 1;
  readonly traceRevision: "c3-value-free-run-trace-v1";
  readonly sequence: number;
  readonly event: string;
  readonly details: Readonly<Record<string, boolean | number | string | readonly string[]>>;
}

export function createValueFreeRunTrace(
  rootValue: string,
  stream: (line: string) => void = (line) => process.stderr.write(line),
): (event: string, details?: object) => void {
  const root = admittedRoot(rootValue);
  const path = join(root, FILE_NAME);
  const state = states.get(path) ?? loadState(path);
  states.set(path, state);
  return (event, details) => {
    try {
      if (!identifier(event) || state.sequence >= MAX_EVENTS) return;
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
  };
}

export function readValueFreeRunTrace(pathValue: string): readonly ValueFreeRunTraceRecordV1[] {
  const path = admittedFile(pathValue);
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES || !text.endsWith("\n")) denied();
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > MAX_EVENTS) denied();
  return Object.freeze(lines.map((line, index) => admitRecord(JSON.parse(line), index + 1)));
}

function loadState(path: string): { sequence: number; bytes: number } {
  if (!existsSync(path)) return { sequence: 0, bytes: 0 };
  const records = readValueFreeRunTrace(path);
  return { sequence: records.length, bytes: statSync(path).size };
}

const STRING_KEYS = new Set([
  "chain", "page", "moment", "operationId", "failureStage", "validationState",
  "code", "fieldId", "uiBehavior", "uiVariant", "kind", "journeyId", "stopAfter",
  "checkpoint", "browserPage", "status", "classifier", "primitive", "unknownLayer",
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
  "calendarCandidateCount",
]);
const BOOLEAN_KEYS = new Set([
  "submitPresent", "submitActivated", "mutationAttempted", "requiredErrorVisible",
  "identityResultValid", "identityMatches", "itemVisible", "itemBusy",
  "digitAccepted", "fillAccepted", "sequentialAccepted", "ownerCallSucceeded", "ownerAccepted",
  "calendarOpened", "calendarAccepted",
]);
const ARRAY_KEYS = new Set([
  "controlTypes", "questionTypes", "answerTypes", "browserLanes", "uiBehaviors", "provenances",
]);

function sanitize(value: object | undefined): Readonly<Record<string, boolean | number | string | readonly string[]>> {
  if (value === undefined || value === null || Array.isArray(value)) return Object.freeze({});
  const output: Record<string, boolean | number | string | readonly string[]> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (STRING_KEYS.has(key) && typeof candidate === "string" && structural(candidate)) {
      output[key] = candidate;
    } else if (NUMBER_KEYS.has(key) && Number.isSafeInteger(candidate) &&
        typeof candidate === "number" && candidate >= 0 && candidate <= 1_000_000) {
      output[key] = candidate;
    } else if (BOOLEAN_KEYS.has(key) && typeof candidate === "boolean") {
      output[key] = candidate;
    } else if (ARRAY_KEYS.has(key) && Array.isArray(candidate) && candidate.length <= 64 &&
        candidate.every((item) => typeof item === "string" && structural(item))) {
      output[key] = Object.freeze([...candidate]);
    }
  }
  return Object.freeze(output);
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
