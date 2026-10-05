import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { getRepoRoot } from "../../generator/scripts/build-lib.mjs";

const severityWeight = {
  low: 1,
  medium: 2,
  high: 3,
  blocker: 4
};

export function createCheck({
  id,
  category,
  severity = "low",
  status = "pass",
  suite = "local",
  evidence = "",
  suggestedFix = "",
  provider = "deterministic",
  model = null,
  contentLeftMachine = false,
  metadata = {}
}) {
  return {
    id,
    suite,
    category,
    severity,
    status,
    evidence,
    suggested_fix: suggestedFix,
    provider,
    model,
    content_left_machine: contentLeftMachine,
    metadata
  };
}

export function summarizeChecks(checks) {
  const failing = checks.filter((check) => check.status === "fail");
  if (failing.some((check) => check.severity === "blocker")) return "fail";
  if (failing.length > 0 || checks.some((check) => check.status === "warning")) {
    return "pass_with_warnings";
  }
  return "pass";
}

export function highestSeverity(checks) {
  return checks.reduce((highest, check) => {
    return severityWeight[check.severity] > severityWeight[highest] ? check.severity : highest;
  }, "low");
}

export function createReport({
  stage,
  suite = "local",
  checks = [],
  resume = {},
  artifacts = {},
  summary = "",
  contentLeftMachine = false
}) {
  const status = summarizeChecks(checks);
  return {
    schema_version: 1,
    status,
    stage,
    suite,
    summary: summary || defaultSummary(status, checks),
    generated_at: new Date().toISOString(),
    content_left_machine: contentLeftMachine,
    resume: sanitizeReportValue(resume),
    artifacts: sanitizeReportValue(artifacts),
    checks: sanitizeReportValue(checks)
  };
}

export function sanitizeReportValue(value) {
  return sanitizeValue(value);
}

function sanitizeValue(value, key = "") {
  if (sensitiveKey(key)) return "[redacted]";
  if (typeof value === "string") {
    return value
      .replace(
        /\b(?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\s*:\s*[^\r\n,;]+/gi,
        "[redacted]"
      )
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "[redacted]")
      .replace(
        /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/gi,
        (match) => `${match.slice(0, match.indexOf("//") + 2)}[redacted]@`
      )
      .replace(
        /([?&](?:api[_-]?key|token|secret|password|authorization)=)[^&#\s]+/gi,
        "$1[redacted]"
      )
      .replace(
        /\bsk-(?:ant-[A-Za-z0-9_-]+|or-v1-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{12,})\b/g,
        "[redacted]"
      )
      .replace(/\b(?:api[_-]?key|token|secret|password)\s*=\s*\S+/gi, "[redacted]")
      .replace(/file:\/\/\/[^\r\n"']+/gi, "[path]")
      .replace(/\\\\[^\\\r\n"']+\\[^\r\n"']+/g, "[path]")
      .replace(/(^|[\s("'=])[A-Za-z]:\\[^\r\n"']+/g, "$1[path]")
      .replace(/(^|[\s("'=])[A-Za-z]:\/[^\r\n"']+/g, "$1[path]")
      .replace(/(^|[\s("'=])\/(?!\/)[^\r\n"']+/g, "$1[path]");
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([itemKey, item]) => [itemKey, sanitizeValue(item, itemKey)])
    );
  }
  return value;
}

function sensitiveKey(key) {
  return /^(?:api[_-]?key|.*token|.*secret|password|authorization|proxy-authorization|cookie|set-cookie|credential)$/i.test(
    key
  );
}

export function sanitizeProcessMessage(value) {
  return String(sanitizeReportValue(String(value || "Unexpected failure.")))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 220);
}

export async function writeReport(report, outPath) {
  if (!outPath) return null;
  const fullPath = resolve(getRepoRoot(), outPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return isAbsolute(outPath)
    ? "[path]"
    : String(sanitizeReportValue(String(outPath).replaceAll("\\", "/")));
}

export function mergeReports({ stage, suite, reports, resume = {}, artifacts = {} }) {
  const checks = reports.flatMap((report) => report.checks || []);
  const flaggedChecks = checks.filter((check) => check.status !== "pass");
  return createReport({
    stage,
    suite,
    resume,
    artifacts,
    checks,
    contentLeftMachine: reports.some((report) => report.content_left_machine),
    summary:
      flaggedChecks.length === 0
        ? `Combined ${reports.length} report(s); no active findings.`
        : `Combined ${reports.length} report(s); highest active severity ${highestSeverity(flaggedChecks)}.`
  });
}

function defaultSummary(status, checks) {
  if (status === "pass") return "All configured checks passed.";
  const flagged = checks.filter((check) => check.status !== "pass").length;
  return `${flagged} check(s) need review.`;
}
