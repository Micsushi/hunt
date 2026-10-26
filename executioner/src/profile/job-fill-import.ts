import { Buffer } from "node:buffer";

import {
  applicationBooleanProfileFactIds,
  applicationNumberProfileFactIds,
  applicationProfileFactIds,
  parseApplicationProfile,
  type ApplicationProfile,
  type ApplicationProfileFact,
  type ApplicationProfileFactId,
} from "./application-profile.ts";
import type { ProfileId } from "../contracts/index.ts";

type JsonRecord = Record<string, unknown>;

export interface JobFillImportOptions {
  readonly profileId: string;
  readonly revision: number;
  readonly confirmedDefaultFactIds?: readonly ApplicationProfileFactId[];
}

export interface ImportedDocument {
  readonly kind: "resume" | "coverLetter";
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface JobFillImportResult {
  readonly profile: ApplicationProfile;
  readonly documents: readonly ImportedDocument[];
  readonly unresolved: readonly {
    readonly recordId: number | null;
    readonly fieldName: string;
    readonly section: string;
    readonly reason: "unmapped" | "invalid_value" | "conflicting_values" | "scoped_record";
    readonly matching: Readonly<Record<string, unknown>>;
  }[];
  readonly defaultsAwaitingConfirmation: readonly ApplicationProfileFactId[];
  readonly replacementLedger: readonly {
    readonly factId: ApplicationProfileFactId;
    readonly action: "accepted" | "duplicate_same" | "conflict_review" | "default_confirmed" | "default_skipped_existing";
    readonly sourceRecordId: number | null;
  }[];
}

const aliases = new Map<string, ApplicationProfileFactId>([
  ["first name", "given_name"], ["given name", "given_name"],
  ["last name", "family_name"], ["family name", "family_name"], ["surname", "family_name"],
  ["preferred name", "preferred_name"], ["email", "email_address"], ["email address", "email_address"],
  ["phone", "phone_number"], ["phone number", "phone_number"], ["mobile phone", "phone_number"],
  ["city", "city"], ["state", "region"], ["province", "region"], ["state province", "region"],
  ["country", "country"], ["postal code", "postal_code"], ["zip code", "postal_code"],
  ["current company", "current_company"], ["current employer", "current_company"],
  ["current title", "current_title"], ["current job title", "current_title"],
  ["highest education", "highest_education"], ["highest level of education", "highest_education"],
  ["earliest start date", "earliest_start_date"], ["available start date", "earliest_start_date"],
  ["work authorization", "work_authorization"], ["authorized to work", "work_authorization"],
  ["sponsorship required", "sponsorship_required"], ["require sponsorship", "sponsorship_required"],
  ["age requirement met", "age_requirement_met"], ["at least 18 years of age", "age_requirement_met"],
  ["years of experience", "years_experience"], ["years experience", "years_experience"],
  ["desired salary", "desired_salary"], ["salary expectation", "salary_expectations"],
  ["salary expectations", "salary_expectations"], ["how did you hear about us", "application_source"],
  ["application source", "application_source"],
  ["previously worked for organization", "previously_worked_for_organization"],
  ["previously worked for this organization", "previously_worked_for_organization"],
  ["associate referral", "associate_referral"], ["employee referral", "associate_referral"],
  ["current associate", "current_associate"], ["current employee", "current_associate"],
  ["previously applied", "previously_applied"], ["relatives employed", "relatives_employed"],
  ["essential functions ability", "essential_functions_ability"],
  ["employment agreement prevents employment", "employment_agreement_prevents_employment"],
  ["terms consent", "terms_consent"], ["agree to terms", "terms_consent"],
]);

const confirmedDefaults = new Map<ApplicationProfileFactId, boolean>([
  ["work_authorization", true],
  ["age_requirement_met", true],
  ["sponsorship_required", false],
  ["previously_worked_for_organization", false],
  ["associate_referral", false],
  ["current_associate", false],
  ["previously_applied", false],
  ["relatives_employed", false],
]);

const normalize = (value: unknown): string => String(value ?? "").toLowerCase()
  .replace(/[\*✱]/gu, "").replace(/\s*\((?:required|optional)\)\s*/gu, " ")
  .replace(/[^a-z0-9]+/gu, " ").trim();

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord : null;
}

function recordsFrom(value: JsonRecord): JsonRecord[] {
  if (Array.isArray(value.records)) return value.records.map(record).filter((item): item is JsonRecord => item !== null);
  const raw = record(value.raw);
  const store = raw?.store ?? value.store;
  if (!Array.isArray(store)) throw new TypeError("Job Fill backup has no records");
  return store.map((item) => {
    if (Array.isArray(item) && item.length === 2) return record(item[1]);
    return record(item);
  }).filter((item): item is JsonRecord => item !== null);
}

function firstAnswer(value: unknown): unknown {
  return Array.isArray(value) ? value.find((item) => String(item ?? "").trim() !== "") : value;
}

function valueFor(factId: ApplicationProfileFactId, raw: unknown): string | number | boolean | null {
  const value = firstAnswer(raw);
  if ((applicationBooleanProfileFactIds as readonly string[]).includes(factId)) {
    if (typeof value === "boolean") return value;
    const normalized = normalize(value);
    if (["yes", "true", "1", "authorized", "i agree"].includes(normalized)) return true;
    if (["no", "false", "0", "not authorized"].includes(normalized)) return false;
    return null;
  }
  if ((applicationNumberProfileFactIds as readonly string[]).includes(factId)) {
    const matched = String(value ?? "").replace(/,/gu, "").match(/\d+(?:\.\d+)?/u);
    if (!matched) return null;
    const number = Number(matched[0]);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text || null;
  }
  return null;
}

function factFor(factId: ApplicationProfileFactId, value: string | number | boolean): ApplicationProfileFact {
  return { factId, value, provenance: "owner_provided", lane: "live_owner_fact" } as ApplicationProfileFact;
}

function matching(record: JsonRecord): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries([
    "matchRule", "matchPhrase", "keywords", "keywordsMode", "questionCountry", "nonExactMatch",
  ].flatMap((key) => record[key] === undefined ? [] : [[key, structuredClone(record[key])]])));
}

function importedDocuments(value: JsonRecord): ImportedDocument[] {
  const documents = record(value.documents);
  if (documents === null) return [];
  const results: ImportedDocument[] = [];
  for (const kind of ["resume", "coverLetter"] as const) {
    const item = record(documents[kind]);
    if (item === null) continue;
    if (typeof item.name !== "string" || !item.name || typeof item.type !== "string" ||
        typeof item.body !== "string") throw new TypeError("Job Fill document is invalid");
    const match = item.body.match(/^data:([^;,]*)(?:;charset=[^;,]*)?;base64,([A-Za-z0-9+/=\s]+)$/u);
    if (!match) throw new TypeError("Job Fill document data is invalid");
    const bytes = Buffer.from(match[2]!, "base64");
    if (typeof item.size === "number" && item.size !== bytes.length) {
      throw new TypeError("Job Fill document size is invalid");
    }
    results.push(Object.freeze({ kind, name: item.name, mimeType: item.type || match[1]!, bytes }));
  }
  return results;
}

export function importJobFillBackup(value: unknown, options: JobFillImportOptions): JobFillImportResult {
  const backup = record(value);
  if (backup === null || (backup.format !== undefined && backup.format !== "job_app_filler_db") ||
      ![1, 2, undefined].includes(backup.version as number | undefined) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.profileId) ||
      !Number.isSafeInteger(options.revision) || options.revision < 0) {
    throw new TypeError("Job Fill import denied");
  }
  const accepted = new Map<ApplicationProfileFactId, ApplicationProfileFact>();
  const unresolved: JobFillImportResult["unresolved"][number][] = [];
  const replacementLedger: JobFillImportResult["replacementLedger"][number][] = [];

  for (const source of recordsFrom(backup)) {
    const fieldName = typeof source.fieldName === "string" ? source.fieldName.trim() : "";
    const section = typeof source.section === "string" ? source.section.trim() : "";
    const sourceRecordId = Number.isSafeInteger(source.id) ? Number(source.id) : null;
    // The application profile has global facts only; do not erase source scope.
    if (section !== "" || String(source.questionCountry ?? "").trim() !== "") {
      unresolved.push({ recordId: sourceRecordId, fieldName, section, reason: "scoped_record", matching: matching(source) });
      continue;
    }
    const factId = aliases.get(normalize(fieldName));
    if (factId === undefined) {
      unresolved.push({ recordId: sourceRecordId, fieldName, section, reason: "unmapped", matching: matching(source) });
      continue;
    }
    const value = valueFor(factId, source.answer);
    if (value === null) {
      unresolved.push({ recordId: sourceRecordId, fieldName, section, reason: "invalid_value", matching: matching(source) });
      continue;
    }
    const existing = accepted.get(factId);
    if (existing !== undefined) {
      const same = existing.value === value;
      replacementLedger.push({ factId, action: same ? "duplicate_same" : "conflict_review", sourceRecordId });
      if (!same) unresolved.push({ recordId: sourceRecordId, fieldName, section, reason: "conflicting_values", matching: matching(source) });
      continue;
    }
    accepted.set(factId, factFor(factId, value));
    replacementLedger.push({ factId, action: "accepted", sourceRecordId });
  }

  const confirmation = new Set(options.confirmedDefaultFactIds ?? []);
  const awaiting: ApplicationProfileFactId[] = [];
  for (const [factId, value] of confirmedDefaults) {
    if (accepted.has(factId)) {
      replacementLedger.push({ factId, action: "default_skipped_existing", sourceRecordId: null });
    } else if (confirmation.has(factId)) {
      accepted.set(factId, factFor(factId, value));
      replacementLedger.push({ factId, action: "default_confirmed", sourceRecordId: null });
    } else {
      awaiting.push(factId);
    }
  }
  if ([...confirmation].some((factId) => !confirmedDefaults.has(factId))) {
    throw new TypeError("Unknown Job Fill default confirmation");
  }

  const facts = applicationProfileFactIds.flatMap((factId) => {
    const fact = accepted.get(factId);
    return fact === undefined ? [] : [fact];
  });
  const profile = parseApplicationProfile({
    profileId: options.profileId as ProfileId,
    revision: options.revision,
    facts,
    unsetFactIds: applicationProfileFactIds.filter((factId) => !accepted.has(factId)),
    discoveredFields: [],
  });
  return Object.freeze({
    profile,
    documents: Object.freeze(importedDocuments(backup)),
    unresolved: Object.freeze(unresolved),
    defaultsAwaitingConfirmation: Object.freeze(awaiting),
    replacementLedger: Object.freeze(replacementLedger),
  });
}
