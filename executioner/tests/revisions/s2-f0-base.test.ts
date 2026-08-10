import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  acceptedStage1Base,
  assertS2FrozenContractBase,
  assertS2FrozenRootsClean,
  readS2ContractRevision,
  s2AllowedTargetAdapters,
  s2ContractSource,
  s2ContractSourceTree,
  s2ContractRevisionStatus,
  s2FrozenTreePaths,
} from "../../src/testing/s2-revision.ts";

const repository = resolve(process.cwd(), "..");

test("the Stage 2 F0 manifest freezes exact trees, versions, and adapters", () => {
  const record = readS2ContractRevision(repository);

  assert.deepEqual(record, {
    schemaVersion: 1,
    status: s2ContractRevisionStatus,
    acceptedStage1Base,
    s2ContractSource,
    s2ContractSourceTree,
    contractTreeOids: {
      "executioner/src/contracts":
        "ad9f5a43e0bbe0e79661784dabf28b15b18e9ad8",
      "executioner/src/contracts/live":
        "ac3971aae2a1ceb3703b0f8c8f171c884c4059d9",
      "executioner/src/control/orchestrator/live":
        "6b38b5dee5a63989719045ef0de22df2a3f50590",
      "executioner/src/testing/live":
        "377d167ace83fa4d95798c221f4f776d86f209ac",
      "executioner/tests/live/contracts":
        "8c9d120d6c2c77bb713fbd9d8e916fc099a6be7a",
      "executioner/tests/live/walking-skeleton":
        "745b301fcc177e7feeefc1d65eb521a56a3d2292",
    },
    serializedVersions: {
      commonWire: {
        terminalResult: 4,
        mcpResponse: 4,
        errorEnvelope: 3,
        eventEnvelope: 3,
        mcpRequest: 2,
        durableJourneyState: 3,
      },
      liveContracts: {
        targetIdentity: 1,
        persistentBrowserSession: 1,
        secretHandleMetadata: 1,
        mailboxPollResult: 1,
        verificationArtifact: 1,
        liveCheckpoint: 1,
        liveEvidence: 1,
      },
      liveClassification: {
        atsFamilyClassification: 1,
        workdayPageTypeClassification: 1,
        uiBehaviorClassification: 1,
        questionClassification: 1,
        canonicalAnswerTypeClassification: 1,
        visibleOptionMapping: 1,
        sanitizedStructuralObservation: 1,
        sanitizedUnknownCandidate: 1,
        reviewedPromotionRecord: 1,
      },
    },
    allowedTargetAdapters: [...s2AllowedTargetAdapters],
  });
  assert.doesNotThrow(() => assertS2FrozenContractBase("HEAD", repository));
});

test("Stage 2 preserves every pre-existing Stage 1 contract blob", () => {
  const contractIndex = "executioner/src/contracts/index.ts";
  const stage1Paths = git(
    repository,
    "ls-tree",
    "-r",
    "--name-only",
    acceptedStage1Base,
    "--",
    "executioner/src/contracts",
  ).trim().split("\n");

  for (const path of stage1Paths.filter((path) => path !== contractIndex)) {
    assert.equal(
      git(repository, "rev-parse", `${acceptedStage1Base}:${path}`).trim(),
      git(repository, "rev-parse", `${s2ContractSource}:${path}`).trim(),
      path,
    );
  }

  const indexDiff = git(
    repository,
    "diff",
    "--unified=0",
    acceptedStage1Base,
    s2ContractSource,
    "--",
    contractIndex,
  ).split("\n");
  assert.deepEqual(
    indexDiff.filter((line) => line.startsWith("+") && !line.startsWith("+++")),
    [
      '+export * from "./live/index.ts";',
      '+export * from "./s2-common-schemas.ts";',
      '+export * from "./s2-common-serialized.ts";',
      '+export * from "./s2-common-wire.ts";',
    ],
  );
  assert.deepEqual(
    indexDiff.filter((line) => line.startsWith("-") && !line.startsWith("---")),
    [],
  );
});

test("a pre-F0 revision is rejected with a Stage 2 source diagnostic", () => {
  assert.throws(
    () => assertS2FrozenContractBase(acceptedStage1Base, repository),
    new RegExp(
      `^Error: S2 contract base ancestry mismatch: Stage 2 contract source ${s2ContractSource} is not an ancestor of ${acceptedStage1Base}$`,
      "u",
    ),
  );
});

test("the Stage 2 freeze rejects a changed frozen root", () => {
  const isolatedRepository = mkdtempSync(join(tmpdir(), "hunt-s2-freeze-"));

  try {
    for (const path of s2FrozenTreePaths) {
      mkdirSync(join(isolatedRepository, path), { recursive: true });
      writeFileSync(join(isolatedRepository, path, "tracked.ts"), "tracked\n");
    }
    mkdirSync(join(isolatedRepository, "executioner/docs"), { recursive: true });
    writeFileSync(
      join(isolatedRepository, "executioner/docs/s2-contract-revision.json"),
      JSON.stringify(readS2ContractRevision(repository)),
    );
    git(isolatedRepository, "init");
    git(isolatedRepository, "add", ".");
    const revision = git(isolatedRepository, "write-tree").trim();
    writeFileSync(
      join(isolatedRepository, "executioner/src/contracts/live/tracked.ts"),
      "dirty\n",
    );

    assert.throws(
      () => assertS2FrozenRootsClean(revision, isolatedRepository),
      /dirty S2 frozen root/u,
    );
  } finally {
    rmSync(isolatedRepository, { recursive: true, force: true });
  }
});

function git(repositoryPath: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
