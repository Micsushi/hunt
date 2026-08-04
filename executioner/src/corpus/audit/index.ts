import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { mcpMethods } from "../../control/mcp/facade.ts";
import { scanPrivacyFiles, type FilePrivacyViolation } from "../../testing/contracts/privacy.ts";

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
}

interface DispositionFile {
  readonly schemaVersion: 1;
  readonly modules: Readonly<Record<string, {
    readonly disposition: string;
    readonly regressionImpact: string;
  }>>;
}

export async function runCorpusAudit(executionerRoot: string): Promise<CorpusAuditReport> {
  const privacyViolations = scanPrivacyFiles(executionerRoot);
  const exposedCapabilities = [...mcpMethods].sort();
  const dispositions = JSON.parse(
    await readFile(join(executionerRoot, "docs", "module-size-dispositions.json"), "utf8"),
  ) as DispositionFile;
  const largeModules: LargeModuleDisposition[] = [];
  const blockingIssues: string[] = [];

  if (dispositions.schemaVersion !== 1 || dispositions.modules === undefined) {
    blockingIssues.push("module_size_dispositions_invalid");
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
  if (exposedCapabilities.some((capability) => capability.includes("submit"))) {
    blockingIssues.push("submit_capability_exposed");
  }

  return Object.freeze({
    schemaVersion: 1,
    status: blockingIssues.length === 0 ? "passed" : "failed",
    privacyViolations: Object.freeze(privacyViolations),
    exposedCapabilities: Object.freeze(exposedCapabilities),
    largeModules: Object.freeze(largeModules.sort((left, right) => left.path.localeCompare(right.path))),
    blockingIssues: Object.freeze(blockingIssues.sort()),
  });
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
