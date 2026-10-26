import { types as utilTypes } from "node:util";

import {
  ContractParseError,
  parseApplicantProfile,
  profileFactIds,
  providerError,
  type ApplicantProfile,
  type CancellationError,
  type PortResult,
  type ProfileAnswerResult,
  type ProfileQuery,
  type ProfileQueryError,
  type ProfileQueryRequest,
} from "../contracts/index.ts";

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) return undefined;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function validRequest(value: unknown): value is ProfileQueryRequest {
  const request = exactDataRecord(value, [
    "profileId",
    "profileRevision",
    "factId",
  ]);
  return request !== undefined &&
    typeof request.profileId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.profileId) &&
    Number.isSafeInteger(request.profileRevision) &&
    (request.profileRevision as number) >= 0 &&
    typeof request.factId === "string" &&
    (profileFactIds as readonly string[]).includes(request.factId);
}

export function immutableApplicantProfile(value: unknown): ApplicantProfile {
  const profile = structuredClone(parseApplicantProfile(value));
  const factIds = new Set<string>();
  for (const [index, fact] of profile.facts.entries()) {
    if (factIds.has(fact.factId)) {
      throw new ContractParseError("invalid_value", `$.facts[${index}].factId`);
    }
    factIds.add(fact.factId);
    Object.freeze(fact);
  }
  Object.freeze(profile.facts);
  return Object.freeze(profile);
}

export function createProfileQuery(value: unknown): ProfileQuery {
  const profile = immutableApplicantProfile(value);
  const facts = new Map(profile.facts.map((fact) => [fact.factId, fact]));

  const provider: ProfileQuery = {
    async query(
      request: ProfileQueryRequest,
      signal: AbortSignal,
    ): Promise<PortResult<ProfileAnswerResult, ProfileQueryError | CancellationError>> {
      if (signal.aborted) {
        return { ok: false, error: providerError("operation_cancelled") };
      }
      if (!validRequest(request)) {
        return { ok: false, error: providerError("profile_query_invalid") };
      }
      if (request.profileId !== profile.profileId) {
        return { ok: false, error: providerError("profile_missing") };
      }
      if (request.profileRevision !== profile.revision) {
        return { ok: false, error: providerError("profile_revision_mismatch") };
      }
      const fact = facts.get(request.factId);
      if (fact === undefined) {
        return { ok: true, value: { kind: "profile_answer_missing" } };
      }
      return {
        ok: true,
        value: Object.freeze({
          kind: "answered",
          value: fact.value,
          provenance: fact.provenance,
        }),
      };
    },
  };
  return Object.freeze(provider);
}
