import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  buildTesterSummary,
  parseAtsScreenerOutput,
  parseResumeParserOutput,
  resolveTesterLocations,
  runTesterSuite,
  testerExitCode
} from "./tester-runner.mjs";

test("tester locations resolve from the caller workspace or an explicit external root", () => {
  const workspaceRoot = resolve("caller-workspace");
  assert.deepEqual(resolveTesterLocations({ workspaceRoot }), {
    workspaceRoot,
    testerRoot: resolve(workspaceRoot, "testers")
  });
  assert.deepEqual(resolveTesterLocations({ workspaceRoot, "tester-root": "../shared-testers" }), {
    workspaceRoot,
    testerRoot: resolve(workspaceRoot, "../shared-testers")
  });
});

test("runTesterSuite preserves optional ATS-Checker skip state", async () => {
  const report = await runTesterSuite({
    tool: "ats-checker",
    pdf: "resume/output/missing.pdf",
    text: "resume/output/missing.txt"
  });

  assert.equal(report.status, "pass_with_warnings");
  assert.equal(report.executions[0].state, "skipped");
  assert.equal(report.checks[0].id, "tester_ats_checker_skipped");
  assert.equal(testerExitCode(report), 0);
});

test("runTesterSuite maps strict ATS-Checker absence to exit 69", async () => {
  const report = await runTesterSuite({
    tool: "ats-checker",
    profile: "strict",
    pdf: "resume/output/missing.pdf",
    text: "resume/output/missing.txt"
  });

  assert.equal(report.status, "fail");
  assert.equal(report.executions[0].required, true);
  assert.equal(report.checks[0].metadata.required_capability_unavailable, true);
  assert.equal(testerExitCode(report), 69);
});

test("strict tester profile rejects bypasses and always requires ATS-Checker", async () => {
  await assert.rejects(
    runTesterSuite({ tool: "resume-parser", profile: "strict" }),
    (error) => error.code === "INVALID_USAGE"
  );
  await assert.rejects(
    runTesterSuite({ tool: "ats-checker", profile: "strcit" }),
    (error) => error.code === "INVALID_USAGE"
  );

  const report = await runTesterSuite({
    tool: "ats-checker,resume-parser",
    profile: "strict",
    required: "resume-parser",
    pdf: "resume/output/missing.pdf",
    text: "resume/output/missing.txt"
  });
  const atsChecker = report.executions.find((item) => item.adapter_id === "ats-checker");
  const resumeParser = report.executions.find((item) => item.adapter_id === "resume-parser");
  assert.equal(atsChecker.required, true);
  assert.equal(resumeParser.required, true);
  assert.equal(testerExitCode(report), 69);
});

test("runTesterSuite rejects unknown adapters as invalid usage", async () => {
  await assert.rejects(
    runTesterSuite({ tool: "unknown" }),
    (error) => error.code === "INVALID_USAGE"
  );
});

test("runTesterSuite handles missing ats-screener input as a skip", async () => {
  const report = await runTesterSuite({ tool: "ats-screener" });

  assert.equal(report.executions[0].state, "skipped");
  assert.match(report.executions[0].reason, /needs --text/);
});

test("runTesterSuite rejects unknown required adapters", async () => {
  await assert.rejects(
    runTesterSuite({ tool: "ats-checker", required: "unknown" }),
    (error) => error.code === "INVALID_USAGE"
  );
});

test("runTesterSuite rejects required adapters omitted from selection", async () => {
  await assert.rejects(
    runTesterSuite({
      tool: "resume-parser",
      required: "ats-checker",
      pdf: "resume/output/missing.pdf"
    }),
    (error) => error.code === "INVALID_USAGE"
  );
});

test("ResumeParser output validation retains only structural evidence", () => {
  const parsed = parseResumeParserOutput(
    JSON.stringify({
      schema_version: 1,
      tool: "ResumeParser",
      contact: { present: true, field_count: 4 },
      education: { present: true, entry_count: 1 },
      experience: { present: true, entry_count: 2 },
      skills: { present: true, category_count: 3, skill_count: 9 },
      private_name: "must not survive"
    })
  );

  assert.deepEqual(parsed, {
    tool: "ResumeParser",
    contact_present: true,
    contact_field_count: 4,
    education_present: true,
    education_entry_count: 1,
    experience_present: true,
    experience_entry_count: 2,
    skills_present: true,
    skills_category_count: 3,
    skills_count: 9
  });
  assert.doesNotMatch(JSON.stringify(parsed), /private_name|must not survive/);
});

test("ResumeParser output validation rejects malformed structure", () => {
  assert.throws(
    () => parseResumeParserOutput('{"schema_version":1,"contact":{"present":"yes"}}'),
    (error) => error.code === "MALFORMED_OUTPUT"
  );
});

test("ats-screener output validation reduces scores without raw terms", () => {
  const parsed = parseAtsScreenerOutput(
    JSON.stringify([
      {
        system: "Synthetic ATS",
        vendor: "Example",
        overallScore: 72,
        passesFilter: true,
        breakdown: {
          formatting: { score: 90, issues: ["private"] },
          keywordMatch: {
            score: 50,
            matched: ["TypeScript"],
            missing: ["SecretTerm"],
            synonymMatched: []
          },
          sections: { score: 80, present: ["skills"], missing: ["summary"] },
          experience: {
            score: 70,
            quantifiedBullets: 2,
            totalBullets: 4,
            actionVerbCount: 3,
            highlights: ["private"]
          },
          education: { score: 70, notes: ["private"] }
        },
        suggestions: ["private suggestion"]
      }
    ])
  );

  assert.deepEqual(parsed, {
    result_count: 1,
    passing_count: 1,
    overall_score_min: 72,
    overall_score_max: 72,
    component_scores: {
      formatting: 90,
      keyword_match: 50,
      sections: 80,
      experience: 70,
      education: 70
    },
    missing_signal_count: 2,
    matched_signal_count: 2,
    quantified_bullets: 2,
    total_bullets: 4,
    action_verb_count: 3
  });
  assert.doesNotMatch(JSON.stringify(parsed), /TypeScript|SecretTerm|private/);
});

test("ats-screener output validation rejects invalid scores", () => {
  assert.throws(
    () =>
      parseAtsScreenerOutput(
        '[{"overallScore":101,"passesFilter":true,"breakdown":{},"system":"x","vendor":"x"}]'
      ),
    (error) => error.code === "MALFORMED_OUTPUT"
  );
});

test("tester summary preserves domains and explicit deferral", () => {
  const summary = buildTesterSummary([
    {
      adapter_id: "ats-checker",
      state: "executed_pass",
      metadata: { token_agreement: 0.99 }
    },
    {
      adapter_id: "resume-parser",
      state: "executed_pass",
      metadata: { education_present: true, experience_present: true }
    },
    {
      adapter_id: "resume-matcher",
      state: "skipped",
      failure_kind: "deferred"
    }
  ]);

  assert.deepEqual(summary.execution_counts, {
    executed_pass: 2,
    executed_warning: 0,
    executed_fail: 0,
    skipped: 1
  });
  assert.deepEqual(summary.executed_parsers, ["ats-checker", "resume-parser"]);
  assert.equal(summary.resume_matcher_deferred, true);
  assert.deepEqual(summary.parser_evidence, {
    ats_checker: { state: "executed_pass", agreement: null },
    resume_parser: {
      state: "executed_pass",
      contact_present: null,
      education_present: true,
      education_entry_count: null,
      experience_present: true,
      experience_entry_count: null,
      skills_present: null,
      skills_count: null
    }
  });
  assert.equal(summary.incompatible_scores_combined, false);
});
