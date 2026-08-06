import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

import {
  compileAuthenticatedCatalogRun,
  createAuthenticatedCatalogRun,
  recordAuthenticatedCatalogResult,
} from "./authenticated-catalog-store.ts";
import {
  createAuthenticatedCatalogPlan,
  type AuthenticatedCatalogResultV1,
} from "./authenticated-catalog.ts";

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const PINNED_HISTORY = /^[a-f0-9]{40}:wd_test_jobs\.csv$/u;

interface PrepareDependencies {
  readonly now: () => Date;
  readonly randomHex: () => string;
}

const prepareDefaults: PrepareDependencies = {
  now: () => new Date(),
  randomHex: () => randomBytes(16).toString("hex"),
};

export function prepareAuthenticatedCatalogFromArgs(
  args: readonly string[],
  dependencies: PrepareDependencies = prepareDefaults,
): {
  readonly status: "prepared";
  readonly runId: string;
  readonly runRoot: string;
  readonly jobs: number;
  readonly shards: number;
  readonly firstCatalogRow: number | null;
  readonly lastCatalogRow: number | null;
} {
  try {
    const parsed = pairs(args, new Set([
      "--catalog", "--history-csv", "--history-ref", "--repo-root", "--output-root", "--shards",
    ]));
    const catalogPath = required(parsed, "--catalog");
    const outputRoot = required(parsed, "--output-root");
    const shardText = required(parsed, "--shards");
    const shardCount = Number(shardText);
    const historyCsvPath = parsed.get("--history-csv");
    const historyRef = parsed.get("--history-ref");
    const repoRoot = parsed.get("--repo-root");
    if (!canonicalAbsolute(catalogPath) || !canonicalAbsolute(outputRoot) ||
        !Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 5 ||
        (historyCsvPath === undefined) === (historyRef === undefined) ||
        (historyCsvPath !== undefined && (repoRoot !== undefined || !canonicalAbsolute(historyCsvPath))) ||
        (historyRef !== undefined && (repoRoot === undefined || !PINNED_HISTORY.test(historyRef) ||
          !canonicalAbsolute(repoRoot)))) denied("catalog preparation denied");
    const catalogCsv = readBoundedFile(catalogPath, MAX_CSV_BYTES);
    const historyCsv = historyCsvPath !== undefined
      ? readBoundedFile(historyCsvPath, MAX_CSV_BYTES)
      : readPinnedHistory(repoRoot!, historyRef!);
    const randomHex = dependencies.randomHex();
    const createdAt = dependencies.now().toISOString();
    if (!/^[a-f0-9]{32}$/u.test(randomHex)) denied("catalog preparation denied");
    const plan = createAuthenticatedCatalogPlan({
      catalogCsv,
      historyCsv,
      runId: `authrun_${randomHex}`,
      createdAt,
      shardCount,
    });
    const created = createAuthenticatedCatalogRun({ outputRoot, plan });
    return Object.freeze({
      status: "prepared",
      runId: plan.runId,
      runRoot: created.runRoot,
      jobs: plan.jobs.length,
      shards: plan.shardCount,
      firstCatalogRow: plan.jobs[0]?.catalogRow ?? null,
      lastCatalogRow: plan.jobs.at(-1)?.catalogRow ?? null,
    });
  } catch (error) {
    if (error instanceof Error && ["run already exists", "run creation failed"].includes(error.message)) throw error;
    denied("catalog preparation denied");
  }
}

export function recordAuthenticatedCatalogResultFromArgs(args: readonly string[]): {
  readonly status: "recorded";
  readonly jobId: string;
  readonly resultPath: string;
} {
  let parsed: Map<string, string>;
  try {
    parsed = pairs(args, new Set(["--run-root", "--result"]));
    if (parsed.size !== 2) denied("result recording denied");
    const runRoot = required(parsed, "--run-root");
    const resultFile = required(parsed, "--result");
    if (!canonicalAbsolute(runRoot) || !canonicalAbsolute(resultFile)) denied("result recording denied");
    const result = JSON.parse(readBoundedFile(resultFile, MAX_RESULT_BYTES)) as AuthenticatedCatalogResultV1;
    const resultPath = recordAuthenticatedCatalogResult({ runRoot, result });
    return Object.freeze({ status: "recorded", jobId: result.jobId, resultPath });
  } catch (error) {
    if (error instanceof Error && ["result invalid", "result already exists", "run unavailable"].includes(error.message)) {
      throw error;
    }
    denied("result recording denied");
  }
}

export function compileAuthenticatedCatalogFromArgs(args: readonly string[]): ReturnType<
  typeof compileAuthenticatedCatalogRun
> {
  let parsed: Map<string, string>;
  try {
    parsed = pairs(args, new Set(["--run-root"]));
    if (parsed.size !== 1) denied("result compilation denied");
    const runRoot = required(parsed, "--run-root");
    if (!canonicalAbsolute(runRoot)) denied("result compilation denied");
    return compileAuthenticatedCatalogRun(runRoot);
  } catch (error) {
    if (error instanceof Error && [
      "results incomplete", "results invalid", "results already compiled", "run unavailable",
    ].includes(error.message)) throw error;
    denied("result compilation denied");
  }
}

function pairs(args: readonly string[], allowed: ReadonlySet<string>): Map<string, string> {
  if (args.length === 0 || args.length % 2 !== 0) denied("arguments denied");
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || value === undefined || !allowed.has(name) || parsed.has(name) || value === "") {
      denied("arguments denied");
    }
    parsed.set(name, value);
  }
  return parsed;
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) denied("arguments denied");
  return value;
}

function readPinnedHistory(repoRootValue: string, ref: string): string {
  const repoRoot = admittedDirectory(repoRootValue);
  try {
    const value = execFileSync("git", ["show", ref], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: MAX_CSV_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    if (Buffer.byteLength(value, "utf8") > MAX_CSV_BYTES) denied("catalog preparation denied");
    return value;
  } catch {
    denied("catalog preparation denied");
  }
}

function readBoundedFile(path: string, maximum: number): string {
  try {
    if (!canonicalAbsolute(path)) denied("file unavailable");
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > maximum ||
        comparable(realpathSync.native(path)) !== comparable(resolve(path))) denied("file unavailable");
    return readFileSync(path, "utf8");
  } catch {
    denied("file unavailable");
  }
}

function admittedDirectory(path: string): string {
  try {
    if (!canonicalAbsolute(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory() ||
        comparable(realpathSync.native(path)) !== comparable(resolve(path))) denied("directory unavailable");
    return realpathSync.native(path);
  } catch {
    denied("directory unavailable");
  }
}

function canonicalAbsolute(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value;
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(message: string): never {
  throw new Error(message);
}
