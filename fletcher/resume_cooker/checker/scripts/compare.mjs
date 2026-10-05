import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoRoot, parseArgs } from "../../generator/scripts/build-lib.mjs";
import { checkAtsCheckerAgreement } from "./ats-checker.mjs";
import { compareResumeFiles } from "./compare-lib.mjs";
import { createCheck, createReport, sanitizeProcessMessage, writeReport } from "./report-lib.mjs";
import { analyzeExtractedText, checkPdfPageLimit, extractPdfText } from "./text-layer.mjs";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = await runCompare(args);
    const written = await writeReport(report, args.out);
    console.log(JSON.stringify({ status: report.status, report: written || null }, null, 2));
    process.exitCode = compareExitCode(report);
  } catch (error) {
    console.error(safeError(error));
    process.exitCode =
      error.code === "INVALID_USAGE" ? 64 : error.code === "CAPABILITY_UNAVAILABLE" ? 69 : 70;
  }
}

export async function runCompare(
  options = {},
  { inspectPdfArtifactImpl = inspectPdfArtifact } = {}
) {
  if (!options.before || !options.after) {
    const error = new Error("compare requires --before and --after paths.");
    error.code = "INVALID_USAGE";
    throw error;
  }
  const { strict, maxPages } = validateCompareOptions(options);
  const policy = await readPolicy(options.policy);
  const jdSignals = options.jd ? await readJdSignals(options.jd) : [];
  const comparison = await compareResumeFiles({
    before: options.before,
    after: options.after,
    beforeFacts: options["before-facts"],
    afterFacts: options["after-facts"],
    profileFacts: options["profile-facts"],
    protectedIds: policy.protected_ids,
    omittedIds: policy.omitted_ids,
    strengthSeverity: policy.strength_severity,
    jdSignals
  });
  const checks = comparison.checks;
  const artifactChecks = options.pdf
    ? await inspectPdfArtifactImpl({
        pdf: options.pdf,
        strict,
        maxPages,
        workspaceRoot: options.workspaceRoot,
        protectedFacts: comparison.protectedFacts,
        strengthSeverity: policy.strength_severity
      })
    : [
        createCheck({
          id: strict ? "pdf_artifact_required" : "pdf_artifact_not_supplied",
          category: "pdf_text_layer",
          severity: strict ? "blocker" : "medium",
          status: strict ? "fail" : "warning",
          evidence: strict
            ? "Strict comparison requires a tailored PDF for artifact inspection."
            : "No tailored PDF was supplied; artifact checks were not executed.",
          suggestedFix: "Supply --pdf to complete postflight artifact inspection.",
          metadata: {
            optional_check_skipped: !strict,
            required_capability_unavailable: strict,
            failure_kind: strict ? "unavailable" : "not_supplied"
          }
        })
      ];
  checks.push(...artifactChecks);
  return {
    ...createReport({
      stage: "postflight",
      suite: "local",
      resume: {
        source: options.before,
        compared_to: options.after,
        pdf: options.pdf || null
      },
      checks,
      contentLeftMachine: false
    }),
    inputs_checked: {
      source: true,
      tailored: true,
      structured_before: Boolean(options["before-facts"]),
      structured_after: Boolean(options["after-facts"]),
      approved_profile: Boolean(options["profile-facts"]),
      jd: Boolean(options.jd),
      pdf: Boolean(options.pdf)
    }
  };
}

export async function inspectPdfArtifact({
  pdf,
  strict = false,
  maxPages = 1,
  workspaceRoot = getRepoRoot(),
  protectedFacts = [],
  strengthSeverity = "warning"
}) {
  workspaceRoot = resolve(workspaceRoot);
  const fullPath = resolve(workspaceRoot, pdf);
  if (!existsSync(fullPath)) {
    return [
      createCheck({
        id: "pdf_artifact_non_empty",
        category: "pdf_text_layer",
        severity: "blocker",
        status: "fail",
        evidence: "The supplied PDF does not exist.",
        suggestedFix: "Build or supply the tailored PDF before postflight comparison."
      })
    ];
  }
  const info = await stat(fullPath);
  if (!info.isFile() || info.size === 0) {
    return [
      createCheck({
        id: "pdf_artifact_non_empty",
        category: "pdf_text_layer",
        severity: "blocker",
        status: "fail",
        evidence: "The supplied PDF is empty or not a file.",
        suggestedFix: "Rebuild the tailored PDF before postflight comparison."
      })
    ];
  }
  const checks = [
    createCheck({
      id: "pdf_artifact_non_empty",
      category: "pdf_text_layer",
      severity: "blocker",
      status: "pass",
      evidence: "The supplied PDF exists and is non-empty.",
      metadata: { bytes: info.size }
    }),
    await checkPdfPageLimit({ pdf, maxPages, required: strict, workspaceRoot })
  ];
  const extractionOut = createPostflightTextPath();
  try {
    const extracted = await extractPdfText({
      pdf,
      out: extractionOut,
      workspaceRoot
    });
    checks.push(...analyzeExtractedText(extracted.text));
    checks.push(checkProtectedPdfFacts(extracted.text, protectedFacts, strengthSeverity));
    checks.push(
      ...(await checkAtsCheckerAgreement({
        pdf,
        baselineText: extracted.text,
        required: false
      }))
    );
    checks.push(
      createCheck({
        id: "pdf_text_extraction_executed",
        category: "pdf_text_layer",
        severity: "low",
        status: "pass",
        evidence: "The supplied PDF text layer was extracted and inspected.",
        metadata: { tool: extracted.tool, extracted_chars: extracted.text.length }
      })
    );
  } catch (error) {
    const unavailable = error.code === "CAPABILITY_UNAVAILABLE";
    checks.push(
      createCheck({
        id: unavailable ? "pdf_text_extraction_unavailable" : "pdf_text_extraction_failed",
        category: "pdf_text_layer",
        severity: strict || !unavailable ? "blocker" : "medium",
        status: strict || !unavailable ? "fail" : "warning",
        evidence: unavailable
          ? "No usable PDF text extractor is available."
          : "The supplied PDF text layer could not be extracted.",
        suggestedFix: "Install Poppler or start Docker, then rerun comparison.",
        metadata: {
          required_capability_unavailable: strict && unavailable,
          failure_kind: unavailable ? "unavailable" : "extraction_failed"
        }
      })
    );
  } finally {
    await rm(resolve(workspaceRoot, extractionOut), { force: true });
  }
  return checks;
}

export function compareExitCode(report) {
  if (report.checks?.some((check) => check.metadata?.required_capability_unavailable === true)) {
    return 69;
  }
  return report.status === "fail" ? 2 : 0;
}

export function checkProtectedPdfFacts(text, protectedFacts, strengthSeverity = "warning") {
  const normalizedText = normalizeArtifactText(text);
  const missingIds = protectedFacts
    .filter((fact) => !containsArtifactTerm(normalizedText, fact.normalized))
    .map((fact) => fact.id)
    .sort();
  const blocking = strengthSeverity === "blocker";
  return createCheck({
    id: "protected_facts_rendered",
    category: "pdf_text_layer",
    severity: blocking ? "blocker" : "medium",
    status: missingIds.length === 0 ? "pass" : blocking ? "fail" : "warning",
    evidence:
      missingIds.length === 0
        ? "Configured protected facts are present in the extracted PDF text."
        : `${missingIds.length} configured protected fact(s) are absent from the extracted PDF text.`,
    suggestedFix:
      missingIds.length === 0
        ? ""
        : "Restore the protected facts in the rendered artifact or acknowledge exact omissions.",
    metadata: {
      protected_count: protectedFacts.length,
      missing_count: missingIds.length,
      missing_ids: missingIds
    }
  });
}

export function createPostflightTextPath() {
  return `.runtime/reports/postflight-${randomUUID()}.txt`;
}

async function readPolicy(path) {
  if (!path) return { protected_ids: [], omitted_ids: [], strength_severity: "warning" };
  const value = await readJson(path, "Comparison policy");
  if (
    !Array.isArray(value.protected_ids) ||
    !Array.isArray(value.omitted_ids) ||
    !["warning", "blocker"].includes(value.strength_severity || "warning")
  ) {
    const error = new Error("Comparison policy is malformed.");
    error.code = "INVALID_USAGE";
    throw error;
  }
  return {
    protected_ids: value.protected_ids,
    omitted_ids: value.omitted_ids,
    strength_severity: value.strength_severity || "warning"
  };
}

async function readJdSignals(path) {
  let text;
  try {
    text = await readFile(resolve(getRepoRoot(), path), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw invalid("The supplied JD input does not exist.");
    throw error;
  }
  return [...new Set(text.match(/\b[A-Za-z][A-Za-z0-9+#.]{1,30}\b/g) || [])];
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(resolve(getRepoRoot(), path), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw invalid(`${label} input does not exist.`);
    if (error instanceof SyntaxError) {
      throw invalid(`${label} is not valid JSON.`);
    }
    throw error;
  }
}

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_USAGE";
  return error;
}

function safeError(error) {
  return sanitizeProcessMessage(error?.message || "Unexpected comparison failure.");
}

function validateCompareOptions(options) {
  if (options.profile && !["normal", "strict"].includes(options.profile)) {
    throw invalid(`Unknown comparison profile: ${options.profile}.`);
  }
  const rawMaxPages = options["max-pages"];
  const maxPages = rawMaxPages === undefined ? 1 : Number(rawMaxPages);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw invalid("--max-pages must be a positive integer.");
  }
  return { strict: options.profile === "strict", maxPages };
}

function normalizeArtifactText(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsArtifactTerm(normalizedText, term) {
  const textTokens = normalizedText.split(" ").filter(Boolean);
  const termTokens = normalizeArtifactText(term).split(" ").filter(Boolean);
  if (termTokens.length === 0 || termTokens.length > textTokens.length) return false;
  return textTokens.some(
    (_, index) =>
      index + termTokens.length <= textTokens.length &&
      termTokens.every((token, offset) => textTokens[index + offset] === token)
  );
}
