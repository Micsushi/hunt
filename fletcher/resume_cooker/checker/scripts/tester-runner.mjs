import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoRoot, parseArgs, runCommand } from "../../generator/scripts/build-lib.mjs";
import { compareParserExtractions, runAtsCheckerExtraction } from "./ats-checker.mjs";
import { createReport, sanitizeProcessMessage, writeReport } from "./report-lib.mjs";
import { adapterResultToCheck, runTesterAdapter } from "./tester-wrapper.mjs";

const knownTools = ["ats-checker", "ats-screener", "resume-parser", "resume-matcher"];
const packageRoot = getRepoRoot();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = await runTesterSuite(args);
    const written = await writeReport(report, args.out);
    console.log(JSON.stringify({ status: report.status, report: written || null }, null, 2));
    process.exitCode = testerExitCode(report);
  } catch (error) {
    console.error(safeError(error));
    process.exit(error.code === "INVALID_USAGE" ? 64 : 70);
  }
}

export async function runTesterSuite(options = {}) {
  options = { ...options, ...resolveTesterLocations(options) };
  validateProfile(options.profile);
  const tools = selectedTools(options.tool || "all");
  if (options.profile === "strict" && !tools.includes("ats-checker")) {
    const error = new Error("The strict tester profile must include ATS-Checker.");
    error.code = "INVALID_USAGE";
    throw error;
  }
  const required = requiredTools(options);
  const unselectedRequired = [...required].filter((tool) => !tools.includes(tool));
  if (unselectedRequired.length > 0) {
    const error = new Error(
      `Required tester adapter was not selected: ${unselectedRequired.join(", ")}.`
    );
    error.code = "INVALID_USAGE";
    throw error;
  }
  const executions = [];

  if (tools.includes("ats-checker")) {
    executions.push(await runAtsChecker(options, required.has("ats-checker")));
  }
  if (tools.includes("ats-screener")) {
    executions.push(await runAtsScreener(options, required.has("ats-screener")));
  }
  if (tools.includes("resume-parser")) {
    executions.push(await runResumeParser(options, required.has("resume-parser")));
  }
  if (tools.includes("resume-matcher")) {
    executions.push(await runResumeMatcher(options, required.has("resume-matcher")));
  }

  const report = createReport({
    stage: "tester_execution",
    suite: "local",
    summary: "Explicit tester execution report.",
    contentLeftMachine: false,
    artifacts: { pdf: options.pdf || null, text: options.text || null, jd: options.jd || null },
    checks: executions.map(adapterResultToCheck)
  });
  return { ...report, executions, tester_summary: buildTesterSummary(executions) };
}

export function resolveTesterLocations({
  workspaceRoot = process.cwd(),
  testerRoot,
  "tester-root": cliTesterRoot
} = {}) {
  const workspace = resolve(workspaceRoot);
  return {
    workspaceRoot: workspace,
    testerRoot: resolve(workspace, testerRoot || cliTesterRoot || "testers")
  };
}

export function testerExitCode(report) {
  if (report.checks?.some((check) => check.metadata?.required_capability_unavailable === true)) {
    return 69;
  }
  return report.status === "fail" ? 2 : 0;
}

function selectedTools(value) {
  const selected =
    value === "all"
      ? knownTools
      : value
          .split(",")
          .map((tool) => tool.trim())
          .filter(Boolean);
  const unknown = selected.filter((tool) => !knownTools.includes(tool));
  if (unknown.length > 0) {
    const error = new Error(`Unknown tester adapter: ${unknown.join(", ")}.`);
    error.code = "INVALID_USAGE";
    throw error;
  }
  return selected;
}

function requiredTools(options) {
  const values = [options.required || "", options.profile === "strict" ? "ats-checker" : ""];
  const required = new Set(
    values
      .join(",")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean)
  );
  const unknown = [...required].filter((tool) => !knownTools.includes(tool));
  if (unknown.length > 0) {
    const error = new Error(`Unknown required tester adapter: ${unknown.join(", ")}.`);
    error.code = "INVALID_USAGE";
    throw error;
  }
  return required;
}

async function runAtsChecker(options, required) {
  return runTesterAdapter({
    id: "ats-checker",
    required,
    preflight: async () => {
      if (!options.pdf || !existsSync(resolve(options.workspaceRoot, options.pdf))) {
        return "ATS-Checker needs --pdf pointing to an existing PDF.";
      }
      if (!options.text || !existsSync(resolve(options.workspaceRoot, options.text))) {
        return "ATS-Checker needs --text pointing to baseline extracted text.";
      }
      return "";
    },
    execute: async ({ timeoutMs }) => {
      const [extraction, baselineText] = await Promise.all([
        runAtsCheckerExtraction({
          pdf: options.pdf,
          workspaceRoot: options.workspaceRoot,
          testerRoot: options.testerRoot,
          timeoutMs
        }),
        readFile(resolve(options.workspaceRoot, options.text), "utf8")
      ]);
      return { extraction, baselineText };
    },
    evaluate: ({ extraction, baselineText }) => {
      if (!extraction.available) {
        return { state: "skipped", reason: `ATS-Checker unavailable: ${extraction.reason}.` };
      }
      if (!extraction.text.trim()) {
        return {
          state: "executed_fail",
          reason: "ATS-Checker produced empty extracted text.",
          failure_kind: "empty_output"
        };
      }
      const agreement = compareParserExtractions(baselineText, extraction.text);
      return {
        state: agreement.status === "pass" ? "executed_pass" : "executed_warning",
        reason: agreement.evidence,
        metadata: {
          tool: extraction.tool,
          extracted_chars: extraction.text.length,
          ...agreement.metadata
        }
      };
    }
  });
}

async function runAtsScreener(options, required) {
  const cwd = resolve(options.testerRoot, "ats-screener");
  const tsxCli = resolve(cwd, "node_modules/tsx/dist/cli.mjs");
  return runTesterAdapter({
    id: "ats-screener",
    required,
    preflight: async () => {
      if (!options.text || !existsSync(resolve(options.workspaceRoot, options.text))) {
        return "ats-screener needs --text extracted text.";
      }
      if (!existsSync(resolve(cwd, "node_modules"))) {
        return "ats-screener dependencies are not installed.";
      }
      if (!existsSync(tsxCli)) {
        return "ats-screener isolated tsx runtime is not installed.";
      }
      return "";
    },
    execute: ({ timeoutMs }) => {
      const runner = process.execPath;
      const args = [tsxCli, "scripts/score-local.ts", resolve(options.workspaceRoot, options.text)];
      if (options.jd) args.push(resolve(options.workspaceRoot, options.jd));
      return runCommand(runner, args, { cwd, quiet: true, timeoutMs });
    },
    evaluate: ({ stdout }) => {
      const score = parseAtsScreenerOutput(stdout);
      return {
        state: "executed_pass",
        reason: `ats-screener executed ${score.result_count} local scoring profile(s).`,
        metadata: {
          result_count: score.result_count,
          passing_count: score.passing_count,
          overall_score_min: score.overall_score_min,
          overall_score_max: score.overall_score_max,
          score_formatting: score.component_scores.formatting,
          score_keyword_match: score.component_scores.keyword_match,
          score_sections: score.component_scores.sections,
          score_experience: score.component_scores.experience,
          score_education: score.component_scores.education,
          missing_signal_count: score.missing_signal_count,
          matched_signal_count: score.matched_signal_count,
          quantified_bullets: score.quantified_bullets,
          total_bullets: score.total_bullets,
          action_verb_count: score.action_verb_count,
          network_used: false
        }
      };
    }
  });
}

async function runResumeParser(options, required) {
  const cwd = resolve(options.testerRoot, "ResumeParser");
  const venvPython = [
    resolve(options.workspaceRoot, ".runtime/testers/resume-parser/Scripts/python.exe"),
    resolve(options.workspaceRoot, ".runtime/testers/resume-parser/bin/python"),
    resolve(cwd, ".venv/Scripts/python.exe"),
    resolve(cwd, ".venv/bin/python")
  ].find((candidate) => existsSync(candidate));
  const probe = resolve(packageRoot, "checker/scripts/resume_parser_probe.py");
  let python;
  return runTesterAdapter({
    id: "resume-parser",
    required,
    preflight: async () => {
      if (!options.pdf || !existsSync(resolve(options.workspaceRoot, options.pdf))) {
        return "ResumeParser needs --pdf pointing to an existing PDF.";
      }
      python = venvPython;
      if (!python) return "ResumeParser isolated Python environment is not installed.";
      try {
        await runCommand(
          python,
          [
            "-c",
            "from resume_parser.extractors.contact_extractor import ContactExtractor; from resume_parser.utils.skills_checker import SkillsChecker; SkillsChecker()"
          ],
          {
            cwd,
            quiet: true,
            env: { PYTHONPATH: cwd, PYTHONIOENCODING: "utf-8" },
            timeoutMs: 5_000
          }
        );
      } catch {
        return "ResumeParser dependencies are not installed.";
      }
      return "";
    },
    execute: ({ timeoutMs }) =>
      runCommand(python, [probe, resolve(options.workspaceRoot, options.pdf)], {
        cwd,
        quiet: true,
        env: { PYTHONPATH: cwd, PYTHONIOENCODING: "utf-8" },
        timeoutMs
      }),
    evaluate: ({ stdout }) => {
      const structure = parseResumeParserOutput(stdout);
      return {
        state: "executed_pass",
        reason: "ResumeParser structural probe executed.",
        metadata: structure
      };
    }
  });
}

async function runResumeMatcher(_options, required) {
  return runTesterAdapter({
    id: "resume-matcher",
    required,
    preflight: async () => ({
      reason:
        "Deferred: current useful operations require the Python 3.13 backend dependency, model, or service boundary.",
      failure_kind: "deferred",
      metadata: {
        required_python: ">=3.13",
        dependency_count: 13,
        revisit_trigger: "network-free bounded operation with isolated lightweight dependencies"
      }
    }),
    execute: async () => {
      throw new Error("Deferred adapter must not execute.");
    }
  });
}

export function parseResumeParserOutput(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw malformed("ResumeParser returned invalid JSON.");
  }
  const contact = value?.contact;
  const education = value?.education;
  const experience = value?.experience;
  const skills = value?.skills;
  if (
    value?.schema_version !== 1 ||
    value?.tool !== "ResumeParser" ||
    !validPresence(contact, "field_count") ||
    !validPresence(education, "entry_count") ||
    !validPresence(experience, "entry_count") ||
    !validPresence(skills, "category_count") ||
    !nonNegativeInteger(skills?.skill_count)
  ) {
    throw malformed("ResumeParser returned malformed structural evidence.");
  }
  return {
    tool: "ResumeParser",
    contact_present: contact.present,
    contact_field_count: contact.field_count,
    education_present: education.present,
    education_entry_count: education.entry_count,
    experience_present: experience.present,
    experience_entry_count: experience.entry_count,
    skills_present: skills.present,
    skills_category_count: skills.category_count,
    skills_count: skills.skill_count
  };
}

export function parseAtsScreenerOutput(stdout) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    throw malformed("ats-screener returned invalid JSON.");
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 20) {
    throw malformed("ats-screener returned an invalid result list.");
  }
  const dimensions = ["formatting", "keywordMatch", "sections", "experience", "education"];
  for (const row of rows) {
    if (
      typeof row?.system !== "string" ||
      typeof row?.vendor !== "string" ||
      !score(row?.overallScore) ||
      typeof row?.passesFilter !== "boolean" ||
      dimensions.some((key) => !score(row?.breakdown?.[key]?.score)) ||
      !Array.isArray(row?.breakdown?.keywordMatch?.matched) ||
      !Array.isArray(row?.breakdown?.keywordMatch?.missing) ||
      !Array.isArray(row?.breakdown?.keywordMatch?.synonymMatched) ||
      !Array.isArray(row?.breakdown?.sections?.present) ||
      !Array.isArray(row?.breakdown?.sections?.missing) ||
      !nonNegativeInteger(row?.breakdown?.experience?.quantifiedBullets) ||
      !nonNegativeInteger(row?.breakdown?.experience?.totalBullets) ||
      !nonNegativeInteger(row?.breakdown?.experience?.actionVerbCount)
    ) {
      throw malformed("ats-screener returned malformed score evidence.");
    }
  }
  const average = (selector) =>
    Math.round(rows.reduce((sum, row) => sum + selector(row), 0) / rows.length);
  return {
    result_count: rows.length,
    passing_count: rows.filter((row) => row.passesFilter).length,
    overall_score_min: Math.min(...rows.map((row) => row.overallScore)),
    overall_score_max: Math.max(...rows.map((row) => row.overallScore)),
    component_scores: {
      formatting: average((row) => row.breakdown.formatting.score),
      keyword_match: average((row) => row.breakdown.keywordMatch.score),
      sections: average((row) => row.breakdown.sections.score),
      experience: average((row) => row.breakdown.experience.score),
      education: average((row) => row.breakdown.education.score)
    },
    missing_signal_count: Math.max(
      ...rows.map(
        (row) => row.breakdown.keywordMatch.missing.length + row.breakdown.sections.missing.length
      )
    ),
    matched_signal_count: Math.max(
      ...rows.map(
        (row) =>
          row.breakdown.keywordMatch.matched.length +
          row.breakdown.keywordMatch.synonymMatched.length +
          row.breakdown.sections.present.length
      )
    ),
    quantified_bullets: Math.max(...rows.map((row) => row.breakdown.experience.quantifiedBullets)),
    total_bullets: Math.max(...rows.map((row) => row.breakdown.experience.totalBullets)),
    action_verb_count: Math.max(...rows.map((row) => row.breakdown.experience.actionVerbCount))
  };
}

export function buildTesterSummary(executions) {
  const states = ["executed_pass", "executed_warning", "executed_fail", "skipped"];
  const atsChecker = executions.find((item) => item.adapter_id === "ats-checker");
  const resumeParser = executions.find((item) => item.adapter_id === "resume-parser");
  return {
    execution_counts: Object.fromEntries([
      ...states.map((state) => [state, executions.filter((item) => item.state === state).length])
    ]),
    executed_parsers: executions
      .filter(
        (item) =>
          ["ats-checker", "resume-parser"].includes(item.adapter_id) &&
          item.state.startsWith("executed_")
      )
      .map((item) => item.adapter_id),
    resume_matcher_deferred: executions.some(
      (item) => item.adapter_id === "resume-matcher" && item.failure_kind === "deferred"
    ),
    parser_evidence: {
      ats_checker: {
        state: atsChecker?.state || "not_selected",
        agreement: atsChecker?.metadata?.agreement ?? null
      },
      resume_parser: {
        state: resumeParser?.state || "not_selected",
        contact_present: resumeParser?.metadata?.contact_present ?? null,
        education_present: resumeParser?.metadata?.education_present ?? null,
        education_entry_count: resumeParser?.metadata?.education_entry_count ?? null,
        experience_present: resumeParser?.metadata?.experience_present ?? null,
        experience_entry_count: resumeParser?.metadata?.experience_entry_count ?? null,
        skills_present: resumeParser?.metadata?.skills_present ?? null,
        skills_count: resumeParser?.metadata?.skills_count ?? null
      }
    },
    incompatible_scores_combined: false
  };
}

function validPresence(value, countKey) {
  return (
    typeof value?.present === "boolean" &&
    nonNegativeInteger(value?.[countKey]) &&
    value.present === value[countKey] > 0
  );
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function score(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function malformed(message) {
  const error = new Error(message);
  error.code = "MALFORMED_OUTPUT";
  return error;
}

function validateProfile(profile) {
  if (profile && !["normal", "strict"].includes(profile)) {
    const error = new Error(`Unknown tester profile: ${profile}.`);
    error.code = "INVALID_USAGE";
    throw error;
  }
}

function safeError(error) {
  return sanitizeProcessMessage(error?.message || "Unexpected tester failure.");
}
