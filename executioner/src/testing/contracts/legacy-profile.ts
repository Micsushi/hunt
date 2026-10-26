import type { ProfileAnswerProvenance } from "../../contracts/index.ts";
import {
  applicationBooleanProfileFactIds,
  applicationNumberProfileFactIds,
  applicationProfileFactIds,
  applicationTextProfileFactIds,
  type ApplicationProfileFactId,
} from "../../form/answers/application-types.ts";

export interface SyntheticTestProfileFact {
  readonly factId: ApplicationProfileFactId;
  readonly value: string | boolean | number;
  readonly provenance: ProfileAnswerProvenance;
  readonly lane: "synthetic_test_default";
}

export interface SyntheticLegacyProfileFixture {
  readonly mode: "synthetic_test_non_submittable";
  readonly submittable: false;
  readonly profileId: string;
  readonly revision: number;
  readonly facts: readonly SyntheticTestProfileFact[];
  readonly unsetFactIds: readonly ApplicationProfileFactId[];
  readonly discoveredFields: readonly never[];
}

/** Test-only migration knowledge. Its result is deliberately not an ApplicantProfile. */
export function migrateLegacyV2ProfileFixture(value: unknown): SyntheticLegacyProfileFixture {
  if (!record(value) || !exactKeys(value, ["profileId", "revision", "facts"]) ||
      typeof value.profileId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.profileId) ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
      !Array.isArray(value.facts)) denied();
  const seen = new Set<ApplicationProfileFactId>();
  const facts = value.facts.map((candidate) => {
    if (!record(candidate) || !exactKeys(candidate, ["factId", "value", "provenance"]) ||
        typeof candidate.factId !== "string" ||
        !(applicationProfileFactIds as readonly string[]).includes(candidate.factId) ||
        seen.has(candidate.factId as ApplicationProfileFactId) ||
        !["owner_provided", "resume_verified", "configured_template"]
          .includes(candidate.provenance as string)) denied();
    const factId = candidate.factId as ApplicationProfileFactId;
    if ((applicationTextProfileFactIds as readonly string[]).includes(factId)) {
      if (typeof candidate.value !== "string") denied();
    } else if ((applicationBooleanProfileFactIds as readonly string[]).includes(factId)) {
      if (typeof candidate.value !== "boolean") denied();
    } else if (
      !(applicationNumberProfileFactIds as readonly string[]).includes(factId) ||
      typeof candidate.value !== "number" || !Number.isFinite(candidate.value) ||
      candidate.value < 0
    ) denied();
    seen.add(factId);
    return Object.freeze({
      factId,
      value: candidate.value as string | boolean | number,
      provenance: candidate.provenance as ProfileAnswerProvenance,
      lane: "synthetic_test_default" as const,
    });
  });
  return Object.freeze({
    mode: "synthetic_test_non_submittable",
    submittable: false,
    profileId: value.profileId,
    revision: value.revision as number,
    facts: Object.freeze(facts),
    unsetFactIds: Object.freeze(applicationProfileFactIds.filter((factId) => !seen.has(factId))),
    discoveredFields: Object.freeze([]),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key, index) => keys[index] === key);
}

function denied(): never {
  throw new TypeError("legacy V2 profile fixture denied");
}
