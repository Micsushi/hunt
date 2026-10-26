import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileAuthenticatedCatalogRun,
  createAuthenticatedCatalogRun,
  recordAuthenticatedCatalogResult,
} from "../../../src/live/runner/catalog/authenticated-catalog-store.ts";
import {
  createAuthenticatedCatalogPlan,
  type AuthenticatedCatalogResultV1,
} from "../../../src/live/runner/catalog/authenticated-catalog.ts";

test("run store creates a five-shard immutable manifest for the fresh cohort", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "hunt-auth-catalog-"));
  try {
    const plan = fixturePlan(6, 5);
    const created = createAuthenticatedCatalogRun({ outputRoot, plan });

    assert.equal(created.runRoot, join(outputRoot, plan.runId));
    assert.deepEqual(created.shardPaths.map((path) => readFileSync(path, "utf8").trimEnd().split("\n").length - 1),
      [2, 1, 1, 1, 1]);
    assert.deepEqual(JSON.parse(readFileSync(created.manifestPath, "utf8")), plan);
    assert.match(readFileSync(created.jobsPath, "utf8"), /verification_required/u);
    assert.throws(
      () => createAuthenticatedCatalogRun({ outputRoot, plan }),
      /run already exists/u,
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("per-job result recording is exclusive and compilation refuses partial runs", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "hunt-auth-catalog-"));
  try {
    const plan = fixturePlan(2, 2);
    const { runRoot } = createAuthenticatedCatalogRun({ outputRoot, plan });
    const first = fixtureResult(plan.runId, plan.jobs[0]!.jobId);
    recordAuthenticatedCatalogResult({ runRoot, result: first });

    assert.throws(
      () => recordAuthenticatedCatalogResult({ runRoot, result: first }),
      /result already exists/u,
    );
    assert.throws(
      () => recordAuthenticatedCatalogResult({
        runRoot,
        result: { ...first, jobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa" },
      }),
      /result invalid/u,
    );
    assert.throws(() => compileAuthenticatedCatalogRun(runRoot), /results incomplete/u);
    assert.equal(existsSync(join(runRoot, "results.csv")), false);

    recordAuthenticatedCatalogResult({
      runRoot,
      result: fixtureResult(plan.runId, plan.jobs[1]!.jobId, {
        verificationRequired: "no",
        verificationMethod: "none",
        verificationResult: "not_required",
        postVerificationSignIn: "not_required",
      }),
    });
    const compiled = compileAuthenticatedCatalogRun(runRoot);
    assert.equal(compiled.summary.completed, 2);
    assert.equal(existsSync(compiled.resultsPath), true);
    assert.equal(existsSync(compiled.summaryPath), true);
    assert.throws(() => compileAuthenticatedCatalogRun(runRoot), /results already compiled/u);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("a compiler that does not own the run lock cannot remove it", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "hunt-auth-catalog-"));
  try {
    const plan = fixturePlan(1, 1);
    const { runRoot } = createAuthenticatedCatalogRun({ outputRoot, plan });
    const lockPath = join(runRoot, ".compile.lock");
    writeFileSync(lockPath, "owned elsewhere", { flag: "wx" });

    assert.throws(() => compileAuthenticatedCatalogRun(runRoot));
    assert.equal(readFileSync(lockPath, "utf8"), "owned elsewhere");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

function fixturePlan(count: number, shardCount: number) {
  const header = "company name,job name,country,link,test status,observed account flow,last tested,notes";
  const rows = Array.from({ length: count }, (_, index) =>
    `Fresh ${index + 1},Role ${index + 1},USA,https://fresh${index + 1}.wd1.myworkdayjobs.com/External/job/A/Role_R${index + 1},,,,`
  );
  return createAuthenticatedCatalogPlan({
    catalogCsv: [header, ...rows].join("\n"),
    historyCsv: `${header}\nOld,Old,USA,https://old.wd1.myworkdayjobs.com/External/job/A/Old_R0`,
    runId: "authrun_0123456789abcdef0123456789abcdef",
    createdAt: "2026-08-05T18:00:00.000Z",
    shardCount,
  });
}

function fixtureResult(
  runId: string,
  jobId: string,
  overrides: Partial<AuthenticatedCatalogResultV1> = {},
): AuthenticatedCatalogResultV1 {
  return {
    schemaVersion: 1,
    runId,
    jobId,
    startedAt: "2026-08-05T18:01:00.000Z",
    finishedAt: "2026-08-05T18:02:00.000Z",
    outcome: "application_reached",
    observedAccountFlow: "fresh_create",
    verificationRequired: "yes",
    verificationMethod: "email_link",
    verificationResult: "verified",
    postVerificationSignIn: "required_succeeded",
    applicationPageReached: true,
    c3PageClassification: "application_ready",
    independentBrowserClassification: "application_ready",
    classificationAgreement: "match",
    timingsMs: {
      accountEntry: 10_000,
      mailboxWait: 20_000,
      verificationNavigation: 5_000,
      postVerificationSignIn: 10_000,
      total: 60_000,
    },
    findings: [],
    evidence: {
      acceptanceSha256: "a".repeat(64),
      monitorAckSha256: "b".repeat(64),
      screenshotSha256: "c".repeat(64),
    },
    ...overrides,
  };
}
