import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { mcpMethods } from "../../control/mcp/facade.ts";
import { serializedSchemas } from "../../contracts/serialized.ts";
import { s2CommonWireSchemas } from "../../contracts/s2-common-schemas.ts";
import { scanPrivacyFiles, type FilePrivacyViolation } from "../../testing/contracts/privacy.ts";
import { findLivePrivacyViolations } from "../../testing/live/privacy.ts";
import { verifyAcceptanceReport } from "../acceptance/index.ts";
import { verifyFrozenBundle, type CurrentFreezeIdentity } from "../freeze/index.ts";

export interface LargeModuleDisposition {
  readonly path: string;
  readonly lines: number;
  readonly disposition: string;
  readonly regressionImpact: string;
}

export interface CorpusAuditReport {
  readonly schemaVersion: 1;
  readonly status: "passed" | "failed";
  readonly privacyViolations: readonly FilePrivacyViolation[];
  readonly exposedCapabilities: readonly string[];
  readonly largeModules: readonly LargeModuleDisposition[];
  readonly blockingIssues: readonly string[];
  readonly schemaIssues: readonly string[];
  readonly artifactIssues?: readonly string[];
}

export interface IssueDisposition {
  readonly id: string;
  readonly severity: "P0" | "P1" | "P2" | "P3";
  readonly disposition: string;
  readonly regressionImpact: string;
}

interface DispositionFile {
  readonly schemaVersion: 1;
  readonly modules: Readonly<Record<string, {
    readonly disposition: string;
    readonly regressionImpact: string;
  }>>;
}

export async function runStaticCorpusAudit(executionerRoot: string): Promise<CorpusAuditReport> {
  const privacyViolations = scanPrivacyFiles(executionerRoot);
  const exposedCapabilities = [...mcpMethods].sort();
  const dispositions = JSON.parse(
    await readFile(join(executionerRoot, "docs", "module-size-dispositions.json"), "utf8"),
  ) as DispositionFile;
  const issueFile = JSON.parse(
    await readFile(join(executionerRoot, "docs", "corpus-issue-dispositions.json"), "utf8"),
  ) as { readonly schemaVersion: number; readonly issues: readonly IssueDisposition[] };
  const largeModules: LargeModuleDisposition[] = [];
  const blockingIssues: string[] = [];
  const schemaIssues = [
    ...auditClosedSchema("event_v2", serializedSchemas.eventEnvelope),
    ...auditClosedSchema("event_v3", s2CommonWireSchemas.eventEnvelope),
    ...auditClosedSchema("evidence_v2", serializedSchemas.evidenceManifest),
  ].sort();

  if (dispositions.schemaVersion !== 1 || dispositions.modules === undefined) {
    blockingIssues.push("module_size_dispositions_invalid");
  }
  if (issueFile.schemaVersion !== 1 || !Array.isArray(issueFile.issues)) {
    blockingIssues.push("issue_dispositions_invalid");
  } else {
    blockingIssues.push(...validateIssueDispositions(issueFile.issues));
  }
  for (const path of await sourceFiles(join(executionerRoot, "src"))) {
    const lines = (await readFile(path, "utf8")).split(/\r?\n/u).length;
    if (lines < 450) continue;
    const normalized = relative(executionerRoot, path).replaceAll("\\", "/");
    const disposition = dispositions.modules[normalized];
    if (
      disposition === undefined ||
      disposition.disposition.trim() === "" ||
      disposition.regressionImpact.trim() === ""
    ) {
      blockingIssues.push(`module_size_disposition_missing:${normalized}`);
      continue;
    }
    largeModules.push({ path: normalized, lines, ...disposition });
  }
  if (privacyViolations.length > 0) blockingIssues.push("privacy_violation");
  blockingIssues.push(...schemaIssues);
  if (exposedCapabilities.some((capability) => capability.includes("submit"))) {
    blockingIssues.push("submit_capability_exposed");
  }

  return Object.freeze({
    schemaVersion: 1,
    status: blockingIssues.length === 0 ? "passed" : "failed",
    privacyViolations: Object.freeze(privacyViolations),
    exposedCapabilities: Object.freeze(exposedCapabilities),
    largeModules: Object.freeze(largeModules.sort((left, right) => left.path.localeCompare(right.path))),
    schemaIssues: Object.freeze(schemaIssues),
    blockingIssues: Object.freeze(blockingIssues.sort()),
  });
}

function auditClosedSchema(name: string, schema: unknown): readonly string[] {
  if (schema === null || Array.isArray(schema) || typeof schema !== "object") {
    return [`schema_invalid:${name}`];
  }
  const root = schema as Record<string, unknown>;
  const issues: string[] = [];
  if (root.additionalProperties !== false) issues.push(`schema_open:${name}`);
  visit(root, name);
  return issues;

  function visit(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (object.properties !== null && typeof object.properties === "object" && !Array.isArray(object.properties)) {
      for (const key of Object.keys(object.properties as Record<string, unknown>)) {
        if (/password|credential|token|raw|body|cookie|submit/iu.test(key)) {
          issues.push(`schema_private_key:${path}.${key}`);
        }
      }
    }
    for (const [key, child] of Object.entries(object)) visit(child, `${path}.${key}`);
  }
}

export async function runCorpusAudit(
  executionerRoot: string,
  bundlePath: string,
  current: CurrentFreezeIdentity,
): Promise<CorpusAuditReport> {
  const base = await runStaticCorpusAudit(executionerRoot);
  const artifactIssues = await auditAcceptanceArtifacts(bundlePath, current);
  const blockingIssues = [...base.blockingIssues, ...artifactIssues].sort();
  return Object.freeze({
    ...base,
    status: blockingIssues.length === 0 ? "passed" : "failed",
    artifactIssues: Object.freeze(artifactIssues),
    blockingIssues: Object.freeze(blockingIssues),
  });
}

export async function auditAcceptanceArtifacts(
  bundlePath: string,
  current: CurrentFreezeIdentity,
): Promise<readonly string[]> {
  const issues: string[] = [];
  try {
    const bundle = await verifyFrozenBundle(bundlePath, current);
    const root = dirname(resolve(bundlePath));
    const paths = [resolve(bundlePath), resolve(root, "ledger.json"), resolve(root, "report.json")];
    for (const path of paths) {
      if ((await stat(path)).size > 1024 * 1024) issues.push("acceptance_artifact_too_large");
    }
    const ledger = JSON.parse(await readFile(paths[1]!, "utf8")) as Record<string, unknown>;
    const report = JSON.parse(await readFile(paths[2]!, "utf8")) as Record<string, unknown>;
    issues.push(...verifyAcceptanceReport(report));
    for (const [name, value] of [["bundle", bundle], ["ledger", ledger], ["report", report]] as const) {
      for (const violation of findLivePrivacyViolations(value)) {
        issues.push(`${name}_privacy:${violation}`);
      }
    }
    if (
      ledger.schemaVersion !== 1 ||
      ledger.bundleIdentity !== bundle.identity ||
      report.bundleIdentity !== bundle.identity ||
      report.runId !== bundle.runId ||
      report.mode !== bundle.mode ||
      (report.status !== "accepted" && report.status !== "accepted_fixture") ||
      !Array.isArray(ledger.entries) ||
      !Array.isArray(report.entries) ||
      stable(ledger.entries) !== stable(report.entries)
    ) issues.push("acceptance_artifact_reconciliation_invalid");
    if (
      Array.isArray(report.entries) &&
      report.entries.some((entry) =>
        entry === null ||
        typeof entry !== "object" ||
        !("attempts" in entry) ||
        typeof entry.attempts !== "number" ||
        entry.attempts > bundle.maxAttemptsPerSlot
      )
    ) issues.push("acceptance_recovery_bound_invalid");
  } catch {
    issues.push("acceptance_artifact_unavailable");
  }
  return [...new Set(issues)].sort();
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateIssueDispositions(issues: readonly IssueDisposition[]): readonly string[] {
  const blockers: string[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/u.test(issue.id) || seen.has(issue.id)) {
      blockers.push("issue_disposition_invalid");
      continue;
    }
    seen.add(issue.id);
    if (!["P0", "P1", "P2", "P3"].includes(issue.severity)) {
      blockers.push(`issue_severity_invalid:${issue.id}`);
    } else if (issue.severity === "P0" || issue.severity === "P1") {
      blockers.push(`blocking_issue:${issue.id}`);
    } else if (
      issue.severity === "P2" &&
      (issue.disposition.trim() === "" || issue.regressionImpact.trim() === "")
    ) {
      blockers.push(`p2_disposition_missing:${issue.id}`);
    }
  }
  return blockers.sort();
}

async function sourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}
