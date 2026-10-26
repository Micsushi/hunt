import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertFrozenContractTree,
  contractRevisionStatus,
  historicalContractRevision,
  historicalR1Revision,
  planningRevision,
  predecessorAcceptedBase,
} from "../../../src/testing/contracts/index.ts";

test("the R2.n freeze records ancestry without a self-referential base", () => {
  assert.equal(contractRevisionStatus, "r2n_frozen");
  assert.match(historicalContractRevision, /^[0-9a-f]{40}$/u);
  const record = readFileSync("docs/contract-freeze.md", "utf8");
  assert.match(record, new RegExp(historicalContractRevision, "u"));
  assert.match(record, new RegExp(historicalR1Revision, "u"));
  assert.match(record, new RegExp(planningRevision, "u"));
  assert.match(record, new RegExp(predecessorAcceptedBase, "u"));
  assert.match(record, /Status: R2.n frozen component baseline/u);
  assert.doesNotMatch(record, /acceptedF1Base:\s*[0-9a-f]{40}/u);
});

test("the freeze gate rejects dirty and untracked files in every frozen root", () => {
  const repository = mkdtempSync(join(tmpdir(), "hunt-contract-freeze-"));
  const roots = [
    "executioner/src/contracts",
    "executioner/src/testing/contracts",
    "executioner/tests/contracts",
    "executioner/tests/security/privacy",
  ];

  try {
    for (const root of roots) {
      mkdirSync(join(repository, root), { recursive: true });
      writeFileSync(join(repository, root, "tracked.ts"), "tracked\n");
    }
    git(repository, "init");
    git(repository, "add", ".");
    const revision = git(repository, "write-tree").trim();

    for (const root of roots) {
      const tracked = join(repository, root, "tracked.ts");
      const untracked = join(repository, root, "untracked.ts");
      writeFileSync(tracked, "dirty\n");
      assert.throws(
        () => assertFrozenContractTree(revision, repository),
        /dirty frozen root/u,
      );
      writeFileSync(tracked, "tracked\n");

      writeFileSync(untracked, "untracked\n");
      assert.throws(
        () => assertFrozenContractTree(revision, repository),
        /untracked frozen root file/u,
      );
      rmSync(untracked);
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
