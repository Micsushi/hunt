import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertFrozenContractBase,
  contractRevisionStatus,
  historicalR1Revision,
  planningRevision,
} from "../../src/testing/contracts/index.ts";

const repository = resolve(process.cwd(), "..");

test("the F1 contract baseline is frozen", () => {
  assert.equal(contractRevisionStatus, "r2_frozen");
});

test("the staged F1 baseline has exact ancestry, trees, and versions", () => {
  const stagedTree = execFileSync("git", ["write-tree"], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const record = JSON.parse(
    readFileSync("docs/contract-revision.json", "utf8"),
  ) as Readonly<Record<string, unknown>>;

  assert.deepEqual(record, {
    schemaVersion: 1,
    historicalR1: "c57c24ef59aec6dd6e2ee8f222aa64695777a0dd",
    contractSource: "d95e845e61bcf0a030b3b07c6d6261e3d95c1fad",
    planningRevision: "8c5785abf4f0d08dba871744cda006e906dab051",
    contractTreeOids: record.contractTreeOids,
    serializedVersions: {
      fixtureManifest: 2,
      durableJourneyState: 2,
      eventEnvelope: 2,
      errorEnvelope: 2,
      evidenceManifest: 2,
      terminalResult: 2,
      mcpRequest: 2,
      mcpResponse: 2,
    },
  });
  assert.equal("acceptedF1Base" in record, false);
  assert.doesNotThrow(() =>
    assertFrozenContractBase("HEAD", repository, stagedTree),
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
