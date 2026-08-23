import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applicationProfileFactIds,
  parseApplicationProfile,
  type ApplicationProfile,
  type ApplicationProfileFact,
} from "../profile/application-profile.ts";
import { retainedDiscoveredIntakeFields } from "../form/questions/catalog.ts";

import {
  prepareStage2LiveRun,
  type Stage2ApplicationSourceInput,
} from "./s2-run-preparation.ts";
import {
  protectStage2StoragePaths,
  type Stage2StorageProtector,
} from "./private/s2-run-storage.ts";
import { readStablePrivateFile } from "./private/s2-stable-private-file.ts";
import { withDerivedProfileCountry } from "./private/s2-derived-profile-country.ts";

export interface Stage2RunPreparationArgs {
  readonly storageRoot: string;
  readonly targetUrl: string;
  readonly accountMode: "fresh_create" | "sign_in";
  readonly applicationProfilePath?: string;
  readonly trustedLegacyApplicationProfilePath?: string;
  readonly applicationResumePath?: string;
}

export function parseStage2RunPreparationArgs(
  values: readonly string[],
): Stage2RunPreparationArgs {
  if (values.length !== 6 && values.length !== 10) invalid();
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (
      key === undefined || value === undefined || parsed.has(key) ||
      ![
        "--storage-root", "--target-url", "--account-mode",
        "--application-profile", "--trusted-legacy-application-profile",
        "--application-resume",
      ].includes(key) ||
      /[\0\r\n"]/u.test(value)
    ) invalid();
    parsed.set(key, value);
  }
  const storageRoot = parsed.get("--storage-root");
  const targetUrl = parsed.get("--target-url");
  const accountMode = parsed.get("--account-mode");
  const applicationProfilePath = parsed.get("--application-profile");
  const trustedLegacyApplicationProfilePath = parsed.get("--trusted-legacy-application-profile");
  const applicationResumePath = parsed.get("--application-resume");
  const sourcePath = applicationProfilePath ?? trustedLegacyApplicationProfilePath;
  if (
    storageRoot === undefined || !isAbsolute(storageRoot) || normalize(storageRoot) !== storageRoot ||
    targetUrl === undefined ||
    (accountMode !== "fresh_create" && accountMode !== "sign_in") ||
    applicationProfilePath !== undefined && trustedLegacyApplicationProfilePath !== undefined ||
    ((sourcePath === undefined) !== (applicationResumePath === undefined)) ||
    (sourcePath !== undefined && !absoluteNormalized(sourcePath)) ||
    (applicationResumePath !== undefined && !absoluteNormalized(applicationResumePath))
  ) invalid();
  return Object.freeze({
    storageRoot,
    targetUrl,
    accountMode,
    ...(sourcePath === undefined
      ? {}
      : {
          ...(applicationProfilePath === undefined
            ? { trustedLegacyApplicationProfilePath }
            : { applicationProfilePath }),
          applicationResumePath,
        }),
  });
}

export async function runStage2RunPreparationCli(
  values: readonly string[],
  protector?: Stage2StorageProtector,
) {
  const args = parseStage2RunPreparationArgs(values);
  const profilePath = args.applicationProfilePath ?? args.trustedLegacyApplicationProfilePath;
  if (profilePath === undefined || args.applicationResumePath === undefined) {
    return prepareStage2LiveRun(args, protector);
  }
  const source = await loadApplicationSource(
    profilePath,
    args.applicationResumePath,
    protector,
    args.trustedLegacyApplicationProfilePath !== undefined,
  );
  try {
    return await prepareStage2LiveRun({
      storageRoot: args.storageRoot,
      targetUrl: args.targetUrl,
      accountMode: args.accountMode,
      applicationSource: source,
    }, protector);
  } finally {
    source.resume.bytes.fill(0);
  }
}

async function loadApplicationSource(
  profilePath: string,
  resumePath: string,
  protector?: Stage2StorageProtector,
  trustedLegacy = false,
): Promise<Stage2ApplicationSourceInput> {
  const executionerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (within(executionerRoot, profilePath) || within(executionerRoot, resumePath)) invalid();
  admitSourcePath(profilePath, 512 * 1024);
  admitSourcePath(resumePath, 5 * 1024 * 1024);
  await protectStage2StoragePaths([
    { path: profilePath, directory: false },
    { path: resumePath, directory: false },
  ], protector);
  let profileBytes: Buffer | undefined;
  let resumeBytes: Buffer | undefined;
  try {
    profileBytes = readStablePrivateFile(profilePath, 512 * 1024).bytes;
    resumeBytes = readStablePrivateFile(resumePath, 5 * 1024 * 1024).bytes;
    const parsed = JSON.parse(profileBytes.toString("utf8"));
    const value = trustedLegacy
      ? migrateTrustedLegacyApplicationProfile(parsed)
      : exact(parsed, [
      "schemaVersion", "sourceRevision", "resumeId", "profile",
      "profilePlan", "narrative",
    ]);
    if (
      value.schemaVersion !== 1 ||
      value.sourceRevision !== "s2-application-owner-profile-input-v1" ||
      typeof value.resumeId !== "string"
    ) invalid();
    const profile = structuredClone(parseApplicationProfile(
      normalizeOwnerProfile(value.profile),
    ));
    const derivedPlan = withDerivedProfileCountry(profile, value.profilePlan);
    const profilePlan = normalizeLearningPlan(derivedPlan);
    const narrative = structuredClone(value.narrative) as { readonly revision: string };
    const bytes = Buffer.from(resumeBytes);
    return Object.freeze({
      resume: Object.freeze({
        resumeId: value.resumeId,
        sha256: createHash("sha256").update(resumeBytes).digest("hex"),
        sizeBytes: resumeBytes.byteLength,
        fileType: "pdf" as const,
        bytes,
      }),
      profile,
      profilePlan,
      narrative,
    });
  } catch {
    return invalid();
  } finally {
    profileBytes?.fill(0);
    resumeBytes?.fill(0);
  }
}

function normalizeLearningPlan(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const plan = structuredClone(value) as {
    mode?: string;
    fields?: Array<{ answer?: { kind?: string; provenance?: string; lane?: string } }>;
    repeatables?: Array<{ rows?: Array<{ fields?: Array<{ answer?: { kind?: string; provenance?: string; lane?: string } }> }> }>;
  };
  const fields = [
    ...(plan.fields ?? []),
    ...(plan.repeatables ?? []).flatMap(({ rows = [] }) =>
      rows.flatMap(({ fields = [] }) => fields)
    ),
  ];
  let synthetic = plan.mode === "synthetic_test_non_submittable";
  for (const field of fields) {
    const answer = field.answer;
    if (answer?.kind !== "answered") continue;
    if (answer.lane === undefined) {
      answer.lane = answer.provenance === "generated_default"
        ? "synthetic_test_default"
        : "live_owner_fact";
    }
    if (answer.lane === "synthetic_test_default") synthetic = true;
  }
  if (synthetic) plan.mode = "synthetic_test_non_submittable";
  return plan;
}

function normalizeOwnerProfile(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const profile = structuredClone(value) as {
    facts?: Array<{ factId?: string; lane?: string }>;
    unsetFactIds?: string[];
    discoveredFields?: unknown[];
  };
  for (const fact of profile.facts ?? []) {
    if (fact.lane === undefined) fact.lane = "live_owner_fact";
  }
  if (profile.unsetFactIds === undefined) {
    const answered = new Set((profile.facts ?? []).map(({ factId }) => factId));
    profile.unsetFactIds = applicationProfileFactIds.filter((factId) =>
      !answered.has(factId)
    );
  }
  if (profile.discoveredFields === undefined) profile.discoveredFields = [];
  return profile;
}

const LEGACY_RESUME_FACT_IDS = new Set([
  "given_name", "family_name", "email_address", "city", "region",
]);
const OWNER_BOUND_PROVENANCE = new Set([
  "owner_provided", "resume_verified", "configured_template",
]);

export function migrateTrustedLegacyApplicationProfile(value: unknown): {
  readonly schemaVersion: 1;
  readonly sourceRevision: "s2-application-owner-profile-input-v1";
  readonly resumeId: string;
  readonly profile: ApplicationProfile;
  readonly profilePlan: unknown;
  readonly narrative: unknown;
} {
  const source = exact(value, [
    "schemaVersion", "sourceRevision", "resumeId", "profile", "profilePlan", "narrative",
  ]);
  if (source.schemaVersion !== 1 ||
      source.sourceRevision !== "s2-application-owner-profile-input-v1" ||
      typeof source.resumeId !== "string" ||
      typeof source.profilePlan !== "object" || source.profilePlan === null) invalid();
  const legacy = exact(source.profile, ["profileId", "revision", "facts"]);
  if (typeof legacy.profileId !== "string" ||
      !Number.isSafeInteger(legacy.revision) || (legacy.revision as number) < 0 ||
      !Array.isArray(legacy.facts)) invalid();
  const seen = new Set<string>();
  const facts: ApplicationProfileFact[] = [];
  for (const candidate of legacy.facts) {
    const fact = exact(candidate, ["factId", "value", "provenance"]);
    if (typeof fact.factId !== "string" || seen.has(fact.factId)) invalid();
    seen.add(fact.factId);
    if (!LEGACY_RESUME_FACT_IDS.has(fact.factId)) continue;
    if (!OWNER_BOUND_PROVENANCE.has(fact.provenance as string)) continue;
    if (typeof fact.value !== "string" || fact.value.trim() === "") invalid();
    facts.push(Object.freeze({
      factId: fact.factId as Extract<ApplicationProfileFact, { value: string }>["factId"],
      value: fact.value,
      provenance: fact.provenance as ApplicationProfileFact["provenance"],
      lane: "live_owner_fact",
    }));
  }
  const profile: ApplicationProfile = Object.freeze({
    profileId: legacy.profileId as ApplicationProfile["profileId"],
    revision: legacy.revision as number,
    facts: Object.freeze(facts),
    unsetFactIds: Object.freeze(applicationProfileFactIds.filter((factId) =>
      !facts.some((fact) => fact.factId === factId)
    )),
    discoveredFields: retainedDiscoveredIntakeFields(),
  });
  parseApplicationProfile(profile);
  const fact = (factId: "given_name" | "family_name") =>
    facts.find((candidate) => candidate.factId === factId);
  const fields = ([
    ["given_name", "identity.given_name"],
    ["family_name", "identity.family_name"],
  ] as const).flatMap(([factId, fieldId]) => {
    const sourceFact = fact(factId);
    return sourceFact === undefined ? [] : [{
      fieldId,
      questionType: "identity",
      answerType: "text",
      allowedOptions: [],
      answer: {
        kind: "answered",
        value: sourceFact.value,
        provenance: sourceFact.provenance,
        lane: "live_owner_fact",
      },
    }];
  });
  const profilePlan = withDerivedProfileCountry(profile, {
    mode: "live",
    pageType: "profile",
    fields,
    repeatables: [],
  });
  return Object.freeze({
    schemaVersion: 1,
    sourceRevision: "s2-application-owner-profile-input-v1",
    resumeId: source.resumeId,
    profile,
    profilePlan,
    narrative: Object.freeze({ revision: "trusted-legacy-owner-facts-only-v1" }),
  });
}

function admitSourcePath(path: string, maximumBytes: number): void {
  try {
    const stat = statSync(path);
    if (
      lstatSync(path).isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 ||
      stat.size < 1 || stat.size > maximumBytes ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))
    ) invalid();
  } catch {
    return invalid();
  }
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid();
  }
  return value as Record<string, unknown>;
}

function absoluteNormalized(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function invalid(): never {
  throw new TypeError("invalid Stage 2 run preparation arguments");
}
