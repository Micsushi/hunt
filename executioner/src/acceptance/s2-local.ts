import { createHash } from "node:crypto";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { inspectCleanSourceRevision } from "../composition/private/s2-clean-source-revision.ts";
import {
  finalizeStage2RunStorage,
  type FinalizeStage2RunStorageRequest,
} from "../composition/private/s2-run-storage.ts";
import { writeAtomicJsonEvidence } from "../live/evidence/private/atomic-json-evidence.ts";
import {
  runWindowsIsolatedStage2Acceptance,
  supportsWindowsIsolatedNodeRuntime,
} from "../live/runner/windows-isolated-process.ts";
import type {
  Stage2AcceptanceGatePorts,
  Stage2AcceptanceManifest,
  Stage2ConfigCapture,
  Stage2RealAcceptanceArgs,
  Stage2ReviewAcceptance,
  Stage2SourceCapture,
} from "./s2-gate.ts";

const REVIEW_KEYS = [
  "schemaVersion", "evidenceRevision", "sourceRevision", "configSha256",
  "contractRevision", "revisionId", "approvalId", "journeyId", "targetHandleId",
  "checkpoint", "status", "reviewProof", "submitPresent", "submitActivated", "privacyScan",
] as const;

export interface Stage2CommandPort {
  run(
    executable: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly signal?: AbortSignal },
  ): Promise<number>;
}

export interface LocalStage2AcceptanceDependencies {
  readonly sourceCapture?: () => Stage2SourceCapture;
  readonly configCapture?: (path: string) => Stage2ConfigCapture;
  readonly command?: Stage2CommandPort;
  readonly live?: {
    run(args: readonly string[], signal?: AbortSignal): Promise<number>;
  };
  readonly resultRead?: (root: string) => Stage2ReviewAcceptance;
  readonly manifestWrite?: (root: string, value: Stage2AcceptanceManifest) => void;
  readonly completionAudit?: (root: string) => Promise<unknown>;
  readonly finalize?: (request: FinalizeStage2RunStorageRequest) => Promise<unknown>;
}

export function createLocalStage2AcceptancePorts(
  cwdValue: string,
  dependencies: LocalStage2AcceptanceDependencies = {},
): Stage2AcceptanceGatePorts {
  const cwd = resolve(cwdValue);
  const command = dependencies.command ?? new LocalStage2Command();
  const npmCliPath = process.platform === "win32"
    ? captureAdmittedNpmCliPath()
    : undefined;
  const sourceCapture = dependencies.sourceCapture ?? (() => inspectCleanSourceRevision(cwd));
  const configCapture = dependencies.configCapture ?? captureStage2Config;
  const resultRead = dependencies.resultRead ?? readStage2ReviewAcceptance;
  const manifestWrite = dependencies.manifestWrite ?? writeStage2AcceptanceManifest;
  const completionAudit = dependencies.completionAudit ?? (async (root: string) =>
    (await import("../composition/private/s2-any-completion-audit.ts"))
      .auditStage2Completion(root));
  const finalize = dependencies.finalize ?? finalizeStage2RunStorage;
  const live = dependencies.live ?? {
    run: async (args: readonly string[], signal?: AbortSignal) => {
      const runnerPath = resolve(
        import.meta.dirname,
        "..",
        "..",
        "scripts",
        "run-s2-review.ts",
      );
      if (process.platform === "win32") {
        if (!supportsWindowsIsolatedNodeRuntime(process.versions.node)) return 2;
        return runWindowsIsolatedStage2Acceptance(args, {
          signal,
          runnerPath,
          environment: {
            ...process.env,
            HUNT_C3_VALUE_FREE_ACCOUNT_TRACE: "1",
            HUNT_C3_OUTER_PROCESS_CLEANUP: "1",
          },
        });
      }
      return command.run(
        process.execPath,
        [runnerPath, ...args],
        { cwd, signal },
      );
    },
  };
  return {
    source: { capture: async () => sourceCapture() },
    config: { capture: async (path) => configCapture(path) },
    quality: {
      run: (signal) => {
        if (process.platform !== "win32") {
          return command.run("npm", ["run", "quality"], { cwd, signal });
        }
        try {
          return command.run(
            process.execPath,
            [requiredNpmCliPath(npmCliPath), "run", "quality"],
            { cwd, signal },
          );
        } catch {
          return Promise.resolve(1);
        }
      },
    },
    journey: {
      run: (args, signal) => live.run(realArguments(args), signal),
    },
    result: { read: async (root) => resultRead(root) },
    cleanup: {
      finalize: async (args, manifest) => {
        manifestWrite(args.evidenceRoot, manifest);
        await completionAudit(args.evidenceRoot);
        await finalize({
          storageRoot: dirname(dirname(dirname(args.configPath))),
          ownerConfigPath: args.configPath,
          evidenceRoot: args.evidenceRoot,
        });
      },
    },
  };
}

function captureAdmittedNpmCliPath(): string | undefined {
  try {
    return admittedNpmCliPath();
  } catch {
    return undefined;
  }
}

function requiredNpmCliPath(value: string | undefined): string {
  if (value === undefined) return denied("npm executable denied");
  return value;
}

function realArguments(args: Stage2RealAcceptanceArgs): readonly string[] {
  return Object.freeze([
    "--config", args.configPath,
    "--stop-after", "review",
    "--evidence-root", args.evidenceRoot,
  ]);
}

export class LocalStage2Command implements Stage2CommandPort {
  run(
    executable: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly signal?: AbortSignal },
  ): Promise<number> {
    if (options.signal?.aborted) return Promise.resolve(130);
    return new Promise((resolveResult) => {
      let child: ChildProcess;
      try {
        child = spawn(executable, [...args], {
          cwd: options.cwd,
          shell: false,
          windowsHide: true,
          stdio: "inherit",
        });
      } catch {
        resolveResult(1);
        return;
      }
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        if (process.platform === "win32" && child.pid !== undefined) {
          spawnSync("C:\\Windows\\System32\\taskkill.exe", [
            "/PID", String(child.pid), "/T", "/F",
          ], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
            timeout: 5_000,
          });
        } else {
          child.kill();
        }
      };
      child.once("error", () => {
        options.signal?.removeEventListener("abort", cancel);
        resolveResult(cancelled ? 130 : 1);
      });
      child.once("close", (code, signal) => {
        options.signal?.removeEventListener("abort", cancel);
        resolveResult(cancelled ? 130 : signal === null && code !== null ? code : 1);
      });
      if (options.signal?.aborted) cancel();
      else options.signal?.addEventListener("abort", cancel, { once: true });
    });
  }
}

export function captureStage2Config(pathValue: string): Stage2ConfigCapture {
  const path = admittedFile(pathValue, 1024 * 1024, "owner config denied");
  const bytes = readFileSync(path);
  try {
    const value = object(JSON.parse(bytes.toString("utf8")), "owner config denied");
    const target = object(value.target, "owner config denied");
    const approval = object(value.approval, "owner config denied");
    return exactConfig({
      configSha256: createHash("sha256").update(bytes).digest("hex"),
      contractRevision: value.contractRevision,
      revisionId: value.revisionId,
      approvalId: approval.approvalId,
      journeyId: value.journeyId,
      targetHandleId: target.handleId,
    });
  } catch {
    return denied("owner config denied");
  } finally {
    bytes.fill(0);
  }
}

export function readStage2ReviewAcceptance(rootValue: string): Stage2ReviewAcceptance {
  try {
    const root = admittedDirectory(rootValue, "review acceptance evidence denied");
    const bytes = readFileSync(admittedFile(
      join(root, "review-acceptance.json"),
      16 * 1024,
      "review acceptance evidence denied",
    ));
    try {
      const value = object(JSON.parse(bytes.toString("utf8")), "review acceptance evidence denied");
      return exactReview(value, "review acceptance evidence denied");
    } finally {
      bytes.fill(0);
    }
  } catch {
    return denied("review acceptance evidence denied");
  }
}

export function writeStage2ReviewAcceptance(
  evidenceRoot: string,
  value: Stage2ReviewAcceptance,
  sensitiveValues: readonly string[],
): void {
  const accepted = exactReview(value, "review acceptance evidence denied");
  writeAtomicJsonEvidence({
    root: evidenceRoot,
    value: accepted,
    sensitiveValues,
    label: "review acceptance",
    fileName: "review-acceptance.json",
  });
}

export function writeStage2AcceptanceManifest(
  evidenceRoot: string,
  value: Stage2AcceptanceManifest,
): void {
  exactManifest(value);
  writeAtomicJsonEvidence({
    root: evidenceRoot,
    value,
    sensitiveValues: [],
    label: "acceptance-gate",
    fileName: "s2-acceptance-manifest.json",
  });
}

export function readStage2AcceptanceManifest(rootValue: string): Stage2AcceptanceManifest {
  try {
    const root = admittedDirectory(rootValue, "acceptance-gate evidence denied");
    const bytes = readFileSync(admittedFile(
      join(root, "s2-acceptance-manifest.json"),
      16 * 1024,
      "acceptance-gate evidence denied",
    ));
    try {
      const value = object(JSON.parse(bytes.toString("utf8")), "acceptance-gate evidence denied") as
        unknown as Stage2AcceptanceManifest;
      exactManifest(value);
      return Object.freeze({ ...value });
    } finally {
      bytes.fill(0);
    }
  } catch {
    return denied("acceptance-gate evidence denied");
  }
}

function exactManifest(value: Stage2AcceptanceManifest): void {
  const expected = [
    "schemaVersion", "acceptanceRevision", "status", "sourceRevision", "configSha256",
    "contractRevision", "revisionId", "approvalId", "journeyId", "targetHandleId",
    "checkpoint", "quality", "reviewProof", "submitPresent", "submitActivated",
    "privacyScan", "cleanup",
  ];
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key, index) => Object.keys(value)[index] !== key) ||
    value.schemaVersion !== 1 || value.acceptanceRevision !== "s2-real-acceptance-gate-v1" ||
    value.status !== "review_verified" || !/^[0-9a-f]{40}$/u.test(value.sourceRevision) ||
    value.checkpoint !== "review" || value.quality !== "pass" ||
    value.reviewProof !== "independently_verified" || value.submitPresent !== true ||
    value.submitActivated !== false || value.privacyScan !== "pass" ||
    value.cleanup !== "pending_exact_finalization"
  ) denied("acceptance-gate evidence denied");
  exactConfig(value);
}

function exactReview(
  value: Record<string, unknown> | Stage2ReviewAcceptance,
  message: string,
): Stage2ReviewAcceptance {
  if (
    Object.keys(value).length !== REVIEW_KEYS.length ||
    REVIEW_KEYS.some((key, index) => Object.keys(value)[index] !== key) ||
    value.schemaVersion !== 1 || value.evidenceRevision !== "s2-review-acceptance-v1" ||
    value.checkpoint !== "review" || value.status !== "passed" ||
    value.reviewProof !== "independently_verified" || value.submitPresent !== true ||
    value.submitActivated !== false || value.privacyScan !== "pass" ||
    typeof value.sourceRevision !== "string" || !/^[0-9a-f]{40}$/u.test(value.sourceRevision)
  ) denied(message);
  return Object.freeze({
    schemaVersion: 1,
    evidenceRevision: "s2-review-acceptance-v1",
    sourceRevision: value.sourceRevision,
    ...exactConfig(value),
    checkpoint: "review",
    status: "passed",
    reviewProof: "independently_verified",
    submitPresent: true,
    submitActivated: false,
    privacyScan: "pass",
  });
}

function exactConfig(value: Record<string, unknown> | Stage2ConfigCapture): Stage2ConfigCapture {
  const configSha256 = value.configSha256;
  const contractRevision = value.contractRevision;
  const revisionId = value.revisionId;
  const approvalId = value.approvalId;
  const journeyId = value.journeyId;
  const targetHandleId = value.targetHandleId;
  if (
    typeof configSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(configSha256) ||
    typeof contractRevision !== "string" || !/^s2-owner-inputs-v\d+$/u.test(contractRevision) ||
    typeof revisionId !== "string" || !/^revision_[A-Za-z0-9_-]{16,64}$/u.test(revisionId) ||
    typeof approvalId !== "string" || !/^approval_[A-Za-z0-9_-]{16,64}$/u.test(approvalId) ||
    typeof journeyId !== "string" || !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(journeyId) ||
    typeof targetHandleId !== "string" || !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(targetHandleId)
  ) denied("acceptance evidence denied");
  return Object.freeze({
    configSha256,
    contractRevision,
    revisionId,
    approvalId,
    journeyId,
    targetHandleId,
  });
}

function admittedDirectory(value: string, message: string): string {
  try {
    if (
      !isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
      !statSync(value).isDirectory() || comparable(realpathSync.native(value)) !== comparable(resolve(value))
    ) throw new Error();
    return realpathSync.native(value);
  } catch {
    return denied(message);
  }
}

function admittedFile(value: string, maximumBytes: number, message: string): string {
  try {
    if (!isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink()) {
      throw new Error();
    }
    const status = statSync(value);
    if (
      !status.isFile() || status.size < 2 || status.size > maximumBytes ||
      comparable(realpathSync.native(value)) !== comparable(resolve(value))
    ) throw new Error();
    return realpathSync.native(value);
  } catch {
    return denied(message);
  }
}

export function admittedNpmCliPath(
  value: string | undefined = process.env.npm_execpath,
  nodeExecutable: string = process.execPath,
): string {
  if (
    value === undefined || value.startsWith("\\\\") ||
    !isAbsolute(nodeExecutable) || normalize(nodeExecutable) !== nodeExecutable ||
    nodeExecutable.startsWith("\\\\") || basename(value).toLowerCase() !== "npm-cli.js"
  ) {
    return denied("npm executable denied");
  }
  const expected = join(dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js");
  if (comparable(value) !== comparable(expected)) return denied("npm executable denied");
  const admitted = admittedFile(value, 1024 * 1024, "npm executable denied");
  if (
    comparable(admitted) !== comparable(expected) ||
    statSync(admitted).nlink !== 1
  ) return denied("npm executable denied");
  return admitted;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied(message);
  return value as Record<string, unknown>;
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(message: string): never {
  throw new Error(message);
}
