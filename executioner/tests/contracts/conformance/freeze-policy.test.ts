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
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  assertFrozenContractTree,
  frozenContractRevision,
} from "../../../src/testing/contracts/index.ts";

test("the frozen revision matches the checked-in contracts and policy record", () => {
  assert.match(frozenContractRevision, /^[0-9a-f]{40}$/u);
  assert.match(
    readFileSync("docs/contract-freeze.md", "utf8"),
    new RegExp(frozenContractRevision, "u"),
  );
  assert.doesNotThrow(() =>
    assertFrozenContractTree(frozenContractRevision, resolve("..")),
  );
});

test("the freeze gate rejects an untracked contract file", () => {
  const repository = mkdtempSync(join(tmpdir(), "hunt-contract-freeze-"));
  const contracts = join(repository, "executioner", "src", "contracts");

  try {
    mkdirSync(contracts, { recursive: true });
    writeFileSync(join(contracts, "ports.ts"), "export interface Port {}\n");
    git(repository, "init");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "freeze");
    const revision = git(repository, "rev-parse", "HEAD").trim();

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
    stdio: ["ignore", "pipe", "pipe"],
  });
}
