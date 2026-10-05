import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getRepoRoot } from "../../generator/scripts/build-lib.mjs";
import { createCheck } from "./report-lib.mjs";

const roleTerms = [
  "software",
  "engineer",
  "backend",
  "frontend",
  "full-stack",
  "cloud",
  "database",
  "api",
  "distributed"
];

const knownTechTerms = [
  "aws",
  "azure",
  "docker",
  "dynamodb",
  "gcp",
  "kotlin",
  "kubernetes",
  "postgresql",
  "react",
  "terraform",
  "typescript"
];

export async function analyzeJobDescription({ jdPath, resumeText = "" }) {
  if (!jdPath) {
    return [
      createCheck({
        id: "job_description_optional",
        category: "jd_match",
        severity: "low",
        status: "warning",
        evidence: "No job description path provided.",
        suggestedFix: "Provide --jd when running job-specific matching."
      })
    ];
  }

  const text = await readFile(resolve(getRepoRoot(), jdPath), "utf8");
  return analyzeJobDescriptionText(text, resumeText);
}

export function analyzeJobDescriptionText(jdText, resumeText = "") {
  const checks = [];
  const jdTokens = extractSignalTerms(jdText);
  const resumeTokens = new Set(extractSignalTerms(resumeText).map((token) => token.toLowerCase()));
  const missing = jdTokens.filter((token) => !resumeTokens.has(token.toLowerCase())).slice(0, 20);

  checks.push(
    createCheck({
      id: "job_description_signal_present",
      category: "jd_match",
      severity: "medium",
      status: jdTokens.length >= 5 ? "pass" : "warning",
      evidence:
        jdTokens.length >= 5
          ? `Detected ${jdTokens.length} JD signal term(s).`
          : "JD has few detectable technical or role signal terms.",
      suggestedFix:
        jdTokens.length >= 5 ? "" : "Use a fuller JD before treating match output as meaningful."
    })
  );

  checks.push(
    createCheck({
      id: "jd_keyword_coverage",
      category: "jd_match",
      severity: missing.length > 0 ? "medium" : "low",
      status: missing.length > 0 ? "warning" : "pass",
      evidence:
        missing.length > 0
          ? `Potential JD terms not found in resume text: ${missing.join(", ")}.`
          : "Detected JD signal terms appear covered in the available resume text.",
      suggestedFix:
        missing.length > 0
          ? "Review missing terms manually; only add terms that are grounded in source facts."
          : "",
      metadata: { missing_terms: missing }
    })
  );

  return checks;
}

export function extractSignalTerms(text) {
  const tokens =
    text
      .match(/[A-Za-z][A-Za-z0-9+#.-]{1,}/g)
      ?.map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, ""))
      .filter((token) => token.length >= 3) || [];

  const technical = tokens.filter((token) => {
    const lower = token.toLowerCase();
    return (
      /[A-Z]/.test(token.slice(1)) ||
      /[+#.]/.test(token) ||
      roleTerms.includes(lower) ||
      knownTechTerms.includes(lower)
    );
  });

  const deduped = [];
  const seen = new Set();
  for (const token of technical) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(token);
  }

  return deduped.slice(0, 60);
}
