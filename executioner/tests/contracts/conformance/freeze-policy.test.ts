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
} from "../../../src/testing/contracts/index.ts";

test("the R2 draft records historical ancestry without claiming acceptance", () => {
  assert.equal(contractRevisionStatus, "r2_draft");
  assert.match(historicalContractRevision, /^[0-9a-f]{40}$/u);
  const record = readFileSync("docs/contract-freeze.md", "utf8");
  assert.match(record, new RegExp(historicalContractRevision, "u"));
  assert.match(record, /Status: R2 draft, not accepted/u);
  assert.doesNotMatch(record, /acceptedF1Base:\s*[0-9a-f]{40}/u);
});

test("the freeze gate rejects an untracked contract file", () => {
  const repository = mkdtempSync(join(tmpdir(), "hunt-contract-freeze-"));
  const contracts = join(repository, "executioner", "src", "contracts");

  try {
    mkdirSync(contracts, { recursive: true });
    writeFileSync(join(contracts, "ports.ts"), "export interface Port {}\n");
    git(repository, "init");
    git(repository, "add", ".");
    const revision = git(repository, "write-tree").trim();

    writeFileSync(
      join(contracts, "untracked.ts"),
      "export interface Untracked {}\n",
    );
    assert.doesNotThrow(() =>
      git(
        repository,
        "diff",
        "--exit-code",
        revision,
        "--",
        ":(top)executioner/src/contracts",
      ),
    );
    assert.throws(
      () => assertFrozenContractTree(revision, repository),
      /untracked contract file.*untracked\.ts/u,
    );
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
