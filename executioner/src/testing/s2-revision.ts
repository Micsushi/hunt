import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { s2CommonWireVersions } from "../contracts/s2-common-serialized.ts";
import {
  liveClassificationVersions,
  liveContractVersions,
} from "../contracts/live/index.ts";

export const acceptedStage1Base =
  "87c77e538d8bba378ec93516dbea3f4747beb822" as const;

export const s2ContractSource =
  "b3bda9517656f9352cd9fd50cdb1715049b0c378" as const;

export const s2ContractSourceTree =
  "e2651d236bf0f2e6c3e73ffd4d1882ee67782886" as const;

export const s2ContractRevisionStatus = "frozen" as const;

export const s2FrozenTreePaths = [
  "executioner/src/contracts",
  "executioner/src/contracts/live",
  "executioner/src/control/orchestrator/live",
  "executioner/src/testing/live",
  "executioner/tests/live/contracts",
  "executioner/tests/live/walking-skeleton",
] as const;

export const s2AllowedTargetAdapters = [
  "windows-dpapi-current-user-v1",
  "gmail-api-v1",
] as const;

const revisionRecordPath = join(
  "executioner",
  "docs",
  "s2-contract-revision.json",
);
const frozenPathspecs = s2FrozenTreePaths.map((path) => `:(top)${path}`);

export interface S2ContractRevisionRecord {
  readonly schemaVersion: 1;
  readonly status: "frozen";
  readonly acceptedStage1Base: typeof acceptedStage1Base;
  readonly s2ContractSource: typeof s2ContractSource;
  readonly s2ContractSourceTree: typeof s2ContractSourceTree;
  readonly contractTreeOids: Readonly<Record<string, string>>;
  readonly serializedVersions: {
    readonly commonWire: Readonly<Record<string, number>>;
    readonly liveContracts: Readonly<Record<string, number>>;
    readonly liveClassification: Readonly<Record<string, number>>;
  };
  readonly allowedTargetAdapters: readonly string[];
}

export function readS2ContractRevision(
  repository: string,
): S2ContractRevisionRecord {
  return JSON.parse(
    readFileSync(join(repository, revisionRecordPath), "utf8"),
  ) as S2ContractRevisionRecord;
}

export function assertS2FrozenContractBase(
  revision: string,
  repository: string,
): void {
  const record = readS2ContractRevision(repository);
  assertRevisionRecord(record);
  let ancestryRevision = revision;
  let frozenRevision = revision;
  try { git(repository, "merge-base", "--is-ancestor", acceptedStage1Base, revision); }
  catch {
    // A selective squash retains verified source objects without importing trial history.
    if (revision !== "HEAD") throw new Error(`S2 contract base ancestry mismatch: accepted Stage 1 base ${acceptedStage1Base} is not an ancestor of ${revision}`);
    const release = assertReleaseContractProvenance(repository, s2FrozenTreePaths);
    ancestryRevision = release.sourceRevision;
    frozenRevision = release.contractFreezeRevision;
    assertAncestor(s2ContractSource, frozenRevision, repository, "Stage 2 contract source");
    assertAncestor(frozenRevision, ancestryRevision, repository, "accepted contract freeze");
  }
  assertAncestor(
    acceptedStage1Base,
    ancestryRevision,
    repository,
    "accepted Stage 1 base",
  );
  assertAncestor(
    s2ContractSource,
    ancestryRevision,
    repository,
    "Stage 2 contract source",
  );
  const sourceTree = git(
    repository,
    "rev-parse",
    `${s2ContractSource}^{tree}`,
  ).trim();
  if (sourceTree !== s2ContractSourceTree) {
    throw new Error(
      `S2 contract source tree mismatch: expected ${s2ContractSourceTree}, received ${sourceTree}`,
    );
  }
  assertS2FrozenRootsClean(revision, repository);

  for (const path of s2FrozenTreePaths) {
    const actual = git(repository, "rev-parse", `${frozenRevision}:${path}`).trim();
    if (record.contractTreeOids[path] !== actual) {
      throw new Error(
        `S2 contract tree mismatch: ${path}: expected ${record.contractTreeOids[path]}, received ${actual}`,
      );
    }
  }
}

/** Verify the reviewed squash and reject any later frozen-root drift. */
export function assertReleaseContractProvenance(repository: string, roots: readonly string[]) {
  const release = JSON.parse(readFileSync(join(repository, "executioner/docs/release-provenance.json"), "utf8"));
  if (release.schemaVersion !== 1 ||
      release.sourceRevision !== "26325870cc577d02046553672e3eb7b17ede0da6" ||
      release.integrationRevision !== "09e0cd0b1b83f121801cc6ef2e2e8e16e2d0b601" ||
      release.contractFreezeRevision !== "63218cbcbec87d420d1fda6924a6e7a220491518") {
    throw new Error("release provenance identity mismatch");
  }
  git(repository, "merge-base", "--is-ancestor", release.integrationRevision, "HEAD");
  for (const [revision, tree] of [[release.sourceRevision, release.sourceTree],
    [release.integrationRevision, release.integrationTree]]) {
    if (git(repository, "rev-parse", `${revision}^{tree}`).trim() !== tree) throw new Error("release provenance tree mismatch");
  }
  // Raw blob transitions are independent of checkout line endings and diff formatting.
  const delta = git(repository, "diff-tree", "-r", "--raw", "--no-abbrev", "--no-renames",
    release.sourceRevision, release.integrationRevision);
  if (createHash("sha256").update(delta).digest("hex") !== release.integrationBlobDeltaSha256) {
    throw new Error("release provenance blob delta mismatch");
  }
  for (const path of roots) {
    if (git(repository, "rev-parse", `HEAD:${path}`).trim() !==
        git(repository, "rev-parse", `${release.integrationRevision}:${path}`).trim() ||
        git(repository, "diff", "--name-only", "HEAD", "--", path).trim() !== "" ||
        git(repository, "ls-files", "--others", "--exclude-standard", "--", path).trim() !== "") {
      throw new Error(`release contract tree mismatch: ${path}`);
    }
  }
  return release as { sourceRevision: string; contractFreezeRevision: string };
}

function assertRevisionRecord(record: S2ContractRevisionRecord): void {
  if (
    !sameKeys(record as unknown as Readonly<Record<string, unknown>>, [
      "schemaVersion",
      "status",
      "acceptedStage1Base",
      "s2ContractSource",
      "s2ContractSourceTree",
      "contractTreeOids",
      "serializedVersions",
      "allowedTargetAdapters",
    ]) ||
    record.schemaVersion !== 1 ||
    record.status !== s2ContractRevisionStatus ||
    record.acceptedStage1Base !== acceptedStage1Base ||
    record.s2ContractSource !== s2ContractSource ||
    record.s2ContractSourceTree !== s2ContractSourceTree ||
    !sameKeys(record.contractTreeOids, s2FrozenTreePaths) ||
    !Object.values(record.contractTreeOids).every((oid) =>
      /^[0-9a-f]{40}$/u.test(oid),
    ) ||
    !sameKeys(record.serializedVersions, [
      "commonWire",
      "liveContracts",
      "liveClassification",
    ]) ||
    !sameMap(record.serializedVersions.commonWire, s2CommonWireVersions) ||
    !sameMap(record.serializedVersions.liveContracts, liveContractVersions) ||
    !sameMap(
      record.serializedVersions.liveClassification,
      liveClassificationVersions,
    ) ||
    record.allowedTargetAdapters.join("\n") !==
      s2AllowedTargetAdapters.join("\n")
  ) {
    throw new Error("S2 contract revision record mismatch");
  }
}

export function assertS2FrozenRootsClean(
  revision: string,
  repository: string,
): void {
  const dirty = git(
    repository,
    "diff",
    "--name-only",
    revision,
    "--",
    ...frozenPathspecs,
  ).trim();
  if (dirty !== "") {
    throw new Error(`dirty S2 frozen root: ${dirty}`);
  }

  const untracked = git(
    repository,
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ...frozenPathspecs,
  ).trim();
  if (untracked !== "") {
    throw new Error(`untracked S2 frozen root file: ${untracked}`);
  }
}

function assertAncestor(
  ancestor: string,
  revision: string,
  repository: string,
  label: string,
): void {
  try {
    git(repository, "merge-base", "--is-ancestor", ancestor, revision);
  } catch {
    throw new Error(
      `S2 contract base ancestry mismatch: ${label} ${ancestor} is not an ancestor of ${revision}`,
    );
  }
}

function sameMap(
  value: Readonly<Record<string, number>>,
  expected: Readonly<Record<string, number>>,
): boolean {
  return (
    sameKeys(value, Object.keys(expected)) &&
    Object.entries(expected).every(([name, version]) => value[name] === version)
  );
}

function sameKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join("\n") === [...expected].sort().join("\n")
  );
}

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
