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
  "7bb1722fca3ab8807965ee39a212ad2c01f2cf87" as const;

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
  assertAncestor(
    acceptedStage1Base,
    revision,
    repository,
    "accepted Stage 1 base",
  );
  assertAncestor(
    s2ContractSource,
    revision,
    repository,
    "Stage 2 contract source",
  );
  assertS2FrozenRootsClean(revision, repository);

  for (const path of s2FrozenTreePaths) {
    const actual = git(repository, "rev-parse", `${revision}:${path}`).trim();
    if (record.contractTreeOids[path] !== actual) {
      throw new Error(
        `S2 contract tree mismatch: ${path}: expected ${record.contractTreeOids[path]}, received ${actual}`,
      );
    }
  }
}

function assertRevisionRecord(record: S2ContractRevisionRecord): void {
  if (
    !sameKeys(record as unknown as Readonly<Record<string, unknown>>, [
      "schemaVersion",
      "status",
      "acceptedStage1Base",
      "s2ContractSource",
      "contractTreeOids",
      "serializedVersions",
      "allowedTargetAdapters",
    ]) ||
    record.schemaVersion !== 1 ||
    record.status !== s2ContractRevisionStatus ||
    record.acceptedStage1Base !== acceptedStage1Base ||
    record.s2ContractSource !== s2ContractSource ||
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
