import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPdf, getRepoRoot, parseArgs } from "../../generator/scripts/build-lib.mjs";
import { checkAtsCheckerAgreement } from "./ats-checker.mjs";
import { createApiReport } from "./api-analysis.mjs";
import { analyzeJobDescription } from "./jd-analysis.mjs";
import {
  createCheck,
  createReport,
  mergeReports,
  sanitizeProcessMessage,
  writeReport
} from "./report-lib.mjs";
import { analyzeLatexSource } from "./source-analysis.mjs";
import { checkTesterSnapshots } from "./tester-wrapper.mjs";
import { analyzeExtractedText, checkPdfPageLimit, extractPdfText } from "./text-layer.mjs";

const defaultCriticalTerms = [
  "Kubernetes",
  "Terraform",
  "PostgreSQL",
  "Kotlin",
  "TypeScript",
  "DynamoDB"
];

export function criticalTermsPresentInSource(source, candidates = defaultCriticalTerms) {
  const normalized = String(source).toLocaleLowerCase("en-US");
  return candidates.filter((term) => normalized.includes(term.toLocaleLowerCase("en-US")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));

  try {
    const report = await runCheck(args);
    const written = await writeReport(report, args.out);
    console.log(JSON.stringify({ status: report.status, report: written || null }, null, 2));
    process.exitCode = exitCodeForReport(report);
  } catch (error) {
    console.error(sanitizeProcessMessage(error.message));
    process.exit(exitCodeForError(error));
  }
}

export async function runCheck(options = {}) {
  const suite = options.suite || "local";
  if (suite === "api") {
    const { resumeText, jdText } = await readReviewInputs(options);
    return createApiReport({ suite: "api", stage: "preflight", resumeText, jdText });
  }
  if (suite === "full") {
    const [local, review] = await Promise.all([
      runLocalCheck(options),
      readReviewInputs(options).then(({ resumeText, jdText }) =>
        createApiReport({ suite: "api", stage: "preflight", resumeText, jdText })
      )
    ]);
    return mergeReports({
      stage: "preflight",
      suite: "full",
      reports: [local, review],
      resume: local.resume,
      artifacts: local.artifacts
    });
  }
  return runLocalCheck(options);
}

export function exitCodeForReport(report) {
  if (report.checks?.some((check) => check.metadata?.required_capability_unavailable === true)) {
    return 69;
  }
  return report.status === "fail" ? 2 : 0;
}

export function exitCodeForError(error) {
  if (error.code === "CAPABILITY_UNAVAILABLE") return 69;
  if (error.code === "INVALID_USAGE") return 64;
  return 70;
}

async function readReviewInputs(options) {
  const resume = options.resume || "resume/source/current.tex";
  let resumeText = "";
  let jdText = "";
  try {
    resumeText = await readFile(resolve(getRepoRoot(), resume), "utf8");
  } catch {
    resumeText = "";
  }
  if (options.jd) {
    try {
      jdText = await readFile(resolve(getRepoRoot(), options.jd), "utf8");
    } catch {
      jdText = "";
    }
  }
  return { resumeText, jdText };
}

async function runLocalCheck(options) {
  const workspaceRoot = resolve(options.workspaceRoot || getRepoRoot());
  const resume = options.resume || "resume/source/current.tex";
  const checks = [];
  const artifacts = {};
  let resumeText = "";
  let pdfPath = options.pdf;

  if (extname(resume).toLowerCase() === ".tex") {
    checks.push(...(await analyzeLatexSource(resume)));
    resumeText = await readFile(resolve(workspaceRoot, resume), "utf8");
    if (options.build === "true") {
      const result = await buildPdf({
        source: resume,
        outDir: options["out-dir"] || "resume/output",
        workspaceRoot: options.workspaceRoot,
        engine: options.engine || "auto",
        quiet: true
      });
      pdfPath = result.pdfPath;
      artifacts.pdf = repoRelative(pdfPath, workspaceRoot);
    }
  }

  // Fall back to an already-built PDF so text-layer checks run without forcing a build.
  if (!pdfPath) {
    const defaultPdf = "resume/output/current.pdf";
    if (existsSync(resolve(workspaceRoot, defaultPdf))) pdfPath = defaultPdf;
  }

  if (options.profile === "strict" && (!pdfPath || !existsSync(resolve(workspaceRoot, pdfPath)))) {
    checks.push(
      createCheck({
        id: "pdf_artifact_unavailable",
        category: "pdf_text_layer",
        severity: "blocker",
        status: "fail",
        evidence: "Strict validation requires an existing PDF artifact.",
        suggestedFix: "Pass --build or provide --pdf pointing to an existing PDF.",
        metadata: { required_capability_unavailable: true }
      })
    );
  }

  if (pdfPath && existsSync(resolve(workspaceRoot, pdfPath))) {
    const expectedCriticalTerms = criticalTermsPresentInSource(resumeText);
    checks.push(
      await checkPdfPageLimit({
        pdf: pdfPath,
        maxPages: Number(options["max-pages"] || 1),
        required: options.profile === "strict",
        workspaceRoot
      })
    );
    const extracted = await extractPdfText({
      pdf: pdfPath,
      out: options["text-out"] || "resume/output/current.txt",
      workspaceRoot
    });
    artifacts.extracted_text = repoRelative(extracted.path, workspaceRoot);
    resumeText = extracted.text;
    checks.push(
      ...analyzeExtractedText(extracted.text, {
        criticalTerms: expectedCriticalTerms
      })
    );
    checks.push(
      ...(await checkAtsCheckerAgreement({
        pdf: pdfPath,
        baselineText: extracted.text,
        required: options.profile === "strict",
        workspaceRoot,
        testerRoot: resolve(workspaceRoot, options["tester-root"] || "testers")
      }))
    );
  }

  checks.push(...(await analyzeJobDescription({ jdPath: options.jd, resumeText })));
  checks.push(...(await checkTesterSnapshots()));

  return createReport({
    stage: "preflight",
    suite: "local",
    resume: {
      source: resume,
      pdf: pdfPath ? repoRelative(pdfPath, workspaceRoot) : null,
      extracted_text: artifacts.extracted_text || null
    },
    artifacts,
    checks,
    contentLeftMachine: false
  });
}

function repoRelative(path, workspaceRoot = getRepoRoot()) {
  return relative(workspaceRoot, resolve(path)).replaceAll("\\", "/");
}
