import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import {
  admitApplicationExecutionPolicy,
  answerModeForPolicy,
  type ApplicationExecutionPolicy,
} from "../../contracts/application-execution-policy.ts";
import { parseApplicationProfile } from "../../profile/application-profile.ts";

export interface Stage2ApplicationSourceInput {
  readonly resume: {
    readonly resumeId: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly fileType: "pdf";
    readonly bytes: Uint8Array;
  };
  readonly profile: unknown;
  readonly profilePlan: unknown;
  readonly executionPolicy: ApplicationExecutionPolicy;
  readonly narrative: { readonly revision: string };
}

export function writePrivateFileAtomic(path: string, payload: Uint8Array): void {
  const partial = `${path}.partial-${randomBytes(16).toString("hex")}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(partial, "wx", 0o600);
    writeFileSync(descriptor, payload);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(partial, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(partial);
    } catch {
      // The exact run root is removed by the caller on failure.
    }
    throw error;
  }
}

export async function approvalAfterSourceFiles(
  paths: readonly string[],
  clock: () => string,
): Promise<string> {
  const latestSourceNs = paths.reduce((latest, path) => {
    const stat = statSync(path, { bigint: true });
    return stat.ctimeNs > latest ? stat.ctimeNs : latest;
  }, 0n);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const candidate = canonicalTimestamp(clock());
    if (BigInt(Date.parse(candidate)) * 1_000_000n >= latestSourceNs) return candidate;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  return denied();
}

export function snapshotApplicationSource(
  value: Stage2ApplicationSourceInput,
): Stage2ApplicationSourceInput {
  validateApplicationSource(value);
  const profile = structuredClone(value.profile);
  const profilePlan = structuredClone(value.profilePlan);
  const executionPolicy = structuredClone(value.executionPolicy);
  const narrative = structuredClone(value.narrative);
  const bytes = Buffer.from(value.resume.bytes);
  const snapshot = Object.freeze({
    resume: Object.freeze({
      resumeId: value.resume.resumeId,
      sha256: value.resume.sha256,
      sizeBytes: value.resume.sizeBytes,
      fileType: value.resume.fileType,
      bytes,
    }),
    profile,
    profilePlan,
    executionPolicy,
    narrative,
  });
  try {
    validateApplicationSource(snapshot);
    return snapshot;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

function validateApplicationSource(value: Stage2ApplicationSourceInput): void {
  const resume = value?.resume;
  if (
    typeof value !== "object" || value === null ||
    typeof resume !== "object" || resume === null ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(resume.resumeId) ||
    !/^[a-f0-9]{64}$/u.test(resume.sha256) ||
    !Number.isSafeInteger(resume.sizeBytes) || resume.sizeBytes < 1 ||
    resume.sizeBytes > 5 * 1024 * 1024 || resume.fileType !== "pdf" ||
    !(resume.bytes instanceof Uint8Array) || resume.bytes.byteLength !== resume.sizeBytes ||
    Buffer.from(resume.bytes.subarray(0, 5)).toString("ascii") !== "%PDF-" ||
    createHash("sha256").update(resume.bytes).digest("hex") !== resume.sha256 ||
    typeof value.profile !== "object" || value.profile === null ||
    typeof value.profilePlan !== "object" || value.profilePlan === null ||
    typeof value.narrative !== "object" || value.narrative === null ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.narrative.revision)
  ) denied();
  try {
    parseApplicationProfile(value.profile);
  } catch {
    denied();
  }
  const plan = value.profilePlan as Record<string, unknown>;
  let executionPolicy: ApplicationExecutionPolicy;
  try { executionPolicy = admitApplicationExecutionPolicy(value.executionPolicy); }
  catch { return denied(); }
  if (
    (plan.mode !== "live" && plan.mode !== "synthetic_test_non_submittable") ||
    answerModeForPolicy(executionPolicy) !== plan.mode ||
    !Array.isArray(plan.fields) || !Array.isArray(plan.repeatables)
  ) denied();
  const fields = [
    ...plan.fields,
    ...plan.repeatables.flatMap((repeatable) =>
      typeof repeatable === "object" && repeatable !== null &&
        Array.isArray((repeatable as { rows?: unknown }).rows)
        ? (repeatable as { rows: unknown[] }).rows.flatMap((row) =>
            typeof row === "object" && row !== null &&
              Array.isArray((row as { fields?: unknown }).fields)
              ? (row as { fields: unknown[] }).fields
              : []
          )
        : []
    ),
  ];
  if (fields.some((field) => {
    if (typeof field !== "object" || field === null) return true;
    const answer = (field as { answer?: unknown }).answer;
    if (typeof answer !== "object" || answer === null) return true;
    const candidate = answer as { kind?: unknown; lane?: unknown; provenance?: unknown };
    if (candidate.kind !== "answered") return false;
    if (plan.mode === "live") {
      return candidate.lane !== "live_owner_fact" || candidate.provenance === "generated_default";
    }
    return candidate.lane === "synthetic_test_default"
      ? candidate.provenance !== "generated_default"
      : candidate.lane !== "live_owner_fact" || candidate.provenance === "generated_default";
  })) denied();
}

export function canonicalTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) denied();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) denied();
  return value;
}

function denied(): never {
  throw new Error("run preparation denied");
}
