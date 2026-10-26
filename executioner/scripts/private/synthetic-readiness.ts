import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { chromium } from "playwright";

import type { FixtureRunId } from "../../src/contracts/index.ts";
import { FixtureServer } from "../../src/testing/fixture-server.ts";
import {
  STAGE2_NODE_VERSION,
  STAGE2_NPM_VERSION,
} from "../../src/live/preflight/runtime-readiness.ts";
import {
  runWindowsIsolatedStage2Acceptance,
} from "../../src/live/runner/windows-isolated-process.ts";

const RUN_COUNT = 2;
const MAX_MONITOR_BODY_BYTES = 4_096;
const WATCHDOG_STALE_MS = 5_000;
const RUN_TIMEOUT_MS = 90_000;
const ACCEPTED_READINESS_BASE = "3f2e590332fe41acd0141562cdc9e290401feb5e";
const REJECTED_OBSERVABILITY_COMMITS = Object.freeze([
  "54377869d2dcb230afef6b8153d2c3001ac179ee",
  "ce9ae72b81e0b1df636960ed5fdfe9594b1157ba",
  "61bc3fc9166f4ae838715bf5fe1da402461a2970",
  "971d6567cb6d93dfaf4ed546b070a7803c3e6f6f",
  "e97b526b03f873d9f2bf6cd0ae3693f423faf013",
  "1ff9ddd6cc894e5451c05ba45e5b6ef65fd8088f",
  "da067f47c85202ec3253204f2d45de467698c747",
  "8f87ac64418ac9fbe0f60f256cb8b71d1e392166",
]);

export type Stage2ReadinessFailureClass =
  | "setup"
  | "child_spawn"
  | "browser_launch"
  | "page_binding"
  | "evidence"
  | "monitor"
  | "cleanup";

export interface Stage2SyntheticReadinessOptions {
  readonly storageRoot: string;
  readonly nodeExecutable: string;
  readonly npmCliPath: string;
  readonly pagePort: number;
  readonly monitorPort: number;
  readonly childPath?: string;
  readonly fixtureRoot?: string;
  readonly now?: () => string;
}

export interface Stage2ReadinessRunResult {
  readonly runOrdinal: number;
  readonly status: "pass" | "failed";
  readonly failureClass?: Stage2ReadinessFailureClass;
  readonly childPid?: number;
  readonly monitorRecords: number;
  readonly watchdogChecks: number;
  readonly processCleanup: "pass" | "failed";
  readonly portCleanup: "pass" | "failed";
  readonly profileCleanup: "pass" | "failed";
  readonly timingsMs: {
    readonly setup: number;
    readonly productionFlow: number;
    readonly cleanup: number;
    readonly total: number;
    readonly monotonicClock: "performance_now";
  };
  readonly submitActivated: false;
  readonly evidenceSha256?: string;
  readonly logFile: string;
}

export interface Stage2ReadinessCertificateV1 {
  readonly schemaVersion: 1;
  readonly certificateRevision: "c3-synthetic-readiness-v1";
  readonly status: "pass" | "failed";
  readonly failureClass?: Stage2ReadinessFailureClass;
  readonly sourceRevision: string;
  readonly runtimeKeySha256: string;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly playwrightLockSha256: string;
  readonly browserExecutableSha256: string;
  readonly pagePort: number;
  readonly monitorPort: number;
  readonly observerReadyBeforeRunRoot: boolean;
  readonly freshRunRoots: true;
  readonly consecutiveRuns: readonly Stage2ReadinessRunResult[];
  readonly submitActivated: false;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface RuntimeIdentity {
  readonly sourceRevision: string;
  readonly runtimeKeySha256: string;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly playwrightLockSha256: string;
  readonly browserExecutableSha256: string;
}

interface MonitorRecord {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly phase: "child_spawn" | "browser_launch" | "page_binding" | "monitor" | "evidence" | "cleanup";
  readonly status: "started" | "pass" | "failed";
  readonly pid: number;
  readonly submitActivated: false;
  readonly failureClass?: Stage2ReadinessFailureClass;
  readonly evidenceSha256?: string;
}

interface LogRecord {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly runOrdinal: number;
  readonly phase: "setup" | "child_spawn" | "browser_launch" | "page_binding" | "evidence" | "monitor" | "cleanup";
  readonly step: string;
  readonly status: "started" | "pass" | "failed";
  readonly observedAt: string;
  readonly submitActivated: false;
  readonly failureClass?: Stage2ReadinessFailureClass;
  readonly ownerPid?: number;
  readonly evidenceSha256?: string;
}

export async function runStage2SyntheticReadiness(
  optionsValue: Stage2SyntheticReadinessOptions,
): Promise<{ readonly certificatePath: string; readonly certificate: Stage2ReadinessCertificateV1 }> {
  const options = validateOptions(optionsValue);
  const now = options.now ?? (() => new Date().toISOString());
  const identity = runtimeIdentity(options);
  const batchId = `readiness_${timestampKey(now())}_${randomBytes(6).toString("hex")}`;
  const retainedRoot = join(options.storageRoot, "retained", batchId);
  const runs: Stage2ReadinessRunResult[] = [];
  let observerReadyBeforeRunRoot = true;

  for (let runOrdinal = 1; runOrdinal <= RUN_COUNT; runOrdinal += 1) {
    const result = await runOnce({
      ...options,
      runOrdinal,
      retainedRoot,
      sourceRevision: identity.sourceRevision,
      now,
    });
    runs.push(result);
    observerReadyBeforeRunRoot &&= result.monitorRecords >= 8;
    if (result.status !== "pass") break;
  }

  mkdirSync(retainedRoot, { recursive: true, mode: 0o700 });
  const status = runs.length === RUN_COUNT && runs.every((run) => run.status === "pass")
    ? "pass" as const
    : "failed" as const;
  const issuedAt = canonicalTimestamp(now());
  const certificate: Stage2ReadinessCertificateV1 = Object.freeze({
    schemaVersion: 1,
    certificateRevision: "c3-synthetic-readiness-v1",
    status,
    ...(status === "failed"
      ? { failureClass: runs.find((run) => run.status === "failed")?.failureClass ?? "setup" }
      : {}),
    ...identity,
    pagePort: options.pagePort,
    monitorPort: options.monitorPort,
    observerReadyBeforeRunRoot,
    freshRunRoots: true,
    consecutiveRuns: Object.freeze([...runs]),
    submitActivated: false,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 24 * 60 * 60 * 1_000).toISOString(),
  });
  const certificatePath = join(retainedRoot, "readiness-certificate.json");
  writeExclusiveJson(certificatePath, certificate);
  return Object.freeze({ certificatePath, certificate });
}

export function readStage2ReadinessCertificate(
  certificatePath: string,
  expectedRuntimeKeySha256: string,
): Stage2ReadinessCertificateV1 {
  const path = admittedFile(certificatePath, 256 * 1024);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isCertificate(value) || value.runtimeKeySha256 !== expectedRuntimeKeySha256 ||
      Date.now() >= Date.parse(value.expiresAt)) denied();
  return deepFreeze(value);
}

export function stage2ReadinessRuntimeIdentity(
  optionsValue: Pick<Stage2SyntheticReadinessOptions, "nodeExecutable" | "npmCliPath">,
): RuntimeIdentity {
  return runtimeIdentity(optionsValue);
}

async function runOnce(options: Stage2SyntheticReadinessOptions & {
  readonly runOrdinal: number;
  readonly retainedRoot: string;
  readonly sourceRevision: string;
  readonly now: () => string;
}): Promise<Stage2ReadinessRunResult> {
  const runStarted = performance.now();
  let setupDurationMs = 0;
  let productionFlowDurationMs = 0;
  let cleanupDurationMs = 0;
  const runId = `run_${new Date().toISOString().slice(0, 10).replace(/-/gu, "")}_${randomBytes(8).toString("hex")}`;
  const runRoot = join(options.storageRoot, "transient", runId);
  const evidenceRoot = join(options.storageRoot, "retained", runId, "evidence");
  const journeyId = "journey_readiness_synthetic_01";
  const targetHandleId = "target_ref_readiness_synthetic_01";
  const runtimeRoot = join(runRoot, "runtime");
  const profileRoot = join(runtimeRoot, "browser-profiles", journeyId, targetHandleId);
  const configPath = join(runRoot, "owner-input.json");
  const logFile = `${runId}.ndjson`;
  const early: Omit<LogRecord, "sequence">[] = [];
  let logger: ((record: Omit<LogRecord, "sequence">) => void) | undefined;
  let fixture: FixtureServer | undefined;
  let monitor: ReadinessMonitor | undefined;
  let runRootCreated = false;
  let spawnAttempted = false;
  let childPid: number | undefined;
  let failureClass: Stage2ReadinessFailureClass | undefined;
  let evidenceSha256: string | undefined;
  let processCleanup: "pass" | "failed" = "failed";
  let portCleanup: "pass" | "failed" = "failed";
  let profileCleanup: "pass" | "failed" = "failed";
  const controller = new AbortController();
  const log = (record: Omit<LogRecord, "sequence">) => {
    if (logger === undefined) early.push(record);
    else logger(record);
  };

  try {
    log(entry(options, "setup", "runtime_ready", "pass"));
    const fixtureRoot = options.fixtureRoot ?? resolve(
      import.meta.dirname, "..", "..", "fixtures", "workday", "s1",
    );
    fixture = new FixtureServer(fixtureRoot, {
      bind: (server, ready) => server.listen(options.pagePort, "127.0.0.1", ready),
    });
    const started = await fixture.start({ fixtureRunId: runId as FixtureRunId }, controller.signal);
    if (!started.ok) throw classified("setup");

    const token = randomBytes(32).toString("base64url");
    monitor = new ReadinessMonitor(options.monitorPort, token, (record) => {
      childPid = record.pid;
      evidenceSha256 = record.evidenceSha256 ?? evidenceSha256;
      log(entry(
        options,
        record.phase,
        record.status === "failed" ? `${record.phase}_failed` : `${record.phase}_${record.status}`,
        record.status,
        record.failureClass,
        record.pid,
        record.evidenceSha256,
      ));
      if (record.failureClass !== undefined) failureClass = record.failureClass;
    });
    await monitor.start();
    log(entry(options, "monitor", "observer_ready", "pass"));

    if (existsSync(runRoot)) throw classified("setup");
    mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
    runRootCreated = true;
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, `${JSON.stringify({
      journeyId,
      target: {
        handleId: targetHandleId,
        host: "readiness.wd5.myworkdayjobs.com",
        tenant: "readiness",
        posting: "R-READY-01",
      },
      roots: { runtime: { path: runtimeRoot } },
    })}\n`, { flag: "wx", mode: 0o600 });
    const logPath = join(evidenceRoot, logFile);
    writeFileSync(logPath, "", { flag: "wx", mode: 0o600 });
    let sequence = 0;
    logger = (record) => appendFileSync(
      logPath,
      `${JSON.stringify({ ...record, sequence: ++sequence })}\n`,
      { encoding: "utf8" },
    );
    for (const record of early) logger(record);
    early.length = 0;
    log(entry(options, "setup", "run_root_created", "pass"));

    log(entry(options, "child_spawn", "isolated_child_start", "started"));
    setupDurationMs = readinessDuration(runStarted);
    const productionStarted = performance.now();
    const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
    const watchdog = setInterval(() => {
      if (monitor?.stale(WATCHDOG_STALE_MS)) {
        failureClass = "monitor";
        controller.abort();
      }
    }, 250);
    try {
      spawnAttempted = true;
      const code = await runWindowsIsolatedStage2Acceptance([
        "--profile-root", profileRoot,
        "--page-url", `${started.value.origin}/review`,
        "--monitor-origin", `http://127.0.0.1:${options.monitorPort}`,
        "--token", token,
        "--evidence-root", evidenceRoot,
        "--runtime-root", runtimeRoot,
        "--config", configPath,
        "--source-revision", options.sourceRevision,
      ], {
        executable: options.nodeExecutable,
        runnerPath: options.childPath ?? resolve(
          import.meta.dirname, "..", "run-s2-readiness-child.ts",
        ),
        signal: controller.signal,
      });
      if (code !== 0) failureClass ??= classifyStage2ReadinessExit(code, monitor.records);
    } catch {
      failureClass ??= monitor.records === 0 ? "child_spawn" : "cleanup";
    } finally {
      productionFlowDurationMs = readinessDuration(productionStarted);
      clearInterval(watchdog);
      clearTimeout(timeout);
    }

    childPid = monitor.childPid;
    if (failureClass === undefined && !monitor.complete) failureClass = monitor.records === 0
      ? "child_spawn"
      : "monitor";
    try {
      const audit = JSON.parse(readFileSync(join(evidenceRoot, "process-audit.json"), "utf8")) as {
        readonly status?: unknown;
        readonly jobCloseApplied?: unknown;
        readonly membersAliveAfterClose?: unknown;
      };
      processCleanup = audit.status === "pass" && audit.jobCloseApplied === true &&
          audit.membersAliveAfterClose === 0 &&
          (childPid === undefined || !processAlive(childPid))
        ? "pass"
        : "failed";
    } catch {
      processCleanup = "failed";
    }
    if (processCleanup === "failed") failureClass ??= "cleanup";
  } catch (error) {
    failureClass ??= failureOf(error) ?? "setup";
  } finally {
    const cleanupStarted = performance.now();
    if (!spawnAttempted) processCleanup = "pass";
    if (logger === undefined) {
      try {
        mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
        const logPath = join(evidenceRoot, logFile);
        writeFileSync(logPath, "", { flag: "wx", mode: 0o600 });
        let sequence = 0;
        logger = (record) => appendFileSync(
          logPath,
          `${JSON.stringify({ ...record, sequence: ++sequence })}\n`,
          { encoding: "utf8" },
        );
        for (const record of early) logger(record);
        early.length = 0;
      } catch {
        failureClass ??= "evidence";
      }
    }
    try { await monitor?.close(); } catch { failureClass ??= "cleanup"; }
    try { await fixture?.close(); } catch { failureClass ??= "cleanup"; }
    try {
      await provePortFree(options.pagePort);
      await provePortFree(options.monitorPort);
      portCleanup = "pass";
    } catch {
      failureClass ??= "cleanup";
    }
    if (runRootCreated) {
      try {
        log(entry(options, "cleanup", "owned_resources_remove", "started"));
        rmSync(runRoot, { recursive: true, force: true });
        profileCleanup = !existsSync(runRoot) && !existsSync(profileRoot) ? "pass" : "failed";
      } catch {
        profileCleanup = "failed";
      }
    } else {
      profileCleanup = "pass";
    }
    if (profileCleanup === "failed") failureClass ??= "cleanup";
    log(entry(
      options,
      "cleanup",
      "owned_resources_removed",
      failureClass === undefined ? "pass" : "failed",
      failureClass,
      childPid,
    ));
    cleanupDurationMs = readinessDuration(cleanupStarted);
  }

  return Object.freeze({
    runOrdinal: options.runOrdinal,
    status: failureClass === undefined ? "pass" : "failed",
    ...(failureClass === undefined ? {} : { failureClass }),
    ...(childPid === undefined ? {} : { childPid }),
    monitorRecords: monitor?.records ?? 0,
    watchdogChecks: monitor?.watchdogChecks ?? 0,
    processCleanup,
    portCleanup,
    profileCleanup,
    timingsMs: Object.freeze({
      setup: setupDurationMs,
      productionFlow: productionFlowDurationMs,
      cleanup: cleanupDurationMs,
      total: readinessDuration(runStarted),
      monotonicClock: "performance_now" as const,
    }),
    submitActivated: false,
    ...(evidenceSha256 === undefined ? {} : { evidenceSha256 }),
    logFile: join(runId, logFile).replaceAll("\\", "/"),
  });
}

class ReadinessMonitor {
  readonly #port: number;
  readonly #token: string;
  readonly #record: (record: MonitorRecord) => void;
  #server: Server | undefined;
  #childPid: number | undefined;
  #lastSeen = 0;
  #records = 0;
  #watchdogChecks = 0;
  #complete = false;
  readonly #history: MonitorRecord[] = [];

  constructor(port: number, token: string, record: (record: MonitorRecord) => void) {
    this.#port = port;
    this.#token = token;
    this.#record = record;
  }

  get childPid(): number | undefined { return this.#childPid; }
  get records(): number { return this.#records; }
  get watchdogChecks(): number { return this.#watchdogChecks; }
  get complete(): boolean { return this.#complete; }

  async start(): Promise<void> {
    if (this.#server !== undefined) denied();
    const server = createServer((request, response) => {
      if (request.method !== "POST" ||
          (request.url !== "/readiness" && request.url !== "/heartbeat") ||
          request.headers["x-hunt-readiness-token"] !== this.#token) {
        response.writeHead(404).end();
        return;
      }
      readBody(request, (body) => {
        try {
          const parsed: unknown = JSON.parse(body);
          if (request.url === "/heartbeat") {
            const pid = heartbeatPid(parsed);
            if (this.#childPid === undefined || pid !== this.#childPid || !processAlive(pid)) denied();
            this.#lastSeen = Date.now();
            this.#watchdogChecks += 1;
          } else {
            const record = monitorRecord(parsed, this.#records + 1, this.#childPid);
            if (!validMonitorTransition(this.#history, record)) denied();
            this.#childPid ??= record.pid;
            if (!processAlive(record.pid)) denied();
            this.#lastSeen = Date.now();
            this.#records += 1;
            this.#watchdogChecks += 1;
            this.#record(record);
            this.#history.push(record);
            if (successfulMonitorHistory(this.#history)) this.#complete = true;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"status":"acknowledged","observerReady":true}');
        } catch {
          response.writeHead(400).end();
        }
      }, () => response.writeHead(413).end());
    });
    await listen(server, this.#port);
    this.#server = server;
  }

  stale(maxAgeMs: number): boolean {
    return this.#childPid !== undefined && !this.#complete &&
      (!processAlive(this.#childPid) || Date.now() - this.#lastSeen > maxAgeMs);
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await closeServer(server);
  }
}

function runtimeIdentity(options: Pick<Stage2SyntheticReadinessOptions, "nodeExecutable" | "npmCliPath">): RuntimeIdentity {
  const executionerRoot = resolve(import.meta.dirname, "..", "..");
  const nodeVersion = execVersion(options.nodeExecutable, ["--version"]).replace(/^v/u, "");
  if (nodeVersion !== STAGE2_NODE_VERSION) throw classified("setup");
  const npmVersion = execVersion(options.nodeExecutable, [options.npmCliPath, "--version"]);
  if (npmVersion !== STAGE2_NPM_VERSION) throw classified("setup");
  const lockPath = join(executionerRoot, "package-lock.json");
  const browserPath = chromium.executablePath();
  if (!existsSync(browserPath) || !statSync(browserPath).isFile()) throw classified("setup");
  const playwrightLockSha256 = digest(readFileSync(lockPath));
  const browserExecutableSha256 = digest(readFileSync(browserPath));
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: executionerRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) throw classified("setup");
  if (!isGitAncestor(executionerRoot, ACCEPTED_READINESS_BASE, sourceRevision) ||
      REJECTED_OBSERVABILITY_COMMITS.some((commit) =>
        isGitAncestor(executionerRoot, commit, sourceRevision))) throw classified("setup");
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal", "--", "executioner"],
    { cwd: resolve(executionerRoot, ".."), encoding: "utf8", windowsHide: true },
  );
  if (dirty.trim() !== "") throw classified("setup");
  const runtimeKeySha256 = digest(Buffer.from(JSON.stringify({
    sourceRevision,
    nodeVersion,
    npmVersion,
    playwrightLockSha256,
    browserExecutableSha256,
  }), "utf8"));
  return Object.freeze({
    sourceRevision,
    runtimeKeySha256,
    nodeVersion,
    npmVersion,
    playwrightLockSha256,
    browserExecutableSha256,
  });
}

function isGitAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function validateOptions(options: Stage2SyntheticReadinessOptions): Stage2SyntheticReadinessOptions {
  const storageRoot = absolute(options.storageRoot);
  const nodeExecutable = admittedExecutable(options.nodeExecutable);
  const npmCliPath = admittedFile(options.npmCliPath, 8 * 1024 * 1024);
  if (options.pagePort === options.monitorPort) denied();
  for (const port of [options.pagePort, options.monitorPort]) {
    if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) denied();
  }
  const parent = dirname(storageRoot);
  if (!existsSync(parent) || !statSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) denied();
  return Object.freeze({ ...options, storageRoot, nodeExecutable, npmCliPath });
}

function monitorRecord(value: unknown, sequence: number, childPid: number | undefined): MonitorRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied();
  const record = value as Partial<MonitorRecord>;
  const keys = Object.keys(value).sort();
  const expected = [
    "schemaVersion", "sequence", "phase", "status", "pid", "submitActivated",
    ...(record.failureClass === undefined ? [] : ["failureClass"]),
    ...(record.evidenceSha256 === undefined ? [] : ["evidenceSha256"]),
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      record.schemaVersion !== 1 || record.sequence !== sequence ||
      !["child_spawn", "browser_launch", "page_binding", "monitor", "evidence", "cleanup"].includes(record.phase ?? "") ||
      !["started", "pass", "failed"].includes(record.status ?? "") ||
      !Number.isSafeInteger(record.pid) || (record.pid ?? 0) < 1 ||
      record.submitActivated !== false ||
      (childPid !== undefined && record.pid !== childPid) ||
      (record.failureClass !== undefined && !failureClasses.has(record.failureClass)) ||
      (record.evidenceSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(record.evidenceSha256))) denied();
  return Object.freeze(record as MonitorRecord);
}

function heartbeatPid(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== "pid\0schemaVersion") denied();
  const heartbeat = value as { readonly schemaVersion?: unknown; readonly pid?: unknown };
  if (heartbeat.schemaVersion !== 1 || !Number.isSafeInteger(heartbeat.pid) || (heartbeat.pid as number) < 1) denied();
  return heartbeat.pid as number;
}

const failureClasses = new Set<Stage2ReadinessFailureClass>([
  "setup", "child_spawn", "browser_launch", "page_binding", "evidence", "monitor", "cleanup",
]);

function isCertificate(value: unknown): value is Stage2ReadinessCertificateV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const certificate = value as Partial<Stage2ReadinessCertificateV1>;
  return certificate.schemaVersion === 1 && certificate.certificateRevision === "c3-synthetic-readiness-v1" &&
    certificate.status === "pass" && certificate.failureClass === undefined &&
    typeof certificate.sourceRevision === "string" && /^[0-9a-f]{40}$/u.test(certificate.sourceRevision) &&
    typeof certificate.runtimeKeySha256 === "string" && /^[0-9a-f]{64}$/u.test(certificate.runtimeKeySha256) &&
    certificate.nodeVersion === STAGE2_NODE_VERSION && certificate.npmVersion === STAGE2_NPM_VERSION &&
    typeof certificate.playwrightLockSha256 === "string" && /^[0-9a-f]{64}$/u.test(certificate.playwrightLockSha256) &&
    typeof certificate.browserExecutableSha256 === "string" && /^[0-9a-f]{64}$/u.test(certificate.browserExecutableSha256) &&
    Number.isSafeInteger(certificate.pagePort) && Number.isSafeInteger(certificate.monitorPort) &&
    certificate.observerReadyBeforeRunRoot === true && certificate.freshRunRoots === true &&
    certificate.submitActivated === false && Array.isArray(certificate.consecutiveRuns) &&
    certificate.consecutiveRuns.length === RUN_COUNT && certificate.consecutiveRuns.every((run, index) =>
      run.runOrdinal === index + 1 && run.status === "pass" && run.failureClass === undefined &&
      run.monitorRecords === 10 && run.watchdogChecks >= 10 && run.processCleanup === "pass" &&
      run.portCleanup === "pass" && run.profileCleanup === "pass" && run.submitActivated === false &&
      validReadinessTimings(run.timingsMs) &&
      typeof run.evidenceSha256 === "string" && /^[0-9a-f]{64}$/u.test(run.evidenceSha256)
    ) && typeof certificate.issuedAt === "string" && typeof certificate.expiresAt === "string" &&
    canonicalTimestamp(certificate.issuedAt) === certificate.issuedAt &&
    canonicalTimestamp(certificate.expiresAt) === certificate.expiresAt &&
    Date.parse(certificate.expiresAt) - Date.parse(certificate.issuedAt) === 24 * 60 * 60 * 1_000;
}

function validReadinessTimings(value: Stage2ReadinessRunResult["timingsMs"]): boolean {
  return typeof value === "object" && value !== null &&
    Object.keys(value).join("\0") === "setup\0productionFlow\0cleanup\0total\0monotonicClock" &&
    value.monotonicClock === "performance_now" &&
    [value.setup, value.productionFlow, value.cleanup, value.total].every((duration) =>
      Number.isSafeInteger(duration) && duration >= 0 && duration <= 1_000_000
    ) && value.total >= value.setup + value.productionFlow;
}

function readinessDuration(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function validMonitorTransition(history: readonly MonitorRecord[], record: MonitorRecord): boolean {
  const failureIndex = history.findIndex((item) => item.status === "failed");
  if (failureIndex >= 0) {
    const cleanup = history.slice(failureIndex + 1);
    return cleanup.length === 0
      ? record.phase === "cleanup" && record.status === "started"
      : cleanup.length === 1 && cleanup[0]?.phase === "cleanup" &&
        cleanup[0].status === "started" && record.phase === "cleanup" &&
        (record.status === "pass" || record.status === "failed");
  }
  const expected = [
    ["child_spawn", "pass"],
    ["browser_launch", "started"],
    ["browser_launch", "pass"],
    ["page_binding", "started"],
    ["page_binding", "pass"],
    ["monitor", "started"],
    ["monitor", "pass"],
    ["evidence", "pass"],
    ["cleanup", "started"],
    ["cleanup", "pass"],
  ] as const;
  const next = expected[history.length];
  if (next === undefined || record.phase !== next[0]) return false;
  return record.status === next[1] ||
    record.status === "failed" && record.failureClass === record.phase;
}

function successfulMonitorHistory(history: readonly MonitorRecord[]): boolean {
  return history.length === 10 && history.every((record) => record.status !== "failed") &&
    history[9]?.phase === "cleanup" && history[9].status === "pass";
}

function entry(
  options: { readonly runOrdinal: number; readonly now: () => string },
  phase: LogRecord["phase"],
  step: string,
  status: LogRecord["status"],
  failureClass?: Stage2ReadinessFailureClass,
  ownerPid?: number,
  evidenceSha256?: string,
): Omit<LogRecord, "sequence"> {
  return Object.freeze({
    schemaVersion: 1,
    runOrdinal: options.runOrdinal,
    phase,
    step,
    status,
    observedAt: canonicalTimestamp(options.now()),
    submitActivated: false,
    ...(failureClass === undefined ? {} : { failureClass }),
    ...(ownerPid === undefined ? {} : { ownerPid }),
    ...(evidenceSha256 === undefined ? {} : { evidenceSha256 }),
  });
}

function readBody(
  request: NodeJS.ReadableStream,
  complete: (body: string) => void,
  tooLarge: () => void,
): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  request.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > MAX_MONITOR_BODY_BYTES) request.removeAllListeners("data");
    else chunks.push(chunk);
  });
  request.on("end", () => bytes > MAX_MONITOR_BODY_BYTES
    ? tooLarge()
    : complete(Buffer.concat(chunks).toString("utf8")));
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const fail = (error: Error) => reject(error);
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) =>
    error === undefined ? resolveClose() : reject(error)));
}

async function provePortFree(port: number): Promise<void> {
  const server = createServer();
  await listen(server, port);
  await closeServer(server);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function classifyStage2ReadinessExit(
  code: number,
  records: number,
): Stage2ReadinessFailureClass {
  if (code === 21) return "browser_launch";
  if (code === 22) return "page_binding";
  if (code === 23) return "evidence";
  if (code === 24) return "monitor";
  if (code === 25 || code === 130 || code === 136) return "cleanup";
  return records === 0 ? "child_spawn" : "cleanup";
}

function classified(failureClass: Stage2ReadinessFailureClass): Error {
  return Object.assign(new Error(`readiness ${failureClass} failed`), { failureClass });
}

function failureOf(error: unknown): Stage2ReadinessFailureClass | undefined {
  if (typeof error !== "object" || error === null || !("failureClass" in error)) return undefined;
  const value = (error as { readonly failureClass?: unknown }).failureClass;
  return failureClasses.has(value as Stage2ReadinessFailureClass)
    ? value as Stage2ReadinessFailureClass
    : undefined;
}

function execVersion(executable: string, arguments_: readonly string[]): string {
  try {
    const value = execFileSync(executable, arguments_, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4_096,
    }).trim();
    if (value.length < 1 || value.length > 64) throw new Error("invalid version");
    return value;
  } catch {
    throw classified("setup");
  }
}

function writeExclusiveJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function admittedExecutable(value: string): string {
  const path = admittedFile(value, 512 * 1024 * 1024);
  if (!path.toLowerCase().endsWith(".exe")) denied();
  return path;
}

function admittedFile(value: string, maxBytes: number): string {
  if (!isAbsolute(value) || normalize(value) !== value || !existsSync(value) ||
      lstatSync(value).isSymbolicLink() || !statSync(value).isFile() ||
      statSync(value).size < 1 || statSync(value).size > maxBytes) denied();
  return realpathSync.native(value);
}

function absolute(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value) denied();
  return resolve(value);
}

function canonicalTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      new Date(Date.parse(value)).toISOString() !== value) denied();
  return value;
}

function timestampKey(value: string): string {
  return canonicalTimestamp(value).replaceAll(/[-:.TZ]/gu, "");
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function denied(): never {
  throw new TypeError("synthetic readiness denied");
}
