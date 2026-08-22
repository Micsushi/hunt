import { types as utilTypes } from "node:util";

import {
  profileFactIds,
  providerError,
  type ApplicantProfile,
  type ProfileId,
} from "../contracts/index.ts";
import {
  applicationBooleanProfileFactIds,
  applicationNumberProfileFactIds,
  applicationProfileFactIds,
  applicationTextProfileFactIds,
  type ApplicationProfileFact,
  type ApplicationProfileQuery,
  type ApplicationProfileQueryRequest,
  type ApplicationProfileFactId,
  type DiscoveredIntakeField,
} from "../form/answers/application-types.ts";

export {
  answerExecutionModes,
  answerLaneAdmitted,
  answerProvenanceLanes,
  applicationBooleanProfileFactIds,
  applicationNumberProfileFactIds,
  applicationProfileFactIds,
  applicationTextProfileFactIds,
  type AnswerExecutionMode,
  type AnswerProvenanceLane,
  type ApplicationProfileFact,
  type ApplicationProfileFactId,
  type ApplicationProfileAnswerResult,
  type ApplicationProfileQuery,
  type ApplicationProfileQueryRequest,
  type DiscoveredIntakeField,
} from "../form/answers/application-types.ts";

export interface ApplicationProfile {
  readonly profileId: ProfileId;
  readonly revision: number;
  readonly facts: readonly ApplicationProfileFact[];
  readonly unsetFactIds: readonly ApplicationProfileFactId[];
  readonly discoveredFields: readonly DiscoveredIntakeField[];
}

const credential = /(?:^|_)(?:credential|credentials|password|passcode|passphrase|secret|private_key|api_key|access_token|refresh_token|bearer_token|auth_token|oauth_token|session_token|session_cookie|cookie|authorization_header|client_secret)(?:$|_)/u;
const opaque = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function parseApplicationProfile(value: unknown): ApplicationProfile {
  const profile = exact(value, [
    "profileId", "revision", "facts", "unsetFactIds", "discoveredFields",
  ], "$");
  if (typeof profile.profileId !== "string" || !opaque.test(profile.profileId)) {
    denied("$.profileId");
  }
  if (!Number.isSafeInteger(profile.revision) || Number(profile.revision) < 0) {
    denied("$.revision");
  }
  if (!Array.isArray(profile.facts) || !Array.isArray(profile.unsetFactIds) ||
      !Array.isArray(profile.discoveredFields) || profile.discoveredFields.length > 128) {
    denied("$");
  }
  const answered = new Set<string>();
  for (const [index, candidate] of profile.facts.entries()) {
    const path = `$.facts[${index}]`;
    const fact = exact(candidate, ["factId", "value", "provenance", "lane"], path);
    if (typeof fact.factId !== "string") denied(`${path}.factId`);
    const normalized = fact.factId.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .toLowerCase().replace(/[^a-z0-9]+/gu, "_");
    if (credential.test(normalized)) denied(`${path}.factId`);
    if (!(applicationProfileFactIds as readonly string[]).includes(fact.factId) ||
        answered.has(fact.factId)) denied(`${path}.factId`);
    if ((applicationTextProfileFactIds as readonly string[]).includes(fact.factId)) {
      if (typeof fact.value !== "string") denied(`${path}.value`);
    } else if ((applicationBooleanProfileFactIds as readonly string[]).includes(fact.factId)) {
      if (typeof fact.value !== "boolean") denied(`${path}.value`);
    } else if (typeof fact.value !== "number" || !Number.isFinite(fact.value) || fact.value < 0) {
      denied(`${path}.value`);
    }
    if (!["owner_provided", "resume_verified", "configured_template"].includes(
      fact.provenance as string,
    ) || fact.lane !== "live_owner_fact") denied(path);
    answered.add(fact.factId);
  }
  const unset = new Set<string>();
  for (const [index, factId] of profile.unsetFactIds.entries()) {
    if (typeof factId !== "string" ||
        !(applicationProfileFactIds as readonly string[]).includes(factId) ||
        answered.has(factId) || unset.has(factId)) denied(`$.unsetFactIds[${index}]`);
    unset.add(factId);
  }
  if (answered.size + unset.size !== applicationProfileFactIds.length) {
    denied("$.unsetFactIds");
  }
  const discoveredIds = new Set<string>();
  for (const [index, candidate] of profile.discoveredFields.entries()) {
    validateDiscoveredField(candidate, `$.discoveredFields[${index}]`, discoveredIds);
  }
  return deepFreeze(structuredClone(profile)) as unknown as ApplicationProfile;
}

export function createApplicationProfileQuery(value: unknown): ApplicationProfileQuery {
  const profile = parseApplicationProfile(value);
  const facts = new Map(profile.facts.map((fact) => [fact.factId, fact]));
  return Object.freeze({
    async query(request: ApplicationProfileQueryRequest, signal: AbortSignal) {
      if (signal.aborted) return { ok: false as const, error: providerError("operation_cancelled") };
      if (!validApplicationProfileQueryRequest(request)) {
        return { ok: false as const, error: providerError("profile_query_invalid") };
      }
      if (request.profileId !== profile.profileId) {
        return { ok: false as const, error: providerError("profile_missing") };
      }
      if (request.profileRevision !== profile.revision) {
        return { ok: false as const, error: providerError("profile_revision_mismatch") };
      }
      const fact = facts.get(request.factId);
      if (fact === undefined) return { ok: true as const, value: { kind: "profile_answer_missing" as const } };
      return {
        ok: true as const,
        value: Object.freeze({
          kind: "answered" as const,
          value: fact.value,
          provenance: fact.provenance,
          lane: fact.lane,
        }),
      };
    },
  });
}

function validApplicationProfileQueryRequest(
  value: unknown,
): value is ApplicationProfileQueryRequest {
  try {
    const request = exact(value, ["profileId", "profileRevision", "factId"], "$request");
    return typeof request.profileId === "string" && opaque.test(request.profileId) &&
      Number.isSafeInteger(request.profileRevision) && Number(request.profileRevision) >= 0 &&
      typeof request.factId === "string" &&
      (applicationProfileFactIds as readonly string[]).includes(request.factId);
  } catch {
    return false;
  }
}

export function toFrozenApplicantProfile(value: unknown): ApplicantProfile {
  const profile = parseApplicationProfile(value);
  return Object.freeze({
    profileId: profile.profileId,
    revision: profile.revision,
    facts: Object.freeze(profile.facts.flatMap((fact) =>
      (profileFactIds as readonly string[]).includes(fact.factId)
        ? [{
            factId: fact.factId,
            value: fact.value,
            provenance: fact.provenance,
          }]
        : []
    )) as ApplicantProfile["facts"],
  });
}

function validateDiscoveredField(
  value: unknown,
  path: string,
  ids: Set<string>,
): void {
  const field = exact(value, [
    "discoveredFieldId", "page", "identity", "sanitizedLabel",
    "normalizedQuestionType", "behavior", "answerType", "uiVariant", "required",
    "allowedOptions", "allowsCustomValue", "constraints", "answer",
  ], path);
  if (typeof field.discoveredFieldId !== "string" || !opaque.test(field.discoveredFieldId) ||
      ids.has(field.discoveredFieldId) ||
      !["profile", "questionnaire", "voluntary_disclosures", "self_identify", "resume"]
        .includes(field.page as string) ||
      typeof field.identity !== "string" ||
      !/^(?:unresolved|[a-z][a-z0-9_.-]{0,127})$/u.test(field.identity) ||
      !(field.sanitizedLabel === null || typeof field.sanitizedLabel === "string" &&
        field.sanitizedLabel.trim() !== "" && field.sanitizedLabel.length <= 512) ||
      (field.identity === "unresolved") !== (field.sanitizedLabel === null) ||
      !["identity", "address", "phone", "application_source", "prior_employment",
        "employment", "education", "authorization", "legal", "compensation",
        "availability", "demographic", "attachment", "skill", "website",
        "social_network", "unknown"].includes(field.normalizedQuestionType as string) ||
      !["text", "textarea", "date", "radio", "select", "listbox", "checkbox",
        "file_upload", "repeatable", "search_select"].includes(field.behavior as string) ||
      !["text", "date", "boolean", "single_select", "file", "multi_select", "repeatable"]
        .includes(field.answerType as string) ||
      typeof field.uiVariant !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(field.uiVariant) ||
      !(typeof field.required === "boolean" || field.required === null) ||
      typeof field.allowsCustomValue !== "boolean" || !Array.isArray(field.allowedOptions)) denied(path);
  const options = field.allowedOptions as unknown[];
  if (options.some((option) => typeof option !== "string" || option.trim() === "") ||
      new Set(options).size !== options.length) denied(`${path}.allowedOptions`);
  const constraints = exact(field.constraints, ["maxBytes", "displayFormat"], `${path}.constraints`);
  if (!(constraints.maxBytes === null || Number.isSafeInteger(constraints.maxBytes) &&
        Number(constraints.maxBytes) > 0) ||
      !(constraints.displayFormat === null || typeof constraints.displayFormat === "string" &&
        constraints.displayFormat.trim() !== "" && constraints.displayFormat.length <= 64)) denied(`${path}.constraints`);
  const answer = exact(field.answer, ["kind"], `${path}.answer`);
  if (answer.kind !== "profile_answer_missing") denied(`${path}.answer.kind`);
  ids.add(field.discoveredFieldId);
}

function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || utilTypes.isProxy(value)) {
    denied(path);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some((key) =>
    typeof key !== "string" || !keys.includes(key) || descriptors[key]?.enumerable !== true ||
    descriptors[key] === undefined || !("value" in descriptors[key])
  )) denied(path);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) output[key] = (descriptors[key] as PropertyDescriptor & { value: unknown }).value;
  return output;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function denied(path: string): never {
  throw new TypeError(`application profile denied at ${path}`);
}

// Compile-time reminder: the frozen wire catalog remains a strict subset.
void profileFactIds;
