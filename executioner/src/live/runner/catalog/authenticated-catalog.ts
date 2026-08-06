import { createHash } from "node:crypto";

import { parseCsv, serializeCsv as csv } from "./authenticated-catalog-csv.ts";

import type {
  AuthenticatedCatalogFindingV1,
  AuthenticatedCatalogJobV1,
  AuthenticatedCatalogPlanV1,
  AuthenticatedCatalogResultV1,
  BrowserClassification,
  CompiledAuthenticatedCatalogResults,
} from "./authenticated-catalog-types.ts";

export type {
  AccountHistory,
  AuthenticatedCatalogFindingV1,
  AuthenticatedCatalogJobV1,
  AuthenticatedCatalogPlanV1,
  AuthenticatedCatalogResultV1,
  BrowserClassification,
  CompiledAuthenticatedCatalogResults,
  VerificationMethod,
  VerificationRequirement,
  VerificationResult,
} from "./authenticated-catalog-types.ts";

export function createAuthenticatedCatalogPlan(input: {
  readonly catalogCsv: string;
  readonly historyCsv: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly shardCount: number;
}): AuthenticatedCatalogPlanV1 {
  if (!/^authrun_[a-f0-9]{32}$/u.test(input.runId) ||
      !canonicalTimestamp(input.createdAt) ||
      !Number.isSafeInteger(input.shardCount) || input.shardCount < 1 || input.shardCount > 5) {
    invalidCatalog();
  }
  const catalog = parseCatalog(input.catalogCsv, false);
  const history = parseCatalog(input.historyCsv, true);
  const historicalRealms = new Set(history.map((row) => row.accountRealm));
  const fresh = catalog.filter((row) => !historicalRealms.has(row.accountRealm));
  const jobs = fresh.map((row, index): AuthenticatedCatalogJobV1 => Object.freeze({
    schemaVersion: 1,
    jobId: `job_${sha256(`${input.runId}\0${row.targetUrl}`).slice(0, 24)}`,
    catalogRow: row.catalogRow,
    companyName: row.companyName,
    jobName: row.jobName,
    country: row.country,
    targetUrl: row.targetUrl,
    accountRealm: row.accountRealm,
    accountHistory: "fresh_candidate",
    shard: index % input.shardCount + 1,
    verificationRequired: "unknown",
    status: "pending",
  }));
  return Object.freeze({
    schemaVersion: 1,
    runId: input.runId,
    createdAt: input.createdAt,
    catalogSha256: sha256(input.catalogCsv),
    historySha256: sha256(input.historyCsv),
    catalogCount: catalog.length,
    historicalRealmCount: catalog.length - fresh.length,
    freshCandidateCount: fresh.length,
    shardCount: input.shardCount,
    jobs: Object.freeze(jobs),
  });
}

export function serializeAuthenticatedCatalogJobs(
  plan: AuthenticatedCatalogPlanV1,
  jobs: readonly AuthenticatedCatalogJobV1[] = plan.jobs,
): string {
  validatePlan(plan);
  const available = new Set(plan.jobs.map((job) => job.jobId));
  if (new Set(jobs.map((job) => job.jobId)).size !== jobs.length ||
      jobs.some((job) => !available.has(job.jobId))) invalidCatalog();
  const headers = [
    "job_id", "catalog_row", "company_name", "job_name", "country", "target_url",
    "account_realm", "account_history", "shard", "verification_required", "status",
  ];
  return csv([
    headers,
    ...jobs.map((job) => [
      job.jobId, String(job.catalogRow), job.companyName, job.jobName, job.country,
      job.targetUrl, job.accountRealm, job.accountHistory, String(job.shard),
      job.verificationRequired, job.status,
    ]),
  ]);
}

export function validateAuthenticatedCatalogPlan(
  value: unknown,
): asserts value is AuthenticatedCatalogPlanV1 {
  validatePlan(value);
}

export function validateAuthenticatedCatalogResult(
  value: AuthenticatedCatalogResultV1,
  plan: AuthenticatedCatalogPlanV1,
): AuthenticatedCatalogResultV1 {
  validatePlan(plan);
  const expectedKeys = [
    "schemaVersion", "runId", "jobId", "startedAt", "finishedAt", "outcome",
    "observedAccountFlow", "verificationRequired", "verificationMethod",
    "verificationResult", "postVerificationSignIn", "applicationPageReached",
    "c3PageClassification", "independentBrowserClassification",
    "classificationAgreement", "timingsMs", "findings", "evidence",
  ];
  if (!record(value) || !exactKeys(value, expectedKeys) || value.schemaVersion !== 1 ||
      value.runId !== plan.runId || !plan.jobs.some((job) => job.jobId === value.jobId) ||
      !canonicalTimestamp(value.startedAt) || !canonicalTimestamp(value.finishedAt) ||
      Date.parse(value.startedAt) > Date.parse(value.finishedAt) ||
      !["application_reached", "blocked", "failed"].includes(value.outcome) ||
      !["fresh_create", "existing_sign_in", "already_ready", "unknown"].includes(value.observedAccountFlow) ||
      !["yes", "no", "unknown"].includes(value.verificationRequired) ||
      !["email_link", "email_code", "none", "unknown"].includes(value.verificationMethod) ||
      !["verified", "not_required", "not_found", "ambiguous", "expired", "unsupported_code", "navigation_failed", "unknown"].includes(value.verificationResult) ||
      !["required_succeeded", "required_failed", "not_required", "unknown"].includes(value.postVerificationSignIn) ||
      typeof value.applicationPageReached !== "boolean" ||
      !classifications.includes(value.c3PageClassification) ||
      !classifications.includes(value.independentBrowserClassification) ||
      !["match", "minor_mismatch", "major_mismatch", "unknown"].includes(value.classificationAgreement) ||
      !validVerificationCombination(value) ||
      !validOutcomeConsistency(value) ||
      !validClassificationAgreement(value) ||
      value.outcome === "application_reached" && !value.applicationPageReached ||
      value.outcome === "blocked" && value.applicationPageReached ||
      !validTimings(value.timingsMs, Date.parse(value.finishedAt) - Date.parse(value.startedAt)) ||
      !Array.isArray(value.findings) || value.findings.length > 32 ||
      !value.findings.every(validFinding) ||
      value.classificationAgreement !== "match" && value.classificationAgreement !== "unknown" && value.findings.length === 0 ||
      !validEvidence(value.evidence, value)) {
    invalidResult();
  }
  return deepFreezeResult(value);
}

export function compileAuthenticatedCatalogResults(
  plan: AuthenticatedCatalogPlanV1,
  values: readonly AuthenticatedCatalogResultV1[],
): CompiledAuthenticatedCatalogResults {
  validatePlan(plan);
  if (values.length !== plan.jobs.length) throw new Error("results incomplete");
  const byJob = new Map<string, AuthenticatedCatalogResultV1>();
  for (const value of values) {
    const admitted = validateAuthenticatedCatalogResult(value, plan);
    if (byJob.has(admitted.jobId)) throw new Error("results invalid");
    byJob.set(admitted.jobId, admitted);
  }
  if (plan.jobs.some((job) => !byJob.has(job.jobId))) throw new Error("results incomplete");
  const headers = [
    "job_id", "catalog_row", "company_name", "job_name", "account_realm",
    "observed_account_flow", "verification_required", "verification_method",
    "verification_result", "post_verification_sign_in", "application_page_reached",
    "c3_page_classification", "independent_browser_classification",
    "classification_agreement", "outcome", "started_at", "finished_at",
    "account_entry_ms", "mailbox_wait_ms", "verification_navigation_ms",
    "post_verification_sign_in_ms", "total_ms", "finding_codes", "finding_summaries",
    "acceptance_sha256", "monitor_ack_sha256", "screenshot_sha256",
  ];
  const rows = plan.jobs.map((job) => {
    const value = byJob.get(job.jobId)!;
    return [
      job.jobId, String(job.catalogRow), job.companyName, job.jobName, job.accountRealm,
      value.observedAccountFlow, value.verificationRequired, value.verificationMethod,
      value.verificationResult, value.postVerificationSignIn,
      String(value.applicationPageReached), value.c3PageClassification,
      value.independentBrowserClassification, value.classificationAgreement, value.outcome,
      value.startedAt, value.finishedAt, String(value.timingsMs.accountEntry),
      String(value.timingsMs.mailboxWait), String(value.timingsMs.verificationNavigation),
      String(value.timingsMs.postVerificationSignIn), String(value.timingsMs.total),
      value.findings.map((finding) => finding.code).join(";"),
      value.findings.map((finding) => finding.summary).join(" | "),
      value.evidence.acceptanceSha256 ?? "", value.evidence.monitorAckSha256 ?? "",
      value.evidence.screenshotSha256 ?? "",
    ];
  });
  const findings = values.flatMap((value) => value.findings);
  return Object.freeze({
    csv: csv([headers, ...rows]),
    summary: Object.freeze({
      schemaVersion: 1,
      runId: plan.runId,
      expected: plan.jobs.length,
      completed: values.length,
      verificationRequired: values.filter((value) => value.verificationRequired === "yes").length,
      applicationReached: values.filter((value) => value.applicationPageReached).length,
      minorFindings: findings.filter((finding) => finding.severity === "minor").length,
      majorFindings: findings.filter((finding) => finding.severity === "major").length,
    }),
  });
}

interface CatalogRow {
  readonly catalogRow: number;
  readonly companyName: string;
  readonly jobName: string;
  readonly country: string;
  readonly targetUrl: string;
  readonly accountRealm: string;
}

const classifications: readonly BrowserClassification[] = [
  "application_ready", "posting_unavailable", "maintenance", "runtime_error",
  "account_entry", "verification_required", "manual_action_required", "unknown",
];

function parseCatalog(source: string, allowDuplicateRealms: boolean): readonly CatalogRow[] {
  if (Buffer.byteLength(source, "utf8") < 2 || Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024 ||
      source.startsWith("\ufeff") || source.includes("\0")) invalidCatalog();
  const rows = parseCsv(source);
  const expected = [
    "company name", "job name", "country", "link", "test status",
    "observed account flow", "last tested", "notes",
  ];
  if (rows.length < 2 || rows[0]!.length !== expected.length ||
      expected.some((name, index) => rows[0]![index] !== name)) invalidCatalog();
  const realms = new Set<string>();
  return Object.freeze(rows.slice(1).map((row, index) => {
    if (row.length !== expected.length && !(allowDuplicateRealms && row.length === 4)) invalidCatalog();
    const [companyName, jobName, country, link] = row;
    if (![companyName, jobName, link].every(validCell) || !validOptionalCell(country)) invalidCatalog();
    const target = workdayTarget(link!);
    if (target === null || (!allowDuplicateRealms && realms.has(target.accountRealm))) invalidCatalog();
    realms.add(target.accountRealm);
    return Object.freeze({
      catalogRow: index + 1,
      companyName: companyName!,
      jobName: jobName!,
      country: country!,
      targetUrl: target.targetUrl,
      accountRealm: target.accountRealm,
    });
  }));
}

function workdayTarget(value: string): { readonly targetUrl: string; readonly accountRealm: string } | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
        parsed.port !== "" || parsed.hash !== "" ||
        !/^[a-z0-9-]+\.wd\d{1,3}\.myworkdayjobs\.com$/u.test(parsed.hostname)) return null;
    if ([...parsed.searchParams.keys()].some((key) => key !== "source") ||
        parsed.searchParams.getAll("source").some((source) => source !== "LinkedIn") ||
        parsed.searchParams.getAll("source").length > 1) return null;
    const decoded = decodeURIComponent(parsed.pathname);
    const segments = decoded.split("/").filter(Boolean)
      .filter((segment) => !/^[a-z]{2}-[A-Z]{2}$/iu.test(segment));
    if (segments.length < 3 || !segments.some((segment) => segment.toLowerCase() === "job") ||
        segments.some((segment) => segment === "..") || decoded.includes("//")) return null;
    const site = segments[0]!.toLowerCase();
    if (!/^[a-z0-9_\-]{1,100}$/u.test(site)) return null;
    const targetUrl = `${parsed.origin}${parsed.pathname}`;
    return Object.freeze({
      targetUrl,
      accountRealm: `${parsed.hostname.toLowerCase()}|${site}`,
    });
  } catch {
    return null;
  }
}

function validVerificationCombination(value: AuthenticatedCatalogResultV1): boolean {
  if (value.verificationRequired === "no") {
    return value.verificationMethod === "none" && value.verificationResult === "not_required" &&
      value.postVerificationSignIn === "not_required";
  }
  if (value.verificationRequired === "unknown") {
    return value.verificationMethod === "unknown" && value.verificationResult === "unknown" &&
      value.postVerificationSignIn === "unknown";
  }
  if (value.verificationMethod === "email_link") {
    return ["verified", "not_found", "ambiguous", "expired", "navigation_failed"].includes(value.verificationResult);
  }
  return value.verificationMethod === "email_code" &&
    ["verified", "not_found", "ambiguous", "expired", "unsupported_code"].includes(value.verificationResult);
}

function validOutcomeConsistency(value: AuthenticatedCatalogResultV1): boolean {
  if (value.verificationRequired === "yes" && value.verificationResult !== "verified" &&
      value.postVerificationSignIn === "required_succeeded") return false;
  if (!value.applicationPageReached) return true;
  return value.independentBrowserClassification === "application_ready" &&
    value.verificationRequired !== "unknown" &&
    (value.verificationRequired === "no" || value.verificationResult === "verified") &&
    value.postVerificationSignIn !== "required_failed" &&
    value.postVerificationSignIn !== "unknown";
}

function validClassificationAgreement(value: AuthenticatedCatalogResultV1): boolean {
  if (value.classificationAgreement === "match") {
    return value.c3PageClassification === value.independentBrowserClassification;
  }
  if (value.classificationAgreement === "minor_mismatch") {
    return value.findings.some((finding) => finding.severity === "minor");
  }
  if (value.classificationAgreement === "major_mismatch") {
    return value.findings.some((finding) => finding.severity === "major");
  }
  return true;
}

function validTimings(value: AuthenticatedCatalogResultV1["timingsMs"], wallMs: number): boolean {
  if (!record(value) || !exactKeys(value, [
    "accountEntry", "mailboxWait", "verificationNavigation", "postVerificationSignIn", "total",
  ])) return false;
  const entries = Object.values(value);
  return entries.every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= 30 * 60 * 1_000) &&
    value.total >= Math.max(value.accountEntry, value.mailboxWait, value.verificationNavigation, value.postVerificationSignIn) &&
    value.total <= wallMs;
}

function validFinding(value: AuthenticatedCatalogFindingV1): boolean {
  return record(value) && exactKeys(value, ["severity", "phase", "code", "summary"]) &&
    ["minor", "major"].includes(value.severity) &&
    ["account_entry", "mailbox", "verification_navigation", "post_verification_sign_in", "application_entry", "monitoring"].includes(value.phase) &&
    ["page_misclassification", "account_flow_misclassification", "mailbox_misclassification", "wrong_value_typed", "wrong_click", "missed_click", "verification_not_detected", "verification_delay", "wrong_verification_parameters", "navigation_misclassification", "monitor_ack_missing", "unexpected_wait", "other"].includes(value.code) &&
    value.summary.length >= 1 && value.summary.length <= 240 &&
    !/[\0\r\n]/u.test(value.summary) && !formula(value.summary) &&
    !/(?:https?:\/\/|www\.|[^\s@]+@[^\s@]+|password|passwd|token|secret|authorization|credential)/iu.test(value.summary);
}

function validEvidence(
  value: AuthenticatedCatalogResultV1["evidence"],
  result: AuthenticatedCatalogResultV1,
): boolean {
  if (!record(value) || !exactKeys(value, [
    "acceptanceSha256", "monitorAckSha256", "screenshotSha256",
  ])) return false;
  const hashOrNull = (candidate: unknown) =>
    candidate === null || typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate);
  if (!hashOrNull(value.acceptanceSha256) || !hashOrNull(value.monitorAckSha256) ||
      !hashOrNull(value.screenshotSha256) ||
      result.applicationPageReached && value.acceptanceSha256 === null ||
      (value.monitorAckSha256 === null) !== (value.screenshotSha256 === null)) return false;
  if (value.monitorAckSha256 !== null) return true;
  return result.outcome === "failed" && result.findings.some((finding) =>
    finding.severity === "major" && finding.phase === "monitoring" &&
    finding.code === "monitor_ack_missing"
  );
}

function validatePlan(value: unknown): asserts value is AuthenticatedCatalogPlanV1 {
  const planKeys = [
    "schemaVersion", "runId", "createdAt", "catalogSha256", "historySha256",
    "catalogCount", "historicalRealmCount", "freshCandidateCount", "shardCount", "jobs",
  ];
  if (!record(value) || !exactKeys(value, planKeys) || value.schemaVersion !== 1 ||
      typeof value.runId !== "string" || !/^authrun_[a-f0-9]{32}$/u.test(value.runId) ||
      typeof value.createdAt !== "string" || !canonicalTimestamp(value.createdAt) ||
      typeof value.catalogSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.catalogSha256) ||
      typeof value.historySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.historySha256) ||
      !safeInteger(value.catalogCount) || !safeInteger(value.historicalRealmCount) ||
      !safeInteger(value.freshCandidateCount) || !safeInteger(value.shardCount) ||
      value.shardCount < 1 || value.shardCount > 5 ||
      value.catalogCount < 1 || value.historicalRealmCount < 0 || value.freshCandidateCount < 0 ||
      value.historicalRealmCount + value.freshCandidateCount !== value.catalogCount ||
      !Array.isArray(value.jobs) || value.jobs.length !== value.freshCandidateCount) invalidCatalog();
  const jobKeys = [
    "schemaVersion", "jobId", "catalogRow", "companyName", "jobName", "country",
    "targetUrl", "accountRealm", "accountHistory", "shard", "verificationRequired", "status",
  ];
  const jobIds = new Set<string>();
  const realms = new Set<string>();
  for (const job of value.jobs) {
    if (!record(job) || !exactKeys(job, jobKeys) || job.schemaVersion !== 1 ||
        typeof job.jobId !== "string" || !/^job_[a-f0-9]{24}$/u.test(job.jobId) || jobIds.has(job.jobId) ||
        !safeInteger(job.catalogRow) || job.catalogRow < 1 || job.catalogRow > value.catalogCount ||
        !validCell(job.companyName) || !validCell(job.jobName) || !validOptionalCell(job.country) ||
        typeof job.targetUrl !== "string" || typeof job.accountRealm !== "string" ||
        job.accountHistory !== "fresh_candidate" || !safeInteger(job.shard) ||
        job.shard < 1 || job.shard > value.shardCount || job.verificationRequired !== "unknown" ||
        job.status !== "pending") invalidCatalog();
    const target = workdayTarget(job.targetUrl);
    if (target === null || target.targetUrl !== job.targetUrl || target.accountRealm !== job.accountRealm ||
        realms.has(job.accountRealm)) invalidCatalog();
    jobIds.add(job.jobId);
    realms.add(job.accountRealm);
  }
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function deepFreezeResult(value: AuthenticatedCatalogResultV1): AuthenticatedCatalogResultV1 {
  const findings = Object.freeze(value.findings.map((finding) => Object.freeze({ ...finding })));
  return Object.freeze({
    ...value,
    timingsMs: Object.freeze({ ...value.timingsMs }),
    findings,
    evidence: Object.freeze({ ...value.evidence }),
  });
}

function validCell(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 2_048 &&
    !/[\0\r\n]/u.test(value) && !formula(value);
}

function validOptionalCell(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2_048 &&
    !/[\0\r\n]/u.test(value) && !formula(value);
}

function formula(value: string): boolean {
  return /^\s*[=+\-@]/u.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalidCatalog(): never {
  throw new Error("catalog invalid");
}

function invalidResult(): never {
  throw new Error("result invalid");
}
