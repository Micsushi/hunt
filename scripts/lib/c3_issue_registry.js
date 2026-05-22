"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_OUTPUT_DIR = path.join("logs", "c3-issues");
const ISSUE_LOG = "issues.jsonl";
const ISSUE_SUMMARY = "index.md";

function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function short(value, limit = 500) {
  const text = clean(value);
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function list(value, limit = 40) {
  return Array.isArray(value)
    ? value.map(clean).filter(Boolean).slice(0, limit)
    : [];
}

function fingerprintFor(issue) {
  return crypto
    .createHash("sha1")
    .update(
      [
        issue.errorType,
        issue.questionHash,
        issue.questionText,
        issue.reason,
        issue.fieldId,
        issue.fieldName,
        issue.stopReason,
        issue.selectedOption,
      ]
        .map(clean)
        .join("|")
        .toLowerCase(),
    )
    .digest("hex")
    .slice(0, 16);
}

function classifyPermanentIssue(issue = {}) {
  const kind = clean(issue.kind);
  const reason = clean(issue.reason);
  const questionType = clean(issue.questionType);
  if (
    questionType === "unknown" ||
    /unknown_question|question_unresolved|unknown_no_safe|unknown_yes_fallback/i.test(
      `${kind} ${reason}`,
    )
  ) {
    return /default|fallback|selected/i.test(`${kind} ${reason}`)
      ? "unknown_question_defaulted"
      : "unknown_question_unresolved";
  }
  if (/unsupported_or_empty_option_set/i.test(`${kind} ${reason}`)) {
    return "unsupported_or_empty_option_set";
  }
  if (
    /no_safe_match|unsafe_fallback|salary_option_no_safe_match/i.test(
      `${kind} ${reason}`,
    )
  ) {
    return "no_safe_option_match";
  }
  if (/commit_not_verified/i.test(`${kind} ${reason}`)) {
    return "commit_not_verified";
  }
  if (/derived_profile_pairing/i.test(`${kind} ${reason}`)) {
    return "derived_profile_pairing";
  }
  if (/neutral_disclosure_default/i.test(`${kind} ${reason}`)) {
    return "neutral_disclosure_default";
  }
  return kind || reason ? "v2_permanent_issue" : "unknown_c3_issue";
}

function classifyStopReason(reason = "") {
  const value = clean(reason);
  if (!value) return "";
  if (/no_safe_next_button/i.test(value)) return "no_safe_next_button";
  if (/auth_primary_action_not_found/i.test(value))
    return "auth_primary_action_not_found";
  if (/auth_action_did_not_advance/i.test(value))
    return "auth_action_did_not_advance";
  if (/auth_flow_limit_reached|auth_same_page_attempt_limit/i.test(value)) {
    return "auth_loop_or_limit";
  }
  if (/visible_validation_errors/i.test(value))
    return "visible_validation_errors";
  if (/workday_runtime_error|runtime/i.test(value))
    return "workday_runtime_error";
  if (/site_or_posting_state|maintenance|service interruption/i.test(value))
    return "site_or_posting_state";
  if (/posting_not_found|page_not_found|job_not_found/i.test(value))
    return "posting_not_found";
  if (/fill_timeout|fill_retry_timeout/i.test(value)) return "fill_timeout";
  if (/fill_failed/i.test(value)) return "fill_failed";
  if (/final_submit_visible/i.test(value)) return "";
  return "page_walk_stopped";
}

function issueBase({ audit, auditPath, page, now }) {
  return {
    createdAt: now,
    source: "c3_workday_live_smoke",
    sourceAudit: auditPath ? path.normalize(auditPath) : "",
    jobUrl: clean(audit.jobUrl),
    applyUrl: clean(audit.applyUrl),
    finalHref: clean(audit.final?.href),
    pageIndex: page?.pageIndex || 0,
    retryIndex: page?.retryIndex || 0,
    stepBefore: clean(page?.stepBefore?.title),
    stepAfter: clean(page?.stepAfter?.title),
  };
}

function issueFromPermanent({ audit, auditPath, page, issue, now }) {
  const options = list(issue.options || issue.detail?.options || []);
  const record = {
    ...issueBase({ audit, auditPath, page, now }),
    severity: clean(issue.severity || "warn"),
    errorType: classifyPermanentIssue(issue),
    kind: clean(issue.kind),
    reason: clean(issue.reason),
    questionHash: clean(issue.questionHash),
    questionType: clean(issue.questionType),
    uiModel: clean(issue.uiModel),
    fieldId: clean(issue.fieldId || issue.fieldName),
    fieldName: clean(issue.fieldName),
    questionText: short(
      issue.descriptor || issue.questionText || issue.fieldName,
      1200,
    ),
    selectedOption: clean(issue.selectedOption),
    valueSource: clean(issue.valueSource),
    options,
    evidence: {
      failedStep: clean(issue.failedStep),
      selectorPath: short(issue.selectorPath, 600),
      htmlClip: short(issue.htmlClip, 600),
    },
  };
  record.fingerprint = fingerprintFor(record);
  return record;
}

function issueFromField({ audit, auditPath, page, field, now }) {
  const warning = clean(field.bestEffortWarning);
  const skippedReason = clean(field.skippedReason);
  const requiredUnfilled = field.required && !field.filled;
  if (!warning && !requiredUnfilled) return null;
  let errorType = "field_review_warning";
  if (requiredUnfilled) errorType = "required_field_unfilled";
  if (/unknown/i.test(`${warning} ${field.valueSource}`)) {
    errorType = field.selectedOption
      ? "unknown_question_defaulted"
      : "unknown_question_unresolved";
  } else if (/unsupported_or_empty_option_set/i.test(warning)) {
    errorType = "unsupported_or_empty_option_set";
  }
  const record = {
    ...issueBase({ audit, auditPath, page, now }),
    severity: requiredUnfilled ? "error" : "warn",
    errorType,
    kind: warning.split(":")[0] || "",
    reason: warning.split(":").slice(1).join(":") || skippedReason,
    questionHash: clean(field.questionHash),
    questionType: clean(field.questionType),
    uiModel: clean(field.uiModel),
    fieldId: clean(field.id),
    fieldName: clean(field.name),
    questionText: short(field.descriptor, 1200),
    selectedOption: clean(field.selectedOption),
    valueSource: clean(field.valueSource),
    options: list(field.options),
    evidence: {
      required: Boolean(field.required),
      filled: Boolean(field.filled),
      skippedReason,
      valuePut: short(field.valuePut, 300),
    },
  };
  record.fingerprint = fingerprintFor(record);
  return record;
}

function issueFromStopReason({ audit, auditPath, page, reason, now }) {
  const errorType = classifyStopReason(reason);
  if (!errorType) return null;
  const record = {
    ...issueBase({ audit, auditPath, page, now }),
    severity: "error",
    errorType,
    kind: "page_walk_stop",
    reason: clean(reason),
    stopReason: clean(reason),
    questionText: short(
      page?.nextAction?.message || page?.next?.message || "",
      1200,
    ),
    evidence: {
      nextAction: page?.nextAction || page?.next || null,
      afterErrors: page?.afterErrors || [],
      finalErrors: audit.final?.errors || [],
    },
  };
  record.fingerprint = fingerprintFor(record);
  return record;
}

function issueFromManualReview({ audit, auditPath, page, reason, now }) {
  const value = clean(reason);
  if (
    !value ||
    value === "c3_v2_permanent_issues" ||
    value === "c3_v2_page_walk_review_items"
  ) {
    return null;
  }
  const record = {
    ...issueBase({ audit, auditPath, page, now }),
    severity: "warn",
    errorType: "manual_review_reason",
    kind: "manual_review_reason",
    reason: value,
    questionText: value,
    evidence: {
      status: clean(page.status),
      afterErrors: page.afterErrors || [],
    },
  };
  record.fingerprint = fingerprintFor(record);
  return record;
}

function auditReachedReview(audit = {}) {
  return Boolean(
    audit.ok &&
      (audit.final?.pageKind === "review" ||
        audit.final?.hasSubmit ||
        /review/i.test(audit.final?.currentStep?.title || "")),
  );
}

function staleTimeoutReason(reason = "") {
  return /page_fill_and_next_timeout|fill_timeout|fill_retry_timeout/i.test(
    clean(reason),
  );
}

function reviewCoverageIssueLabels(audit = {}) {
  const labels = list(audit.final?.reviewCoverage?.noResponseLabels || [], 120);
  return labels.filter((label) =>
    /resume|cv|curriculum vitae|website|social network|linkedin|github|profile url|skills/i.test(
      label,
    ),
  );
}

function extractIssuesFromAudit(audit, auditPath = "") {
  const now = new Date().toISOString();
  const records = [];
  const pages = Array.isArray(audit.pages) ? audit.pages : [];
  const workflowReason = clean(audit.workflow?.applyEntry?.reason);
  const reachedReview = auditReachedReview(audit);
  if (workflowReason && !reachedReview) {
    const record = issueFromStopReason({
      audit,
      auditPath,
      page: {
        pageIndex: 0,
        retryIndex: 0,
        nextAction: {
          reason: workflowReason,
          message: audit.workflow?.applyEntry?.message || "",
          readyState: audit.workflow?.applyEntry?.readyState || null,
        },
      },
      reason: workflowReason,
      now,
    });
    if (record) records.push(record);
  }
  for (const page of pages) {
    const permanentIssues = page.v2AuditSummary?.permanentIssues || [];
    for (const issue of permanentIssues) {
      records.push(issueFromPermanent({ audit, auditPath, page, issue, now }));
    }
    for (const field of page.fields || []) {
      const record = issueFromField({ audit, auditPath, page, field, now });
      if (record) records.push(record);
    }
    for (const reason of page.manualReviewReasons || []) {
      if (reachedReview && staleTimeoutReason(reason)) {
        continue;
      }
      const record = issueFromManualReview({
        audit,
        auditPath,
        page,
        reason,
        now,
      });
      if (record) records.push(record);
    }
    const stopReason = page.nextAction?.reason || page.next?.reason || "";
    if (reachedReview && staleTimeoutReason(stopReason)) {
      continue;
    }
    const stopRecord = issueFromStopReason({
      audit,
      auditPath,
      page,
      reason: stopReason,
      now,
    });
    if (stopRecord) records.push(stopRecord);
  }
  if (audit.final?.errors?.length) {
    const page = pages[pages.length - 1] || {};
    const record = {
      ...issueBase({ audit, auditPath, page, now }),
      severity: "warn",
      errorType: "final_visible_errors",
      kind: "final_visible_errors",
      reason: "final_page_reported_visible_errors",
      questionText: short(audit.final.errors.join(" | "), 1200),
      evidence: { finalErrors: audit.final.errors },
    };
    record.fingerprint = fingerprintFor(record);
    records.push(record);
  }
  const reviewCoverageLabels = reviewCoverageIssueLabels(audit);
  for (const label of reviewCoverageLabels) {
    const page = pages[pages.length - 1] || {};
    const record = {
      ...issueBase({ audit, auditPath, page, now }),
      severity: "warn",
      errorType: "review_profile_section_no_response",
      kind: "review_coverage",
      reason: "profile_backed_review_section_no_response",
      questionText: short(label, 1200),
      evidence: {
        reviewCoverage: audit.final?.reviewCoverage || null,
      },
    };
    record.fingerprint = fingerprintFor(record);
    records.push(record);
  }
  const byFingerprint = new Map();
  for (const record of records) {
    if (!record.fingerprint || byFingerprint.has(record.fingerprint)) continue;
    byFingerprint.set(record.fingerprint, record);
  }
  return Array.from(byFingerprint.values());
}

function readExistingIssues(jsonlPath) {
  if (!fs.existsSync(jsonlPath)) return [];
  return fs
    .readFileSync(jsonlPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function renderSummary(records) {
  const aggregate = new Map();
  for (const record of records) {
    const key = record.fingerprint || fingerprintFor(record);
    const prior = aggregate.get(key);
    if (prior) {
      prior.count += 1;
      prior.lastSeenAt = record.createdAt || prior.lastSeenAt;
      prior.sourceAudits = Array.from(
        new Set([...prior.sourceAudits, record.sourceAudit].filter(Boolean)),
      ).slice(-5);
    } else {
      aggregate.set(key, {
        ...record,
        count: 1,
        firstSeenAt: record.createdAt,
        lastSeenAt: record.createdAt,
        sourceAudits: record.sourceAudit ? [record.sourceAudit] : [],
      });
    }
  }
  const rows = Array.from(aggregate.values()).sort((a, b) =>
    String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")),
  );
  const lines = [
    "# C3 Issue Registry",
    "",
    "Durable issue ledger generated from C3 live-smoke audits. Use this to promote unknown questions into the catalog, identify common UI gaps, and keep page-walk failures out of chat-only memory.",
    "",
    "## Known Error Types",
    "- `unknown_question_defaulted`: C3 selected a fallback for an unmapped question. Review selected option and add a catalog mapping when reusable.",
    "- `unknown_question_unresolved`: C3 could not safely resolve an unmapped question.",
    "- `unsupported_or_empty_option_set`: C3 saw an option control but no usable options or an already-committed value without options.",
    "- `required_field_unfilled`: A required field remained empty after fill.",
    "- `no_safe_next_button`: Page-walk could not find a safe Next/Continue action.",
    "- `auth_primary_action_not_found`: Auth page had no safe sign-in/create-account action.",
    "- `posting_not_found`: Workday says the posting or apply URL does not exist.",
    "- `site_or_posting_state`: Workday reached maintenance or another tenant site-state page.",
    "- `commit_not_verified`: UI showed a value but C3 could not verify React/Workday commit.",
    "- `final_visible_errors`: Final inspected page still had visible error-like text.",
    "",
    "## Latest Issues",
    "",
  ];
  if (!rows.length) {
    lines.push("No issues recorded yet.");
    return `${lines.join("\n")}\n`;
  }
  for (const row of rows.slice(0, 100)) {
    lines.push(
      `### ${row.errorType} : ${row.reason || row.kind || row.fingerprint}`,
    );
    lines.push(`- count: ${row.count}`);
    lines.push(`- firstSeen: ${row.firstSeenAt || ""}`);
    lines.push(`- lastSeen: ${row.lastSeenAt || ""}`);
    lines.push(`- job: ${row.jobUrl || row.applyUrl || ""}`);
    lines.push(`- step: ${row.stepBefore || ""} -> ${row.stepAfter || ""}`);
    if (row.questionText) lines.push(`- question: ${row.questionText}`);
    if (row.selectedOption)
      lines.push(`- selectedOption: ${row.selectedOption}`);
    if (row.valueSource) lines.push(`- valueSource: ${row.valueSource}`);
    if (row.options?.length)
      lines.push(`- options: ${row.options.join(" | ")}`);
    if (row.sourceAudits?.length)
      lines.push(`- audits: ${row.sourceAudits.join(", ")}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function recordAuditIssues({
  audit,
  auditPath = "",
  outputDir = DEFAULT_OUTPUT_DIR,
} = {}) {
  const issues = extractIssuesFromAudit(audit || {}, auditPath);
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonlPath = path.join(outputDir, ISSUE_LOG);
  const existingIssues = readExistingIssues(jsonlPath);
  const existingKeys = new Set(
    existingIssues.map((issue) =>
      [issue.sourceAudit || "", issue.fingerprint || ""].join("|"),
    ),
  );
  const newIssues = issues.filter(
    (issue) =>
      !existingKeys.has(
        [issue.sourceAudit || "", issue.fingerprint || ""].join("|"),
      ),
  );
  if (newIssues.length) {
    fs.appendFileSync(
      jsonlPath,
      `${newIssues.map((issue) => JSON.stringify(issue)).join("\n")}\n`,
      "utf8",
    );
  } else if (!fs.existsSync(jsonlPath)) {
    fs.writeFileSync(jsonlPath, "", "utf8");
  }
  const allIssues = readExistingIssues(jsonlPath);
  const summaryPath = path.join(outputDir, ISSUE_SUMMARY);
  fs.writeFileSync(summaryPath, renderSummary(allIssues), "utf8");
  return {
    issueCount: newIssues.length,
    extractedIssueCount: issues.length,
    outputDir,
    jsonlPath,
    summaryPath,
    errorTypes: Array.from(
      new Set(issues.map((issue) => issue.errorType)),
    ).sort(),
  };
}

module.exports = {
  DEFAULT_OUTPUT_DIR,
  extractIssuesFromAudit,
  recordAuditIssues,
};
