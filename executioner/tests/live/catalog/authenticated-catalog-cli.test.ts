import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  compileAuthenticatedCatalogFromArgs,
  prepareAuthenticatedCatalogFromArgs,
  recordAuthenticatedCatalogResultFromArgs,
} from "../../../src/live/runner/catalog/authenticated-catalog-cli.ts";
import type { AuthenticatedCatalogPlanV1, AuthenticatedCatalogResultV1 } from
  "../../../src/live/runner/catalog/authenticated-catalog.ts";

const root = resolve(import.meta.dirname, "../../../..");
const historyRef = "16c48bd1470addc9d9480d785ae84e412edd55ef:wd_test_jobs.csv";

test("prepare CLI accepts either a bounded history file or a pinned git object", () => {
  const scratch = mkdtempSync(join(tmpdir(), "hunt-auth-cli-"));
  try {
    const outputA = join(scratch, "runs-a");
    const outputB = join(scratch, "runs-b");
    const historyPath = join(scratch, "history.csv");
    const catalogPath = resolve(root, "wd_test_jobs.csv");
    writeFileSync(historyPath, execFileSync("git", ["show", historyRef], {
      cwd: root,
      encoding: "utf8",
    }));
    mkdirSync(outputA);
    mkdirSync(outputB);

    const fileRun = prepareAuthenticatedCatalogFromArgs([
      "--catalog", catalogPath,
      "--history-csv", historyPath,
      "--output-root", outputA,
      "--shards", "5",
    ], { now: () => new Date("2026-08-05T18:00:00.000Z"), randomHex: () => "1".repeat(32) });
    const gitRun = prepareAuthenticatedCatalogFromArgs([
      "--catalog", catalogPath,
      "--history-ref", historyRef,
      "--repo-root", root,
      "--output-root", outputB,
      "--shards", "5",
    ], { now: () => new Date("2026-08-05T18:00:01.000Z"), randomHex: () => "2".repeat(32) });

    assert.equal(fileRun.jobs, 37);
    assert.equal(gitRun.jobs, 37);
    assert.equal(fileRun.firstCatalogRow, 43);
    assert.equal(fileRun.lastCatalogRow, 100);
    assert.equal(fileRun.shards, 5);
    assert.throws(() => prepareAuthenticatedCatalogFromArgs([
      "--catalog", "wd_test_jobs.csv",
      "--history-ref", "HEAD:wd_test_jobs.csv",
      "--repo-root", root,
      "--output-root", outputA,
      "--shards", "5",
    ]), /catalog preparation denied/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("record and compile CLIs operate on result files without accepting inline secrets", () => {
  const scratch = mkdtempSync(join(tmpdir(), "hunt-auth-cli-"));
  try {
    const outputRoot = join(scratch, "runs");
    const historyPath = join(scratch, "history.csv");
    mkdirSync(outputRoot);
    writeFileSync(historyPath, execFileSync("git", ["show", historyRef], {
      cwd: root,
      encoding: "utf8",
    }));
    const prepared = prepareAuthenticatedCatalogFromArgs([
      "--catalog", resolve(root, "wd_test_jobs.csv"),
      "--history-csv", historyPath,
      "--output-root", outputRoot,
      "--shards", "5",
    ], { now: () => new Date("2026-08-05T18:00:00.000Z"), randomHex: () => "3".repeat(32) });
    const plan = JSON.parse(readFileSync(join(prepared.runRoot, "manifest.json"), "utf8")) as
      AuthenticatedCatalogPlanV1;
    const resultPath = join(scratch, "result.json");
    writeFileSync(resultPath, `${JSON.stringify(fixtureResult(plan, plan.jobs[0]!.jobId))}\n`);

    const recorded = recordAuthenticatedCatalogResultFromArgs([
      "--run-root", prepared.runRoot,
      "--result", resultPath,
    ]);
    assert.equal(recorded.jobId, plan.jobs[0]!.jobId);
    assert.throws(
      () => compileAuthenticatedCatalogFromArgs(["--run-root", prepared.runRoot]),
      /results incomplete/u,
    );
    assert.throws(
      () => recordAuthenticatedCatalogResultFromArgs([
        "--run-root", prepared.runRoot,
        "--result-json", JSON.stringify(fixtureResult(plan, plan.jobs[1]!.jobId)),
      ]),
      /result recording denied/u,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function fixtureResult(plan: AuthenticatedCatalogPlanV1, jobId: string): AuthenticatedCatalogResultV1 {
  return {
    schemaVersion: 1,
    runId: plan.runId,
    jobId,
    startedAt: "2026-08-05T18:01:00.000Z",
    finishedAt: "2026-08-05T18:02:00.000Z",
    outcome: "application_reached",
    observedAccountFlow: "fresh_create",
    verificationRequired: "no",
    verificationMethod: "none",
    verificationResult: "not_required",
    postVerificationSignIn: "not_required",
    applicationPageReached: true,
    c3PageClassification: "application_ready",
    independentBrowserClassification: "application_ready",
    classificationAgreement: "match",
    timingsMs: {
      accountEntry: 10_000,
      mailboxWait: 0,
      verificationNavigation: 0,
      postVerificationSignIn: 0,
      total: 60_000,
    },
    findings: [],
    evidence: {
      acceptanceSha256: "a".repeat(64),
      monitorAckSha256: "b".repeat(64),
      screenshotSha256: "c".repeat(64),
    },
  };
}
