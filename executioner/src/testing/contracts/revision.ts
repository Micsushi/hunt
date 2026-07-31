import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { serializedContractVersions } from "../../contracts/serialized.ts";

export const historicalContractRevision =
  "d95e845e61bcf0a030b3b07c6d6261e3d95c1fad" as const;

export const historicalR1Revision =
  "c57c24ef59aec6dd6e2ee8f222aa64695777a0dd" as const;

export const planningRevision =
  "8c5785abf4f0d08dba871744cda006e906dab051" as const;

export const contractRevisionStatus = "r2_frozen" as const;

const contractPath = ":(top)executioner/src/contracts";
const revisionRecordPath = join(
  "executioner",
  "docs",
  "contract-revision.json",
);
const frozenTreePaths = [
  "executioner/src/contracts",
  "executioner/src/testing/contracts",
  "executioner/tests/contracts",
  "executioner/tests/security/privacy",
] as const;

interface ContractRevisionRecord {
  readonly schemaVersion: number;
  readonly historicalR1: string;
  readonly contractSource: string;
  readonly planningRevision: string;
  readonly contractTreeOids: Readonly<Record<string, string>>;
  readonly serializedVersions: Readonly<Record<string, number>>;
}

export function assertFrozenContractTree(
  revision: string,
  repository: string,
): void {
  execFileSync(
    "git",
    ["diff", "--exit-code", revision, "--", contractPath],
    { cwd: repository, stdio: "pipe" },
  );

  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", contractPath],
    { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (untracked !== "") {
    throw new Error(`untracked contract file: ${untracked}`);
  }
}

export function assertFrozenContractBase(
  revision: string,
  repository: string,
  treeish = revision,
): void {
  const record = JSON.parse(
    readFileSync(join(repository, revisionRecordPath), "utf8"),
  ) as ContractRevisionRecord;
  assertRevisionRecord(record);
  assertAncestor(record.planningRevision, revision, repository, "planning revision");
  assertAncestor(record.historicalR1, revision, repository, "historical R1");
  assertAncestor(record.contractSource, revision, repository, "contract source");

  for (const path of frozenTreePaths) {
    const actual = git(repository, "rev-parse", `${treeish}:${path}`).trim();
    if (record.contractTreeOids[path] !== actual) {
      throw new Error(
        `contract tree mismatch: ${path}: expected ${record.contractTreeOids[path]}, received ${actual}`,
      );
    }
  }
}

function assertRevisionRecord(record: ContractRevisionRecord): void {
  if (
    record.schemaVersion !== 1 ||
    record.historicalR1 !== historicalR1Revision ||
    record.contractSource !== historicalContractRevision ||
    record.planningRevision !== planningRevision ||
    !sameKeys(record.contractTreeOids, frozenTreePaths) ||
    !Object.values(record.contractTreeOids).every((oid) =>
      /^[0-9a-f]{40}$/u.test(oid),
    ) ||
    !sameKeys(record.serializedVersions, Object.keys(serializedContractVersions)) ||
    Object.entries(serializedContractVersions).some(
      ([name, version]) => record.serializedVersions[name] !== version,
    )
  ) {
    throw new Error("contract revision record mismatch");
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
      `contract base ancestry mismatch: ${label} ${ancestor} is not an ancestor of ${revision}`,
    );
  }
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
