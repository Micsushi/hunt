import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { commandExists, runCommand } from "../../generator/scripts/build-lib.mjs";
import { createCheck } from "./report-lib.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extractScript = resolve(scriptDir, "ats_checker_extract.py");
export const defaultAgreementThreshold = 0.6;

// Runs the ATS-Checker style PDF text extraction via a small Python helper.
// Returns a structured result instead of throwing so callers can skip cleanly
// when Python or a PDF reader library is unavailable.
export async function runAtsCheckerExtraction({
  pdf,
  workspaceRoot = process.cwd(),
  testerRoot = resolve(workspaceRoot, "testers"),
  timeoutMs = 30_000,
  existsSyncImpl = existsSync,
  commandExistsImpl = commandExists,
  runCommandImpl = runCommand
} = {}) {
  const atsCheckerRoot = resolve(testerRoot, "ATS-Checker");
  const atsCheckerModule = resolve(atsCheckerRoot, "ats.py");
  const python = await detectPython({ atsCheckerRoot, existsSyncImpl, commandExistsImpl });
  if (!python) {
    return { available: false, reason: "python not found" };
  }

  const pdfPath = resolve(workspaceRoot, pdf);
  let stdout = "";
  try {
    const result = await runCommandImpl(python, [extractScript, atsCheckerModule, pdfPath], {
      quiet: true,
      timeoutMs
    });
    stdout = result.stdout || "";
  } catch (error) {
    // The helper prints a JSON error payload before exiting non-zero.
    stdout = error.stdout || "";
    if (!stdout) return { available: false, reason: error.message };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { available: false, reason: "could not parse extractor output" };
  }

  if (!parsed.ok) {
    return { available: false, reason: sanitizeReason(parsed.error || "extractor failed") };
  }
  if (typeof parsed.library !== "string" || typeof parsed.text !== "string") {
    return { available: false, reason: "extractor output did not match the expected schema" };
  }
  return { available: true, tool: `ats-checker:${parsed.library}`, text: parsed.text };
}

async function detectPython({ atsCheckerRoot, existsSyncImpl, commandExistsImpl }) {
  const venvPython = [
    resolve(atsCheckerRoot, ".venv", "Scripts", "python.exe"),
    resolve(atsCheckerRoot, ".venv", "bin", "python")
  ].find((candidate) => existsSyncImpl(candidate));
  if (venvPython) return venvPython;
  if (await commandExistsImpl("python")) return "python";
  if (await commandExistsImpl("python3")) return "python3";
  return null;
}

// Pure, testable comparison of two extracted-text bodies. Surfaces parser
// disagreement (Stage 3 goal) without depending on Python being installed.
export function compareParserExtractions(
  baselineText,
  atsText,
  { threshold = defaultAgreementThreshold } = {}
) {
  const baseline = tokenSet(baselineText);
  const ats = tokenSet(atsText);

  if (baseline.size === 0 || ats.size === 0) {
    return createCheck({
      id: "parser_extraction_agreement",
      category: "tester_integration",
      severity: "blocker",
      status: "fail",
      evidence: "One or both extractors produced no comparable tokens.",
      suggestedFix: "Confirm the PDF has a selectable text layer before trusting parser output.",
      metadata: {
        baseline_tokens: baseline.size,
        ats_tokens: ats.size,
        threshold
      }
    });
  }

  const shared = [...baseline].filter((token) => ats.has(token));
  const union = new Set([...baseline, ...ats]);
  const agreement = shared.length / union.size;
  const baselineOnlyCount = [...baseline].filter((token) => !ats.has(token)).length;
  const atsOnlyCount = [...ats].filter((token) => !baseline.has(token)).length;
  const ok = agreement >= threshold;

  return createCheck({
    id: "parser_extraction_agreement",
    category: "tester_integration",
    severity: "medium",
    status: ok ? "pass" : "warning",
    evidence: ok
      ? `Baseline and ATS-Checker extractions agree on ${(agreement * 100).toFixed(0)}% of tokens.`
      : `Baseline and ATS-Checker extractions agree on only ${(agreement * 100).toFixed(0)}% of tokens.`,
    suggestedFix: ok
      ? ""
      : "Inspect layout/encoding: parser disagreement can mean an ATS reads the resume differently.",
    metadata: {
      agreement: Number(agreement.toFixed(3)),
      threshold,
      baseline_tokens: baseline.size,
      ats_tokens: ats.size,
      shared_tokens: shared.length,
      baseline_only_tokens: baselineOnlyCount,
      ats_only_tokens: atsOnlyCount
    }
  });
}

// Convenience for the local suite: run the wrapper and turn the result into checks.
export async function checkAtsCheckerAgreement({
  pdf,
  baselineText,
  required = false,
  ...deps
} = {}) {
  const extraction = await runAtsCheckerExtraction({ pdf, ...deps });
  if (!extraction.available) {
    return [
      createCheck({
        id: "tester_ats_checker_skipped",
        category: "tester_integration",
        severity: required ? "blocker" : "low",
        status: required ? "fail" : "warning",
        evidence: `ATS-Checker wrapper skipped: ${extraction.reason}.`,
        suggestedFix:
          "Create testers/ATS-Checker/.venv and install its requirements to enable parser comparison.",
        metadata: { required_capability_unavailable: required }
      })
    ];
  }

  return [
    createCheck({
      id: "tester_ats_checker_ran",
      category: "tester_integration",
      severity: "low",
      status: "pass",
      evidence: `ATS-Checker extraction ran via ${extraction.tool}.`,
      metadata: { tool: extraction.tool }
    }),
    compareParserExtractions(baselineText || "", extraction.text)
  ];
}

function tokenSet(text) {
  return new Set(
    (text || "")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9+#.-]{1,}/g)
      ?.filter((token) => token.length >= 3) || []
  );
}

function sanitizeReason(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 220);
}
