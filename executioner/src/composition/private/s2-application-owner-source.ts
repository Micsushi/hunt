import {
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";

import {
  captureResumeArtifact,
  disposeResumeArtifact,
  upstreamResumeId,
  type ProfileId,
  type ProfileQuery,
  type ResolvedResumeArtifact,
} from "../../contracts/index.ts";
import {
  createProfileQuery,
  immutableApplicantProfile,
} from "../../profile/profile.ts";
import type { ProfilePagePlan } from "../../ats/workday/application/profile/index.ts";
import {
  createConfiguredNarrativeProvider,
  type ConfiguredNarrativeProvider,
} from "../../ats/workday/application/questions/index.ts";
import {
  createWorkdayResumeFileIntent,
  type WorkdayResumeFileIntent,
} from "../../ats/workday/application/resume/index.ts";
import { readStablePrivateFile } from "./s2-stable-private-file.ts";

const PROFILE_FILE = "application-profile.json";
const RESUME_FILE = "application-resume.pdf";
const MAX_PROFILE_BYTES = 512 * 1024;
const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const opaque = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface Stage2ApplicationOwnerSourceRequest {
  readonly runtimeRoot: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly profileRef: string;
  readonly resumeRef: string;
  readonly approvedAt: string;
}

export interface Stage2ApplicationOwnerSources {
  readonly resumeIntent: WorkdayResumeFileIntent;
  readonly profilePlan: ProfilePagePlan;
  readonly profileId: ProfileId;
  readonly profileRevision: number;
  readonly profileQuery: ProfileQuery;
  readonly narrative: ConfiguredNarrativeProvider;
  readonly sensitiveValues: readonly string[];
}

export interface Stage2ApplicationOwnerSourceResolver {
  resolve(
    request: Stage2ApplicationOwnerSourceRequest,
    signal: AbortSignal,
  ): Promise<Stage2ApplicationOwnerSources>;
}

export class FileBackedStage2ApplicationOwnerSourceResolver
  implements Stage2ApplicationOwnerSourceResolver
{
  readonly #forbiddenRoots: readonly string[];

  constructor(options: { readonly forbiddenRoots: readonly string[] }) {
    this.#forbiddenRoots = options.forbiddenRoots;
  }

  async resolve(
    request: Stage2ApplicationOwnerSourceRequest,
    signal: AbortSignal,
  ): Promise<Stage2ApplicationOwnerSources> {
    let artifact: ResolvedResumeArtifact | undefined;
    try {
      if (signal.aborted || !validRequest(request)) denied();
      const runtimeRoot = admittedRoot(request.runtimeRoot, this.#forbiddenRoots);
      const approvalTime = Date.parse(request.approvedAt);
      const profileBytes = readStablePrivateFile(
        join(runtimeRoot, PROFILE_FILE),
        MAX_PROFILE_BYTES,
        { notModifiedAfterMs: approvalTime },
      ).bytes;
      let value: unknown;
      try {
        if (profileBytes[0] === 0xef && profileBytes[1] === 0xbb && profileBytes[2] === 0xbf) {
          denied();
        }
        value = JSON.parse(profileBytes.toString("utf8"));
      } finally {
        profileBytes.fill(0);
      }
      const manifest = parseManifest(value, request);
      const resumeBytes = readStablePrivateFile(
        join(runtimeRoot, RESUME_FILE),
        MAX_RESUME_BYTES,
        { notModifiedAfterMs: approvalTime },
      ).bytes;
      try {
        if (
          resumeBytes.byteLength !== manifest.resume.sizeBytes ||
          resumeBytes.subarray(0, 5).toString("ascii") !== "%PDF-"
        ) denied();
        const captured = captureResumeArtifact({
          resumeId: upstreamResumeId(manifest.resume.resumeId),
          sha256: manifest.resume.sha256,
        }, resumeBytes);
        if (!captured.ok) denied();
        artifact = captured.value;
      } finally {
        resumeBytes.fill(0);
      }
      const intent = createWorkdayResumeFileIntent({
        artifactId: artifact.resumeId,
        artifact,
        fileType: "pdf",
      });
      if (!intent.ok) denied();
      const profile = immutableApplicantProfile(manifest.profile);
      const profilePlan = validateProfileAuthority(
        manifest.profilePlan,
        profile.facts,
      );
      const narrativeFact = profile.facts.find(({ factId }) =>
        factId === "configured_narrative"
      );
      if (
        narrativeFact === undefined ||
        typeof narrativeFact.value !== "string" ||
        narrativeFact.provenance !== "configured_template"
      ) denied();
      return Object.freeze({
        resumeIntent: intent.value,
        profilePlan,
        profileId: profile.profileId,
        profileRevision: profile.revision,
        profileQuery: createProfileQuery(profile),
        narrative: createConfiguredNarrativeProvider({
          revision: manifest.narrative.revision,
          template: narrativeFact.value,
        }),
        sensitiveValues: applicationSourceSensitiveValues(
          profile.facts,
          profilePlan,
          manifest.resume.sha256,
        ),
      });
    } catch {
      if (artifact !== undefined) disposeResumeArtifact(artifact);
      return denied();
    }
  }
}

interface ParsedManifest {
  readonly resume: {
    readonly resumeId: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly profile: unknown;
  readonly profilePlan: unknown;
  readonly narrative: { readonly revision: string };
}

function parseManifest(
  value: unknown,
  request: Stage2ApplicationOwnerSourceRequest,
): ParsedManifest {
  const manifest = exact(value, [
    "schemaVersion", "sourceRevision", "scope", "revisionId", "approvalId",
    "journeyId", "targetHandleId", "profileRef", "resumeRef", "approvedAt", "resume",
    "profile", "profilePlan", "narrative",
  ]);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.sourceRevision !== "s2-application-owner-source-v1" ||
    manifest.scope !== "application_completion" ||
    manifest.revisionId !== request.revisionId ||
    manifest.approvalId !== request.approvalId ||
    manifest.journeyId !== request.journeyId ||
    manifest.targetHandleId !== request.targetHandleId ||
    manifest.profileRef !== request.profileRef ||
    manifest.resumeRef !== request.resumeRef ||
    manifest.approvedAt !== request.approvedAt
  ) denied();
  const resume = exact(manifest.resume, [
    "resumeId", "sha256", "sizeBytes", "fileType",
  ]);
  if (
    !stringMatches(resume.resumeId, opaque) ||
    !stringMatches(resume.sha256, /^[a-f0-9]{64}$/u) ||
    !Number.isSafeInteger(resume.sizeBytes) ||
    (resume.sizeBytes as number) < 1 ||
    (resume.sizeBytes as number) > MAX_RESUME_BYTES ||
    resume.fileType !== "pdf"
  ) denied();
  const narrative = exact(manifest.narrative, ["revision"]);
  if (!stringMatches(narrative.revision, opaque)) denied();
  return {
    resume: resume as unknown as ParsedManifest["resume"],
    profile: manifest.profile,
    profilePlan: manifest.profilePlan,
    narrative: narrative as unknown as ParsedManifest["narrative"],
  };
}

function validateProfileAuthority(
  value: unknown,
  facts: readonly { readonly factId: string; readonly value: unknown; readonly provenance: string }[],
): ProfilePagePlan {
  const plan = exact(value, ["pageType", "fields", "repeatables"]);
  if ((plan.pageType !== "profile" && plan.pageType !== "contact") ||
      !Array.isArray(plan.fields) || plan.fields.length > 128 ||
      !Array.isArray(plan.repeatables) || plan.repeatables.length > 3) denied();
  const factByField: Readonly<Record<string, string>> = {
    "identity.given_name": "given_name",
    "identity.family_name": "family_name",
    "identity.preferred_name": "preferred_name",
    "address.city": "city",
    "address.region": "region",
    "address.country": "country",
    "address.postal_code": "postal_code",
    "phone.number": "phone_number",
    "experience.company": "current_company",
    "experience.title": "current_title",
    "education.degree": "highest_education",
  };
  const factsById = new Map(facts.map((fact) => [fact.factId, fact]));
  const fields: unknown[] = [...plan.fields];
  const sections = new Set<string>();
  for (const value of plan.repeatables) {
    const repeatable = exact(value, ["section", "rows"]);
    if (
      !new Set(["experience", "education", "skills"]).has(
        repeatable.section as string,
      ) ||
      sections.has(repeatable.section as string) ||
      !Array.isArray(repeatable.rows) ||
      repeatable.rows.length > 64
    ) denied();
    sections.add(repeatable.section as string);
    const rowKeys = new Set<string>();
    for (const value of repeatable.rows) {
      const row = exact(value, ["rowKey", "fields"]);
      if (
        !stringMatches(row.rowKey, opaque) ||
        rowKeys.has(row.rowKey) ||
        !Array.isArray(row.fields) ||
        row.fields.length < 1 ||
        row.fields.length > 32
      ) denied();
      rowKeys.add(row.rowKey);
      fields.push(...row.fields);
    }
  }
  if (fields.length > 512) denied();
  for (const value of fields) {
    const field = exact(value, [
      "fieldId", "questionType", "answerType", "answer", "optionMapping",
    ], true);
    const answer = exact(field.answer, ["kind", "value", "provenance"]);
    if (
      !stringMatches(field.fieldId, /^[a-z][a-z0-9_.-]{0,127}$/u) ||
      !new Set(["identity", "address", "phone", "experience", "education", "skill"])
        .has(field.questionType as string) ||
      !new Set(["text", "phone", "date", "option"])
        .has(field.answerType as string) ||
      answer.kind !== "answered" ||
      typeof answer.value !== "string" ||
      answer.value.trim() === ""
    ) denied();
    if (field.answerType === "option") {
      const mapping = exact(field.optionMapping, [
        "canonicalValue", "visibleOption", "provenance",
      ]);
      if (
        mapping.canonicalValue !== answer.value ||
        typeof mapping.visibleOption !== "string" ||
        mapping.visibleOption.trim() === "" ||
        mapping.provenance !== "visible_option"
      ) denied();
    } else if (field.optionMapping !== undefined) denied();
    if (answer.provenance === "owner_provided" || answer.provenance === "configured_template") {
      const factId = factByField[field.fieldId];
      const fact = factId === undefined ? undefined : factsById.get(factId);
      if (fact === undefined || fact.value !== answer.value || fact.provenance !== answer.provenance) {
        denied();
      }
    } else if (answer.provenance !== "resume_verified") denied();
  }
  return deepFreeze(structuredClone(plan)) as unknown as ProfilePagePlan;
}

function validRequest(request: Stage2ApplicationOwnerSourceRequest): boolean {
  return stringMatches(request.revisionId, /^revision_[A-Za-z0-9_-]{16,64}$/u) &&
    stringMatches(request.approvalId, /^approval_[A-Za-z0-9_-]{16,64}$/u) &&
    stringMatches(request.journeyId, /^journey_[A-Za-z0-9_-]{16,64}$/u) &&
    stringMatches(request.targetHandleId, /^target_ref_[A-Za-z0-9_-]{16,64}$/u) &&
    stringMatches(request.profileRef, /^profile_ref_[A-Za-z0-9_-]{16,64}$/u) &&
    stringMatches(request.resumeRef, /^resume_ref_[A-Za-z0-9_-]{16,64}$/u) &&
    Number.isFinite(Date.parse(request.approvedAt));
}

function admittedRoot(value: string, forbiddenRoots: readonly string[]): string {
  if (!isAbsolute(value) || normalize(value) !== value || forbiddenRoots.length === 0) denied();
  const root = realpathSync.native(value);
  if (
    comparable(root) !== comparable(resolve(value)) ||
    lstatSync(value).isSymbolicLink() ||
    !statSync(value).isDirectory()
  ) denied();
  for (const forbiddenValue of forbiddenRoots) {
    if (!isAbsolute(forbiddenValue)) denied();
    const forbidden = realpathSync.native(forbiddenValue);
    if (within(forbidden, root) || within(root, forbidden)) denied();
  }
  return root;
}

function applicationSourceSensitiveValues(
  facts: readonly { readonly value: unknown }[],
  profilePlan: unknown,
  digest: string,
): readonly string[] {
  const values = new Set<string>([digest]);
  for (const fact of facts) {
    if (typeof fact.value === "string" && fact.value.length > 0) {
      values.add(fact.value);
    }
  }
  const plan = profilePlan as {
    readonly fields?: readonly unknown[];
    readonly repeatables?: readonly { readonly rows?: readonly { readonly fields?: readonly unknown[] }[] }[];
  };
  const planned = [
    ...(plan.fields ?? []),
    ...(plan.repeatables ?? []).flatMap(({ rows = [] }) =>
      rows.flatMap(({ fields = [] }) => fields)
    ),
  ];
  for (const value of planned) {
    if (typeof value !== "object" || value === null) continue;
    const field = value as {
      readonly answer?: { readonly value?: unknown };
      readonly optionMapping?: {
        readonly canonicalValue?: unknown;
        readonly visibleOption?: unknown;
      };
    };
    addSensitive(field.answer?.value, values);
    addSensitive(field.optionMapping?.canonicalValue, values);
    addSensitive(field.optionMapping?.visibleOption, values);
  }
  return Object.freeze([...values]);
}

function addSensitive(value: unknown, output: Set<string>): void {
  if (typeof value === "string" && value.length > 0) output.add(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function exact(
  value: unknown,
  keys: readonly string[],
  allowMissingOptionMapping = false,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied();
  const actual = Object.keys(value).sort();
  const expected = keys.filter((key) =>
    !(allowMissingOptionMapping && key === "optionMapping" && !(key in value))
  ).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    denied();
  }
  return value as Record<string, unknown>;
}

function stringMatches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function denied(): never {
  throw new TypeError("application owner source denied");
}
