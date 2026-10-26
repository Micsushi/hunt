import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertFrozenContractBase,
  contractRevisionStatus,
  historicalContractRevision,
  historicalR1Revision,
  planningRevision,
  predecessorAcceptedBase,
} from "../../src/testing/contracts/index.ts";

const repository = resolve(process.cwd(), "..");
const acceptedStage1Base = "87c77e538d8bba378ec93516dbea3f4747beb822";

test("the F1 R2.n contract baseline is frozen", () => {
  assert.equal(contractRevisionStatus, "r2n_frozen");
});

test("the accepted Stage 1 base has exact ancestry, trees, and versions", () => {
  const record = JSON.parse(
    readFileSync("docs/contract-revision.json", "utf8"),
  ) as Readonly<Record<string, unknown>>;

  assert.deepEqual(record, {
    schemaVersion: 2,
    historicalR1: "c57c24ef59aec6dd6e2ee8f222aa64695777a0dd",
    contractSource: "d95e845e61bcf0a030b3b07c6d6261e3d95c1fad",
    planningRevision: "8c5785abf4f0d08dba871744cda006e906dab051",
    predecessorAcceptedBase,
    contractTreeOids: record.contractTreeOids,
    serializedVersions: {
      fixtureManifest: 2,
      durableJourneyState: 3,
      eventEnvelope: 2,
      errorEnvelope: 2,
      evidenceManifest: 2,
      terminalResult: 3,
      mcpRequest: 2,
      mcpResponse: 3,
    },
  });
  assert.equal("acceptedF1Base" in record, false);
  const treeOids = record.contractTreeOids as Readonly<Record<string, string>>;
  for (const path of [
    "executioner/src/contracts",
    "executioner/src/testing/contracts",
    "executioner/tests/contracts",
    "executioner/tests/security/privacy",
  ]) {
    assert.equal(
      git("rev-parse", `${acceptedStage1Base}:${path}`).trim(),
      treeOids[path],
    );
  }
  for (const ancestor of [
    historicalR1Revision,
    historicalContractRevision,
    planningRevision,
    predecessorAcceptedBase,
  ]) {
    assert.doesNotThrow(() =>
      git("merge-base", "--is-ancestor", ancestor, acceptedStage1Base),
    );
  }
  assert.doesNotThrow(() =>
    git("merge-base", "--is-ancestor", acceptedStage1Base, "HEAD"),
  );
});

test("a wrong F1 base is rejected with a stable ancestry diagnostic", () => {
  assert.throws(
    () => assertFrozenContractBase(historicalR1Revision, repository),
    new RegExp(
      `^Error: contract base ancestry mismatch: planning revision ${planningRevision} is not an ancestor of ${historicalR1Revision}$`,
      "u",
    ),
  );
});

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
