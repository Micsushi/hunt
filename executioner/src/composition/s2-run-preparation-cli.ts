import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
        "--application-profile", "--application-resume",
      ].includes(key) ||
      /[\0\r\n"]/u.test(value)
    ) invalid();
    parsed.set(key, value);
  }
  const storageRoot = parsed.get("--storage-root");
  const targetUrl = parsed.get("--target-url");
  const accountMode = parsed.get("--account-mode");
  const applicationProfilePath = parsed.get("--application-profile");
  const applicationResumePath = parsed.get("--application-resume");
  if (
    storageRoot === undefined || !isAbsolute(storageRoot) || normalize(storageRoot) !== storageRoot ||
    targetUrl === undefined ||
    (accountMode !== "fresh_create" && accountMode !== "sign_in") ||
    ((applicationProfilePath === undefined) !== (applicationResumePath === undefined)) ||
    (applicationProfilePath !== undefined && !absoluteNormalized(applicationProfilePath)) ||
    (applicationResumePath !== undefined && !absoluteNormalized(applicationResumePath))
  ) invalid();
  return Object.freeze({
    storageRoot,
    targetUrl,
    accountMode,
    ...(applicationProfilePath === undefined
      ? {}
      : { applicationProfilePath, applicationResumePath }),
  });
}

export async function runStage2RunPreparationCli(
  values: readonly string[],
  protector?: Stage2StorageProtector,
) {
  const args = parseStage2RunPreparationArgs(values);
  if (args.applicationProfilePath === undefined || args.applicationResumePath === undefined) {
    return prepareStage2LiveRun(args, protector);
  }
  const source = await loadApplicationSource(
    args.applicationProfilePath,
    args.applicationResumePath,
    protector,
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
    const value = exact(JSON.parse(profileBytes.toString("utf8")), [
      "schemaVersion", "sourceRevision", "resumeId", "profile",
      "profilePlan", "narrative",
    ]);
    if (
      value.schemaVersion !== 1 ||
      value.sourceRevision !== "s2-application-owner-profile-input-v1" ||
      typeof value.resumeId !== "string"
    ) invalid();
    const profile = structuredClone(value.profile);
    const profilePlan = structuredClone(withDerivedProfileCountry(profile, value.profilePlan));
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
