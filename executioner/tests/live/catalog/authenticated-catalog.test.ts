import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  compileAuthenticatedCatalogResults,
  createAuthenticatedCatalogPlan,
  serializeAuthenticatedCatalogJobs,
  validateAuthenticatedCatalogResult,
  type AuthenticatedCatalogResultV1,
} from "../../../src/live/runner/catalog/authenticated-catalog.ts";

const root = resolve(import.meta.dirname, "../../../..");
const historyRef = "16c48bd1470addc9d9480d785ae84e412edd55ef:wd_test_jobs.csv";

test("current catalog selects exactly the 37 account realms absent from the historical 63", () => {
  const catalogCsv = readFileSync(resolve(root, "wd_test_jobs.csv"), "utf8");
  const historyCsv = execFileSync("git", ["show", historyRef], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  const plan = createAuthenticatedCatalogPlan({
    catalogCsv,
    historyCsv,
    runId: "authrun_0123456789abcdef0123456789abcdef",
    createdAt: "2026-08-05T18:00:00.000Z",
    shardCount: 5,
  });

  assert.equal(plan.catalogCount, 100);
  assert.equal(plan.historicalRealmCount, 63);
  assert.equal(plan.freshCandidateCount, 37);
  assert.deepEqual(plan.jobs.map((job) => job.catalogRow), [
    43,
    ...Array.from({ length: 36 }, (_, index) => index + 65),
  ]);
  assert.deepEqual(
    plan.jobs.reduce<number[]>((counts, job) => {
      counts[job.shard - 1] = (counts[job.shard - 1] ?? 0) + 1;
      return counts;
    }, []),
    [8, 8, 7, 7, 7],
  );
  assert.equal(plan.jobs[0]?.accountRealm, "ghr.wd1.myworkdayjobs.com|lateral-us");
  assert.equal(plan.jobs[0]?.targetUrl.includes("?"), false);
});

test("account realm normalization ignores Workday locale segments", () => {
  const header = "company name,job name,country,link,test status,observed account flow,last tested,notes";
  const current = [
    header,
    "PayPal,Role,USA,https://paypal.wd1.myworkdayjobs.com/jobs/job/A/Role_R1,,,,",
    "NewCo,Role,USA,https://newco.wd501.myworkdayjobs.com/External/job/A/Role_R2?source=LinkedIn,,,,",
  ].join("\n");
  const historical = [
    header,
    "PayPal,Old,USA,https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/A/Old_R0",
  ].join("\n");
  const plan = createAuthenticatedCatalogPlan({
    catalogCsv: current,
    historyCsv: historical,
    runId: "authrun_0123456789abcdef0123456789abcdef",
    createdAt: "2026-08-05T18:00:00.000Z",
    shardCount: 1,
  });
  assert.deepEqual(plan.jobs.map((job) => job.companyName), ["NewCo"]);
  assert.equal(plan.historicalRealmCount, 1);
});

test("catalog accepts a blank country and Workday posting path without a location segment", () => {
  const header = "company name,job name,country,link,test status,observed account flow,last tested,notes";
  const plan = createAuthenticatedCatalogPlan({
    catalogCsv: `${header}\nPATH,Role,,https://path.wd1.myworkdayjobs.com/External/job/Role_R1,,,,`,
    historyCsv: `${header}\nOld,Old,USA,https://old.wd1.myworkdayjobs.com/External/job/A/Old_R0,,,,`,
    runId: "authrun_0123456789abcdef0123456789abcdef",
    createdAt: "2026-08-05T18:00:00.000Z",
    shardCount: 1,
  });

  assert.equal(plan.jobs[0]?.accountRealm, "path.wd1.myworkdayjobs.com|external");
});

test("catalog parsing rejects duplicate realms, unsafe URLs, and spreadsheet formulas", () => {
  const header = "company name,job name,country,link,test status,observed account flow,last tested,notes";
  const common = {
    historyCsv: `${header}\nOld,Old,USA,https://old.wd1.myworkdayjobs.com/External/job/A/Old_R0,,,,`,
    runId: "authrun_0123456789abcdef0123456789abcdef",
    createdAt: "2026-08-05T18:00:00.000Z",
    shardCount: 1,
  } as const;
  assert.throws(() => createAuthenticatedCatalogPlan({
    ...common,
    catalogCsv: [header,
      "One,Role,USA,https://one.wd1.myworkdayjobs.com/External/job/A/Role_R1,,,,",
      "Two,Role,USA,https://one.wd1.myworkdayjobs.com/en-US/External/job/B/Role_R2,,,,",
    ].join("\n"),
  }), /catalog invalid/u);
  assert.throws(() => createAuthenticatedCatalogPlan({
    ...common,
    catalogCsv: `${header}\n=cmd,Role,USA,https://one.wd1.myworkdayjobs.com/External/job/A/Role_R1,,,,`,
  }), /catalog invalid/u);
  assert.throws(() => createAuthenticatedCatalogPlan({
    ...common,
    catalogCsv: `${header}\nOne,Role,USA,http://one.wd1.myworkdayjobs.com/External/job/A/Role_R1,,,,`,
  }), /catalog invalid/u);
  assert.throws(() => createAuthenticatedCatalogPlan({
    ...common,
    catalogCsv: `${header}\nOne"Broken,Role,USA,https://one.wd1.myworkdayjobs.com/External/job/A/Role_R1,,,,`,
  }), /catalog invalid/u);
});

test("result contract preserves link verification, post-verification sign-in, timing, and minor findings", () => {
  const plan = fixturePlan();
  const result = fixtureResult(plan.jobs[0]!.jobId);
  const admitted = validateAuthenticatedCatalogResult(result, plan);
  assert.equal(admitted.verificationRequired, "yes");
  assert.equal(admitted.verificationMethod, "email_link");
  assert.equal(admitted.postVerificationSignIn, "required_succeeded");
  assert.equal(admitted.findings[0]?.code, "page_misclassification");
  assert.throws(() => validateAuthenticatedCatalogResult({
    ...result,
    verificationRequired: "no",
  }, plan), /result invalid/u);
  assert.throws(() => validateAuthenticatedCatalogResult({
    ...result,
    findings: [{ ...result.findings[0]!, summary: "password=secret" }],
  }, plan), /result invalid/u);
  assert.throws(() => validateAuthenticatedCatalogResult({
    ...result,
    postVerificationSignIn: "required_failed",
  }, plan), /result invalid/u);
  assert.throws(() => validateAuthenticatedCatalogResult({
    ...result,
    c3PageClassification: "account_entry",
    classificationAgreement: "match",
  }, plan), /result invalid/u);
  assert.throws(() => validateAuthenticatedCatalogResult({
    ...result,
    independentBrowserClassification: "account_entry",
  }, plan), /result invalid/u);
});

test("result contract records a reached page that failed monitor certification", () => {
  const plan = fixturePlan();
  const failed = {
    ...fixtureResult(plan.jobs[0]!.jobId),
    outcome: "failed",
    classificationAgreement: "match",
    findings: [{
      severity: "major",
      phase: "monitoring",
      code: "monitor_ack_missing",
      summary: "Required monitor acknowledgement was unavailable.",
    }],
    evidence: {
      acceptanceSha256: "a".repeat(64),
      monitorAckSha256: null,
      screenshotSha256: null,
    },
  } as unknown as AuthenticatedCatalogResultV1;

  assert.equal(validateAuthenticatedCatalogResult(failed, plan).applicationPageReached, true);
  assert.throws(() => validateAuthenticatedCatalogResult({
    ...failed,
    outcome: "application_reached",
  }, plan), /result invalid/u);
});

test("compilation refuses partial runs and emits one CSV row per completed job", () => {
  const plan = fixturePlan(2);
  const first = fixtureResult(plan.jobs[0]!.jobId);
  assert.throws(
    () => compileAuthenticatedCatalogResults(plan, [first]),
    /results incomplete/u,
  );
  const second = fixtureResult(plan.jobs[1]!.jobId, {
    verificationRequired: "no",
    verificationMethod: "none",
    verificationResult: "not_required",
    postVerificationSignIn: "not_required",
    classificationAgreement: "match",
    findings: [],
  });
  const compiled = compileAuthenticatedCatalogResults(plan, [first, second]);
  assert.equal(compiled.summary.completed, 2);
  assert.equal(compiled.summary.verificationRequired, 1);
  assert.equal(compiled.summary.applicationReached, 2);
  assert.match(compiled.csv, /verification_required,verification_method/u);
  assert.equal(compiled.csv.trimEnd().split("\n").length, 3);
  assert.doesNotMatch(compiled.csv, /password|token|secret/iu);
});

test("job CSV is deterministic, formula-safe, and carries unknown pre-run verification state", () => {
  const plan = fixturePlan();
  const csv = serializeAuthenticatedCatalogJobs(plan);
  assert.match(csv, /verification_required/u);
  assert.match(csv, /unknown/u);
  assert.equal(csv, serializeAuthenticatedCatalogJobs(plan));
  assert.doesNotMatch(csv, /\n[=+\-@]/u);
});

function fixturePlan(count = 1) {
  const header = "company name,job name,country,link,test status,observed account flow,last tested,notes";
  const rows = Array.from({ length: count }, (_, index) =>
    `Fresh ${index + 1},Role ${index + 1},USA,https://fresh${index + 1}.wd1.myworkdayjobs.com/External/job/A/Role_R${index + 1},,,,`
  );
  return createAuthenticatedCatalogPlan({
    catalogCsv: [header, ...rows].join("\n"),
    historyCsv: `${header}\nOld,Old,USA,https://old.wd1.myworkdayjobs.com/External/job/A/Old_R0,,,,`,
    runId: "authrun_0123456789abcdef0123456789abcdef",
    createdAt: "2026-08-05T18:00:00.000Z",
    shardCount: Math.min(5, count),
  });
}

function fixtureResult(
  jobId: string,
  overrides: Partial<AuthenticatedCatalogResultV1> = {},
): AuthenticatedCatalogResultV1 {
  return {
    schemaVersion: 1,
    runId: "authrun_0123456789abcdef0123456789abcdef",
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
    classificationAgreement: "minor_mismatch",
    timingsMs: {
      accountEntry: 10_000,
      mailboxWait: 20_000,
      verificationNavigation: 5_000,
      postVerificationSignIn: 10_000,
      total: 60_000,
    },
    findings: [{
      severity: "minor",
      phase: "monitoring",
      code: "page_misclassification",
      summary: "Intermediate page type was briefly classified as account entry.",
    }],
    evidence: {
      acceptanceSha256: "a".repeat(64),
      monitorAckSha256: "b".repeat(64),
      screenshotSha256: "c".repeat(64),
    },
    ...overrides,
  };
}
