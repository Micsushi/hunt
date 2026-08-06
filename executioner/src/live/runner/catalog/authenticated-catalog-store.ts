import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

import {
  compileAuthenticatedCatalogResults,
  serializeAuthenticatedCatalogJobs,
  validateAuthenticatedCatalogPlan,
  validateAuthenticatedCatalogResult,
  type AuthenticatedCatalogPlanV1,
  type AuthenticatedCatalogResultV1,
  type CompiledAuthenticatedCatalogResults,
} from "./authenticated-catalog.ts";

const MANIFEST_FILE = "manifest.json";
const JOBS_FILE = "jobs.csv";
const RESULTS_DIRECTORY = "results";
const RESULTS_FILE = "results.csv";
const SUMMARY_FILE = "summary.json";
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export interface CreatedAuthenticatedCatalogRun {
  readonly runRoot: string;
  readonly manifestPath: string;
  readonly jobsPath: string;
  readonly shardPaths: readonly string[];
  readonly resultsRoot: string;
}

export interface CompiledAuthenticatedCatalogRun extends CompiledAuthenticatedCatalogResults {
  readonly resultsPath: string;
  readonly summaryPath: string;
}

export function createAuthenticatedCatalogRun(input: {
  readonly outputRoot: string;
  readonly plan: AuthenticatedCatalogPlanV1;
}): CreatedAuthenticatedCatalogRun {
  validateAuthenticatedCatalogPlan(input.plan);
  const outputRoot = admittedDirectory(input.outputRoot, "output root invalid");
  const runRoot = join(outputRoot, input.plan.runId);
  if (existsSync(runRoot)) throw new Error("run already exists");

  let created = false;
  try {
    mkdirSync(runRoot, { mode: 0o700 });
    created = true;
    const resultsRoot = join(runRoot, RESULTS_DIRECTORY);
    mkdirSync(resultsRoot, { mode: 0o700 });
    const manifestPath = join(runRoot, MANIFEST_FILE);
    const jobsPath = join(runRoot, JOBS_FILE);
    writeExclusive(manifestPath, json(input.plan));
    writeExclusive(jobsPath, serializeAuthenticatedCatalogJobs(input.plan));
    const shardPaths = Array.from({ length: input.plan.shardCount }, (_, index) => {
      const shard = index + 1;
      const path = join(runRoot, `shard-${shard}.csv`);
      writeExclusive(path, serializeAuthenticatedCatalogJobs(
        input.plan,
        input.plan.jobs.filter((job) => job.shard === shard),
      ));
      return path;
    });
    return Object.freeze({
      runRoot,
      manifestPath,
      jobsPath,
      shardPaths: Object.freeze(shardPaths),
      resultsRoot,
    });
  } catch (error) {
    if (created) rmSync(runRoot, { recursive: true, force: true });
    if (error instanceof Error && error.message === "run already exists") throw error;
    throw new Error("run creation failed");
  }
}

export function recordAuthenticatedCatalogResult(input: {
  readonly runRoot: string;
  readonly result: AuthenticatedCatalogResultV1;
}): string {
  const runRoot = admittedDirectory(input.runRoot, "run unavailable");
  const plan = readPlan(runRoot);
  if (basename(runRoot) !== plan.runId) throw new Error("run unavailable");
  const result = validateAuthenticatedCatalogResult(input.result, plan);
  const resultsRoot = admittedDirectory(join(runRoot, RESULTS_DIRECTORY), "run unavailable");
  const target = join(resultsRoot, `${result.jobId}.json`);
  if (existsSync(target)) throw new Error("result already exists");
  try {
    writeExclusive(target, json(result));
  } catch (error) {
    if (existsSync(target)) throw new Error("result already exists");
    throw error;
  }
  return target;
}

export function compileAuthenticatedCatalogRun(runRootValue: string): CompiledAuthenticatedCatalogRun {
  const runRoot = admittedDirectory(runRootValue, "run unavailable");
  const plan = readPlan(runRoot);
  if (basename(runRoot) !== plan.runId) throw new Error("run unavailable");
  const resultsPath = join(runRoot, RESULTS_FILE);
  const summaryPath = join(runRoot, SUMMARY_FILE);
  if (existsSync(resultsPath) || existsSync(summaryPath)) throw new Error("results already compiled");

  const lockPath = join(runRoot, ".compile.lock");
  let lock: number | undefined;
  let ownsLock = false;
  let wroteResults = false;
  let wroteSummary = false;
  try {
    lock = openSync(lockPath, "wx", 0o600);
    ownsLock = true;
    closeSync(lock);
    lock = undefined;
    const resultsRoot = admittedDirectory(join(runRoot, RESULTS_DIRECTORY), "run unavailable");
    const expectedNames = new Set(plan.jobs.map((job) => `${job.jobId}.json`));
    const actualNames = readdirSync(resultsRoot);
    if (actualNames.some((name) => !expectedNames.has(name))) throw new Error("results invalid");
    if (actualNames.length !== expectedNames.size ||
        [...expectedNames].some((name) => !actualNames.includes(name))) {
      throw new Error("results incomplete");
    }
    const values = plan.jobs.map((job) => readResult(resultsRoot, `${job.jobId}.json`, plan));
    const compiled = compileAuthenticatedCatalogResults(plan, values);
    writeExclusive(resultsPath, compiled.csv);
    wroteResults = true;
    writeExclusive(summaryPath, json(compiled.summary));
    wroteSummary = true;
    return Object.freeze({ ...compiled, resultsPath, summaryPath });
  } catch (error) {
    if (wroteResults && !wroteSummary) rmSync(resultsPath, { force: true });
    throw error;
  } finally {
    if (lock !== undefined) closeSync(lock);
    if (ownsLock && existsSync(lockPath)) rmSync(lockPath, { force: true });
  }
}

function readPlan(runRoot: string): AuthenticatedCatalogPlanV1 {
  const value: unknown = readJson(join(runRoot, MANIFEST_FILE));
  validateAuthenticatedCatalogPlan(value);
  return value;
}

function readResult(
  resultsRoot: string,
  fileName: string,
  plan: AuthenticatedCatalogPlanV1,
): AuthenticatedCatalogResultV1 {
  const value = readJson(join(resultsRoot, fileName)) as AuthenticatedCatalogResultV1;
  return validateAuthenticatedCatalogResult(value, plan);
}

function readJson(path: string): unknown {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size < 2 || info.size > MAX_JSON_BYTES) {
      throw new Error("invalid file");
    }
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("run unavailable");
  }
}

function admittedDirectory(value: string, message: string): string {
  try {
    if (!isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
        !statSync(value).isDirectory() || comparable(realpathSync.native(value)) !== comparable(resolve(value))) {
      throw new Error(message);
    }
    return realpathSync.native(value);
  } catch {
    throw new Error(message);
  }
}

function writeExclusive(path: string, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } finally {
    bytes.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
