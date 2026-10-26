import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  canonicalJson,
  dataRecord,
  frozenDigest,
  sha256,
  sha256Pattern,
} from "../shared.ts";

const forbiddenKeys = new Set([
  "accessToken", "authorizationHeader", "credential", "emailBody", "messageBody",
  "password", "privateKey", "rawPageText", "rawText", "refreshToken", "sessionCookie",
]);
const pageKinds = new Set(["auth", "external-state", "application", "review"]);
const siteStates = new Set(["available", "maintenance", "removed", "closed", "not_found", "access_control"]);
const controlKinds = new Set([
  "button", "listbox", "text", "phone", "composite-date", "checkbox", "radio",
  "multiselect", "repeatable", "file",
]);
const controlStates = new Set(["actionable", "disabled", "empty", "selected", "required"]);

export interface CorpusFixture {
  schemaVersion: 1;
  captureMode: "read-only-approved-page";
  fixtureId: string;
  captureRevision: string;
  provingSlots: string[];
  variantIds: string[];
  observation: {
    pageKind: string;
    siteState: string;
    controls: Record<string, unknown>[];
    questions: Record<string, unknown>[];
  };
  semanticHash: string;
}

export function normalizeCapture(input: unknown): CorpusFixture {
  const capture = requireRecord(input, "capture");
  rejectForbiddenKeys(capture);
  exactKeys(capture, [
    "schemaVersion", "captureMode", "fixtureId", "captureRevision", "provingSlots",
    "variantIds", "observation", "semanticHash",
  ], "capture", ["semanticHash"]);
  if (capture.schemaVersion !== 1) throw new TypeError("capture schemaVersion must be 1");
  if (capture.captureMode !== "read-only-approved-page") throw new TypeError("capture must be read-only and owner-approved");
  const fixtureId = identifier(capture.fixtureId, "fixtureId", /^wd-[a-z0-9-]+-v\d+$/u);
  const captureRevision = identifier(capture.captureRevision, "captureRevision", /^[a-z0-9][a-z0-9.-]{2,79}$/u);
  const provingSlots = identifiers(capture.provingSlots, "provingSlots", /^WD40-\d{3}$/u, 40);
  const variantIds = identifiers(capture.variantIds, "variantIds", /^WD-(?:PAGE|UI|QA|OPTION)-[A-Z0-9-]+-V\d+$/u, 32);
  if (provingSlots.length === 0) throw new TypeError("provingSlots must not be empty");
  if (variantIds.length === 0) throw new TypeError("variantIds must not be empty");
  const observation = normalizeObservation(capture.observation);
  const fixture = {
    schemaVersion: 1 as const,
    captureMode: "read-only-approved-page" as const,
    fixtureId,
    captureRevision,
    provingSlots,
    variantIds,
    observation,
  };
  const normalized = { ...fixture, semanticHash: sha256(canonicalJson(fixture)) };
  if (capture.semanticHash !== undefined && capture.semanticHash !== normalized.semanticHash) {
    throw new TypeError("fixture semanticHash does not match normalized structural content");
  }
  return normalized;
}

export function replayFixture(fixture: CorpusFixture): CorpusFixture["observation"] {
  const normalized = normalizeCapture(fixture);
  if (normalized.semanticHash !== fixture.semanticHash) throw new TypeError("fixture semanticHash changed during replay");
  return structuredClone(normalized.observation);
}

export function validateCorpusFixtures(root: string, manifestInput: unknown, corpusInput: unknown): string[] {
  const errors: string[] = [];
  const manifest = dataRecord(manifestInput);
  const corpus = dataRecord(corpusInput);
  if (manifest === null || manifest.schemaVersion !== 1 || manifest.fixtureSet !== "workday-40") {
    return ["fixture manifest header is invalid"];
  }
  rejectExtraErrors(manifest, ["schemaVersion", "fixtureSet", "fixtures", "freeze"], "fixture manifest", errors);
  const entries = Array.isArray(manifest.fixtures) ? manifest.fixtures : [];
  if (entries.length === 0) errors.push("fixture manifest is empty");
  const corpusSlots = new Set(
    (Array.isArray(corpus?.slots) ? corpus.slots : [])
      .map(dataRecord)
      .map((slot) => slot?.slotId)
      .filter((slot): slot is string => typeof slot === "string"),
  );
  const seen = new Set<string>();
  for (const [index, rawEntry] of entries.entries()) {
    const entry = dataRecord(rawEntry);
    if (entry === null || typeof entry.id !== "string" || typeof entry.path !== "string") {
      errors.push(`fixtures[${index}] is invalid`);
      continue;
    }
    rejectExtraErrors(
      entry,
      ["id", "path", "semanticHash", "provingSlots", "variantIds", "captureRevision"],
      `fixtures[${index}]`,
      errors,
    );
    if (seen.has(entry.id)) errors.push(`fixtures[${index}].id is duplicated`);
    seen.add(entry.id);
    if (entry.path !== `${entry.id}.json`) {
      errors.push(`fixtures[${index}].path must be local to the fixture root`);
      continue;
    }
    const path = resolve(root, entry.path);
    if (!path.startsWith(`${resolve(root)}${sep}`)) {
      errors.push(`fixtures[${index}].path escapes the fixture root`);
      continue;
    }
    try {
      const fixture = normalizeCapture(JSON.parse(readFileSync(path, "utf8")));
      replayFixture(fixture);
      if (fixture.fixtureId !== entry.id) errors.push(`fixtures[${index}].id does not match its file`);
      if (fixture.semanticHash !== entry.semanticHash) errors.push(`fixtures[${index}].semanticHash does not match its file`);
      if (canonicalJson(fixture.provingSlots) !== canonicalJson(entry.provingSlots)) errors.push(`fixtures[${index}].provingSlots do not match its file`);
      if (canonicalJson(fixture.variantIds) !== canonicalJson(entry.variantIds)) errors.push(`fixtures[${index}].variantIds do not match its file`);
      if (fixture.captureRevision !== entry.captureRevision) errors.push(`fixtures[${index}].captureRevision does not match its file`);
      for (const slot of fixture.provingSlots) {
        if (!corpusSlots.has(slot)) errors.push(`fixtures[${index}] has unknown proving slot ${slot}`);
      }
    } catch (error) {
      errors.push(`fixtures[${index}] cannot replay: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  const freeze = dataRecord(manifest.freeze);
  if (freeze !== null) rejectExtraErrors(freeze, ["algorithm", "digest"], "fixture manifest freeze", errors);
  if (freeze?.algorithm !== "sha256" || typeof freeze.digest !== "string" || !sha256Pattern.test(freeze.digest) || freeze.digest !== frozenDigest(manifest)) {
    errors.push("fixture manifest freeze is invalid");
  }
  return errors;
}

function normalizeObservation(input: unknown): CorpusFixture["observation"] {
  const observation = requireRecord(input, "observation");
  exactKeys(observation, ["pageKind", "siteState", "controls", "questions"], "observation");
  if (!pageKinds.has(String(observation.pageKind))) throw new TypeError("observation.pageKind is unsupported");
  if (!siteStates.has(String(observation.siteState))) throw new TypeError("observation.siteState is unsupported");
  const rawControls = boundedArray(observation.controls, "observation.controls", 64);
  const controls = rawControls.map((raw, index) => {
    const control = requireRecord(raw, `observation.controls[${index}]`);
    exactKeys(control, ["id", "kind", "role", "required", "state"], `observation.controls[${index}]`);
    const id = identifier(control.id, "control.id", /^[a-z0-9][a-z0-9-]{1,63}$/u);
    if (!controlKinds.has(String(control.kind))) throw new TypeError(`control ${id} has unsupported kind`);
    const role = identifier(control.role, "control.role", /^[a-z0-9][a-z0-9-]{1,63}$/u);
    if (typeof control.required !== "boolean") throw new TypeError(`control ${id} required must be boolean`);
    if (!controlStates.has(String(control.state))) throw new TypeError(`control ${id} has unsupported state`);
    return { id, kind: String(control.kind), role, required: control.required, state: String(control.state) };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const questions = boundedArray(observation.questions, "observation.questions", 64).map((raw, index) => {
    const question = requireRecord(raw, `observation.questions[${index}]`);
    exactKeys(question, ["id", "kind", "answerType", "optionShape", "required"], `observation.questions[${index}]`);
    return {
      id: identifier(question.id, "question.id", /^[a-z0-9][a-z0-9-]{1,63}$/u),
      kind: identifier(question.kind, "question.kind", /^[a-z0-9][a-z0-9-]{1,63}$/u),
      answerType: identifier(question.answerType, "question.answerType", /^[a-z0-9][a-z0-9-]{1,63}$/u),
      optionShape: identifier(question.optionShape, "question.optionShape", /^[a-z0-9][a-z0-9-]{1,63}$/u),
      required: typeof question.required === "boolean" ? question.required : invalid("question.required must be boolean"),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return {
    pageKind: String(observation.pageKind),
    siteState: String(observation.siteState),
    controls,
    questions,
  };
}

function rejectForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(rejectForbiddenKeys);
  const record = dataRecord(value);
  if (record === null) return;
  for (const [key, child] of Object.entries(record)) {
    if (forbiddenKeys.has(key)) throw new TypeError(`capture contains forbidden key: ${key}`);
    rejectForbiddenKeys(child);
  }
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string, optional: readonly string[] = []): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unsupported !== undefined) throw new TypeError(`capture contains unsupported key: ${unsupported}`);
  const optionalSet = new Set(optional);
  const missing = allowed.find((key) => !optionalSet.has(key) && !(key in record));
  if (missing !== undefined) throw new TypeError(`${label} is missing ${missing}`);
}

function identifiers(value: unknown, label: string, pattern: RegExp, maximum: number): string[] {
  const values = boundedArray(value, label, maximum).map((item) => identifier(item, label, pattern));
  return [...new Set(values)].sort();
}

function boundedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > maximum) throw new RangeError(`${label} exceeds ${maximum} entries`);
  return value;
}

function identifier(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = dataRecord(value);
  if (record === null) throw new TypeError(`${label} must be an object`);
  return record;
}

function invalid(message: string): never {
  throw new TypeError(message);
}

function rejectExtraErrors(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record).filter((key) => !allowedSet.has(key)).sort()) {
    errors.push(`${label} contains unsupported field ${key}`);
  }
}
