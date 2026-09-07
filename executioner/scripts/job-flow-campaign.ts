import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const jobFlowFailureClasses = [
  "selector_drift",
  "redirect",
  "expired_job",
  "auth_transition",
  "email_transition",
  "locale_state",
  "popup",
  "slow_loading",
  "session_loss",
  "error_recovery",
  "evidence_capture",
  "checkpoint_resume",
  "conditional_reveal",
  "controlled_rollback",
  "duplicate_mirror",
  "loop_stall",
] as const;

type FailureClass = (typeof jobFlowFailureClasses)[number];
type RecoveryAction =
  | "inspect_popup"
  | "reattach"
  | "reobserve"
  | "replace_job"
  | "resume_checkpoint"
  | "retry_read"
  | "typed_stop";
type CheckpointAction = "advance_only" | "discard" | "preserve";
type ExpectedTerminal = "posting_unavailable" | "resume_or_typed_stop" | "typed_stop";
type AtsFamily = "greenhouse" | "lever" | "workday";

export interface JobFlowRule {
  readonly id: string;
  readonly failureClass: FailureClass;
  readonly recoveryAction: RecoveryAction;
  readonly retryLimit: number;
  readonly checkpoint: CheckpointAction;
  readonly expectedTerminal: ExpectedTerminal;
  readonly diagnostics: readonly string[];
  readonly workaround: string;
  readonly testFiles: readonly string[];
}

export interface BaselineJob {
  readonly id: string;
  readonly company: string;
  readonly ats: AtsFamily;
  readonly stateCombination: string;
  readonly syntheticRegion: string;
  readonly officialUrl: string;
  readonly allowedHosts: readonly string[];
  readonly titleMarker: string;
  readonly permittedJourney: readonly string[];
  readonly terminalState: "review" | "unsupported_ats_safe_stop";
  readonly testFiles: readonly string[];
}

export interface JobFlowMatrix {
  readonly schemaVersion: 1;
  readonly matrixRevision: "job-flow-campaign-v1";
  readonly repeatRuns: number;
  readonly liveValidation: {
    readonly retryLimit: number;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  };
  readonly safety: {
    readonly syntheticIdentityOnly: true;
    readonly sensitiveStepsMocked: true;
    readonly externalSubmissionAllowed: false;
  };
  readonly requiredFailureClasses: readonly FailureClass[];
  readonly rules: readonly JobFlowRule[];
  readonly baselineJobs: readonly BaselineJob[];
}

export interface ReadOnlyLiveEvidence {
  readonly jobId: string;
  readonly company: string;
  readonly ats: AtsFamily;
  readonly outcome: "posting_present" | "expired" | "redirect_denied" | "title_mismatch" | "unavailable";
  readonly attempts: number;
  readonly status: number | null;
  readonly finalHost: string | null;
  readonly titleMatched: boolean;
  readonly bytes: number;
}

type FetchLike = (
  url: string,
  init: {
    readonly method: "GET";
    readonly redirect: "manual";
    readonly signal: AbortSignal;
    readonly headers: Readonly<Record<string, string>>;
  },
) => Promise<{
  readonly status: number;
  readonly url: string;
  readonly headers: Pick<Headers, "get">;
  readonly body: ReadableStream<Uint8Array> | null;
}>;

export function loadJobFlowMatrix(path: string, repositoryRoot: string): JobFlowMatrix {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const issues = validateJobFlowMatrix(parsed, repositoryRoot);
  if (issues.length > 0) throw new Error(`job-flow matrix invalid: ${issues.join("; ")}`);
  return parsed as JobFlowMatrix;
}

export function validateJobFlowMatrix(value: unknown, repositoryRoot: string): string[] {
  if (!record(value)) return ["matrix must be an object"];
  const matrix = value as unknown as JobFlowMatrix;
  const issues: string[] = [];
  if (matrix.schemaVersion !== 1 || matrix.matrixRevision !== "job-flow-campaign-v1") {
    issues.push("unsupported matrix revision");
  }
  if (!integerIn(matrix.repeatRuns, 2, 10)) issues.push("repeatRuns must be between 2 and 10");
  if (
    !record(matrix.liveValidation) ||
    !integerIn(matrix.liveValidation.retryLimit, 0, 2) ||
    !integerIn(matrix.liveValidation.timeoutMs, 1_000, 60_000) ||
    !integerIn(matrix.liveValidation.maxBytes, 1_024, 4_194_304)
  ) issues.push("live validation limits are invalid");
  if (
    !record(matrix.safety) || matrix.safety.syntheticIdentityOnly !== true ||
    matrix.safety.sensitiveStepsMocked !== true ||
    matrix.safety.externalSubmissionAllowed !== false
  ) issues.push("safe synthetic execution is mandatory");
  if (JSON.stringify(matrix.requiredFailureClasses) !== JSON.stringify(jobFlowFailureClasses)) {
    issues.push("required failure classes are incomplete or reordered");
  }
  const seenRules = new Set<string>();
  const seenFailures = new Set<string>();
  if (!Array.isArray(matrix.rules)) issues.push("rules must be an array");
  for (const rule of Array.isArray(matrix.rules) ? matrix.rules : []) {
    if (!record(rule) || !safeId(rule.id)) {
      issues.push("rule ID is invalid");
      continue;
    }
    if (seenRules.has(rule.id)) issues.push(`duplicate rule ${rule.id}`);
    seenRules.add(rule.id);
    if (!jobFlowFailureClasses.includes(rule.failureClass as FailureClass)) {
      issues.push(`${rule.id} has an unknown failure class`);
    } else if (seenFailures.has(rule.failureClass)) {
      issues.push(`duplicate failure class ${rule.failureClass}`);
    } else seenFailures.add(rule.failureClass);
    if (!["inspect_popup", "reattach", "reobserve", "replace_job", "resume_checkpoint", "retry_read", "typed_stop"].includes(String(rule.recoveryAction))) {
      issues.push(`${rule.id} has an invalid recovery action`);
    }
    if (!integerIn(rule.retryLimit, 0, 3)) issues.push(`${rule.id} retry limit is invalid`);
    if (!["advance_only", "discard", "preserve"].includes(String(rule.checkpoint))) {
      issues.push(`${rule.id} checkpoint policy is invalid`);
    }
    if (!["posting_unavailable", "resume_or_typed_stop", "typed_stop"].includes(String(rule.expectedTerminal))) {
      issues.push(`${rule.id} terminal policy is invalid`);
    }
    if (!boundedStrings(rule.diagnostics, 1, 8) || !boundedText(rule.workaround, 1, 500)) {
      issues.push(`${rule.id} diagnostics or workaround is invalid`);
    }
    validateTestFiles(rule.testFiles, repositoryRoot, `${rule.id} test`, issues);
  }
  if (seenFailures.size !== jobFlowFailureClasses.length) issues.push("not every failure class has one rule");
  const jobs = Array.isArray(matrix.baselineJobs) ? matrix.baselineJobs : [];
  if (jobs.length !== 3) issues.push("baseline must contain exactly three jobs");
  const companies = new Set<string>();
  for (const job of jobs) validateJob(job, repositoryRoot, companies, issues);
  if (companies.size !== 3) issues.push("baseline companies must be unique");
  if (new Set(jobs.map((job) => record(job) ? job.id : "")).size !== 3) issues.push("baseline job IDs must be unique");
  return issues;
}

export function matrixTestFiles(matrix: JobFlowMatrix): string[] {
  return [...new Set([
    ...matrix.rules.flatMap((rule) => rule.testFiles),
    ...matrix.baselineJobs.flatMap((job) => job.testFiles),
  ])].sort();
}

export function renderJobFlowRules(matrix: JobFlowMatrix): string {
  const lines = [
    "# Company/job-flow testing rules",
    "",
    `Generated from \`fixtures/job-flow-campaign/v1.json\` (${matrix.matrixRevision}).`,
    "Do not edit this file without updating the executable matrix.",
    "",
    "## Safety and repetition",
    "",
    `- ${matrix.repeatRuns} clean deterministic runs are required.`,
    "- Synthetic identities and mocked sensitive steps only.",
    "- Live checks are read-only GET requests to allowlisted official hosts.",
    "- Final external Submit is never activated.",
    "",
    "## Failure and recovery matrix",
    "",
    "| Failure class | Recovery | Retries | Checkpoint | Terminal | Fix rule |",
    "| --- | --- | ---: | --- | --- | --- |",
    ...matrix.rules.map((rule) =>
      `| ${rule.failureClass} | ${rule.recoveryAction} | ${rule.retryLimit} | ${rule.checkpoint} | ${rule.expectedTerminal} | ${escapeCell(rule.workaround)} |`
    ),
    "",
    "## Three-job baseline",
    "",
    "| Company | ATS | State combination | Permitted terminal | Live evidence (not acceptance) |",
    "| --- | --- | --- | --- | --- |",
    ...matrix.baselineJobs.map((job) =>
      `| ${escapeCell(job.company)} | ${job.ats} | ${job.stateCombination} | ${job.terminalState} | read-only title and host match; freshness requires a separate check |`
    ),
    "",
    "## Current fix list",
    "",
    ...matrix.rules.map((rule) =>
      `- \`${rule.id}\`: ${rule.workaround} Evidence: ${rule.testFiles.map((file) => `\`${file}\``).join(", ")}.`
    ),
    "",
  ];
  return lines.join("\n");
}

export async function verifyReadOnlyLiveJob(
  job: BaselineJob,
  policy: JobFlowMatrix["liveValidation"],
  fetcher: FetchLike = fetch,
): Promise<ReadOnlyLiveEvidence> {
  let lastStatus: number | null = null;
  let lastHost: string | null = null;
  for (let attempt = 1; attempt <= policy.retryLimit + 1; attempt += 1) {
    try {
      let target = new URL(job.officialUrl);
      const signal = AbortSignal.timeout(policy.timeoutMs);
      const visited = new Set<string>();
      let response: Awaited<ReturnType<FetchLike>>;
      for (;;) {
        if (!allowedTarget(target, job.allowedHosts) || visited.has(target.href) || visited.size >= 5) {
          return evidence(job, "redirect_denied", attempt, lastStatus, lastHost, false, 0);
        }
        visited.add(target.href);
        response = await fetcher(target.href, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { "user-agent": "Hunt read-only job validation/1.0" },
        });
        lastStatus = response.status;
        lastHost = target.hostname;
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) return evidence(job, "redirect_denied", attempt, lastStatus, lastHost, false, 0);
        target = new URL(location, target);
      }
      lastStatus = response.status;
      if (lastStatus < 200 || lastStatus >= 300) {
        await response.body?.cancel();
        // Respect rate limits: no automatic retry of 429 or Retry-After responses.
        if ((lastStatus === 408 || lastStatus >= 500) && !response.headers.get("retry-after") && attempt <= policy.retryLimit) continue;
        return evidence(job, [404, 410].includes(lastStatus) ? "expired" : "unavailable", attempt, lastStatus, lastHost, false, 0);
      }
      const reader = response.body?.getReader();
      if (!reader) return evidence(job, "unavailable", attempt, lastStatus, lastHost, false, 0);
      const decoder = new TextDecoder();
      let size = 0;
      let html = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > policy.maxBytes) return evidence(job, "unavailable", attempt, lastStatus, lastHost, false, size);
          html += decoder.decode(chunk.value, { stream: true });
        }
        html += decoder.decode();
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const titleMatched = html.toLowerCase().includes(job.titleMarker.toLowerCase());
      const expired = /job (?:is )?no longer available|position has been filled|job posting (?:has )?expired/i.test(html);
      return evidence(job, expired ? "expired" : titleMatched ? "posting_present" : "title_mismatch", attempt, lastStatus, lastHost, titleMatched, size);
    } catch {
      if (attempt > policy.retryLimit) return evidence(job, "unavailable", attempt, lastStatus, lastHost, false, 0);
    }
  }
  return evidence(job, "unavailable", policy.retryLimit + 1, lastStatus, lastHost, false, 0);
}

function allowedTarget(url: URL, hosts: readonly string[]): boolean {
  return url.protocol === "https:" && !url.username && !url.password &&
    (!url.port || url.port === "443") && hosts.includes(url.hostname);
}

function validateJob(job: unknown, root: string, companies: Set<string>, issues: string[]): void {
  if (!record(job) || !safeId(job.id) || !boundedText(job.company, 1, 120)) {
    issues.push("baseline job identity is invalid");
    return;
  }
  companies.add(job.company);
  if (typeof job.syntheticRegion !== "string" || !/^[A-Z]{2,3}$/u.test(job.syntheticRegion) || !boundedText(job.stateCombination, 1, 120)) issues.push(`${job.id} synthetic variant is invalid`);
  if (job.ats !== "workday") issues.push(`${job.id} complete-journey baseline requires the supported Workday ATS`);
  try {
    const url = new URL(job.officialUrl as string);
    if (!Array.isArray(job.allowedHosts) || !allowedTarget(url, job.allowedHosts)) issues.push(`${job.id} URL must use allowlisted credential-free HTTPS`);
  } catch {
    issues.push(`${job.id} URL is invalid`);
  }
  if (!boundedStrings(job.allowedHosts, 1, 4) || !boundedText(job.titleMarker, 1, 200) || !boundedStrings(job.permittedJourney, 2, 12)) {
    issues.push(`${job.id} live or journey evidence is invalid`);
  }
  if (!Array.isArray(job.allowedHosts) || job.allowedHosts.some((host: unknown) => typeof host !== "string" || !/^[a-z0-9-]+\.wd[0-9]+\.myworkdayjobs\.com$/u.test(host))) {
    issues.push(`${job.id} hosts must be official Workday tenant hosts`);
  }
  const states = Array.isArray(job.permittedJourney) ? job.permittedJourney : [];
  if (states[0] !== "posting" || states.at(-1) !== job.terminalState) issues.push(`${job.id} journey boundary is invalid`);
  if (job.terminalState !== "review" || !states.includes("profile") || !states.includes("questionnaire") || new Set(states).size !== states.length || states.some((state: unknown) => !["posting", "account_entry", "verification_required", "profile", "resume", "questionnaire", "review"].includes(String(state)))) {
    issues.push(`${job.id} complete-journey baseline must reach Review through known unique states`);
  }
  validateTestFiles(job.testFiles, root, `${job.id} test`, issues);
}

function validateTestFiles(value: unknown, root: string, name: string, issues: string[]): void {
  if (!boundedStrings(value, 1, 8)) {
    issues.push(`${name} files are invalid`);
    return;
  }
  for (const file of value) {
    const path = resolve(root, file);
    if (isAbsolute(file) || relative(root, path).startsWith(`..${sep}`) || !file.endsWith(".test.ts") || !existsSync(path)) {
      issues.push(`${name} file is unsafe or missing: ${file}`);
    }
  }
}

function evidence(job: BaselineJob, outcome: ReadOnlyLiveEvidence["outcome"], attempts: number, status: number | null, finalHost: string | null, titleMatched: boolean, bytes: number): ReadOnlyLiveEvidence {
  return Object.freeze({ jobId: job.id, company: job.company, ats: job.ats, outcome, attempts, status, finalHost, titleMatched, bytes });
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{2,79}$/u.test(value);
}

function integerIn(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function boundedText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function boundedStrings(value: unknown, minimum: number, maximum: number): value is string[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum && value.every((item) => boundedText(item, 1, 500));
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
