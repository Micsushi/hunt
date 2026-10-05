import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getRepoRoot } from "../../generator/scripts/build-lib.mjs";
import { createCheck } from "./report-lib.mjs";

export async function analyzeLatexSource(path) {
  const fullPath = resolve(getRepoRoot(), path);
  const source = await readFile(fullPath, "utf8");
  return analyzeLatexText(source, { path });
}

export function analyzeLatexText(source, { path = "" } = {}) {
  return [
    checkSourceExists(source, path),
    checkAtsLayoutRisk(source),
    checkStandardSections(source),
    checkContactPresence(source)
  ];
}

function checkSourceExists(source, path) {
  return createCheck({
    id: "source_resume_present",
    category: "source_integrity",
    severity: "blocker",
    status: source.trim().length > 0 ? "pass" : "fail",
    evidence: source.trim().length > 0 ? `Source read from ${path}.` : `Source ${path} is empty.`,
    suggestedFix: source.trim().length > 0 ? "" : "Restore the source resume before running checks."
  });
}

function checkAtsLayoutRisk(source) {
  const patterns = [
    { name: "table", pattern: /\\begin\{tabular\}|\\begin\{table\}/ },
    { name: "columns", pattern: /\\begin\{multicols\}|\\begin\{paracol\}|\\twocolumn/ },
    { name: "icon font", pattern: /fontawesome|academicons|\\fa[A-Z]/i },
    { name: "header/footer", pattern: /fancyhdr|\\lhead|\\rhead|\\chead|\\lfoot|\\rfoot|\\cfoot/ }
  ];
  const hits = patterns.filter((item) => item.pattern.test(source)).map((item) => item.name);
  return createCheck({
    id: "ats_layout_risk_scan",
    category: "ats_structure",
    severity: "medium",
    status: hits.length === 0 ? "pass" : "warning",
    evidence:
      hits.length === 0
        ? "No common ATS layout-risk patterns found in source."
        : `Found layout-risk pattern(s): ${hits.join(", ")}.`,
    suggestedFix:
      hits.length === 0
        ? ""
        : "Consider a single-column ATS-safe variant or verify extracted text order before use."
  });
}

function checkStandardSections(source) {
  const required = ["Education", "Experience", "Projects", "Skills"];
  const missing = required.filter(
    (section) => !new RegExp(escapeRegExp(section), "i").test(source)
  );
  return createCheck({
    id: "standard_section_names",
    category: "ats_structure",
    severity: "medium",
    status: missing.length === 0 ? "pass" : "warning",
    evidence:
      missing.length === 0
        ? `Source includes standard sections: ${required.join(", ")}.`
        : `Source may be missing standard section(s): ${missing.join(", ")}.`,
    suggestedFix:
      missing.length === 0
        ? ""
        : "Prefer common ATS section names or document why a custom heading is intentional."
  });
}

function checkContactPresence(source) {
  const hasEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(source);
  const hasPhoneish = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/.test(source);
  return createCheck({
    id: "contact_fields_parseable",
    category: "source_integrity",
    severity: "high",
    status: hasEmail || hasPhoneish ? "pass" : "warning",
    evidence:
      hasEmail || hasPhoneish
        ? "Detected at least one parseable contact field without printing its value."
        : "Could not detect a parseable email or phone pattern.",
    suggestedFix:
      hasEmail || hasPhoneish
        ? ""
        : "Use plain visible contact text; exact contact validation remains a later decision."
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
