import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createClassifiedAccountObservationSource,
  createLiveEntryVerifier,
} from "../ats/workday/live/index.ts";
import { createPlaywrightPersistentBrowserSession } from "../browser/playwright-live/index.ts";
import type { PlaywrightPersistentBrowserSession } from "../browser/playwright-live/session.ts";
import { createPlaywrightLiveEntryStructuralSource } from "./s2-live-entry-source.ts";
import { createStage2AccountEntryCredentialMutationAdapter } from "./s2-account-entry.ts";
import type {
  OperationId,
  ProfileLeaseId,
  SecretHandleId,
  TargetHostId,
  TargetPostingId,
  TargetTenantId,
} from "../contracts/index.ts";
import { writeAccountAccessEvidence } from "../live/evidence/account-access-evidence.ts";
import { createPrivateRealRunAdmission } from "../live/preflight/private/runtime-binding.ts";
import type { RealRunOwnerInputsV1 } from "../live/preflight/types.ts";
import {
  runStage2AccountAccess,
  type AccountEntryNavigator,
  type Stage2AccountAccessResult,
} from "../live/runner/account-access.ts";
import { WindowsDpapiSecretResolver } from "../secrets/windows-dpapi/private/resolver.ts";
import { WindowsDpapiSecretStore } from "../secrets/windows-dpapi/store.ts";

const PRODUCTION_SCOPE = Object.freeze([
  ":(top)executioner/src",
  ":(top)executioner/scripts",
  ":(top)executioner/package.json",
  ":(top)executioner/package-lock.json",
  ":(top)executioner/README.md",
]);

export interface GitInspectionResult {
  readonly status: number | null;
  readonly stdout: string;
}

export interface GitInspectionProcess {
  run(args: readonly string[]): GitInspectionResult;
}

export interface CleanSourceRevision {
  readonly repositoryRoot: string;
  readonly sourceRevision: string;
}

export function inspectCleanSourceRevision(
  cwd: string,
  process: GitInspectionProcess = new LocalGitInspectionProcess(cwd),
): CleanSourceRevision {
  const root = process.run(["rev-parse", "--show-toplevel"]);
  const revision = process.run(["rev-parse", "HEAD"]);
  if (root.status !== 0 || revision.status !== 0) unavailable();
  const repositoryRoot = root.stdout.trim();
  const sourceRevision = revision.stdout.trim();
  if (repositoryRoot.length === 0 || !/^[0-9a-f]{40}$/u.test(sourceRevision)) {
    unavailable();
  }
  const worktree = process.run(["diff", "--quiet", "--", ...PRODUCTION_SCOPE]);
  const index = process.run(["diff", "--cached", "--quiet", "--", ...PRODUCTION_SCOPE]);
  const untracked = process.run([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ...PRODUCTION_SCOPE,
  ]);
  if (
    worktree.status !== 0 ||
    index.status !== 0 ||
    untracked.status !== 0 ||
    untracked.stdout.trim() !== ""
  ) unavailable();
  return Object.freeze({ repositoryRoot, sourceRevision });
}

class LocalGitInspectionProcess implements GitInspectionProcess {
  readonly #cwd: string;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  run(args: readonly string[]): GitInspectionResult {
    const result = spawnSync("git", [...args], {
      cwd: this.#cwd,
      shell: false,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Object.freeze({
      status: result.error === undefined && result.signal === null
        ? result.status
        : null,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
    });
  }
}

function unavailable(): never {
  throw new Error("source revision unavailable");
}

export interface Stage2AccountAccessProductionOptions {
  readonly configPath: string;
  readonly evidenceRoot: string;
}

export async function runStage2AccountAccessFromOwnerConfig(
  options: Stage2AccountAccessProductionOptions,
  signal: AbortSignal,
): Promise<Stage2AccountAccessResult> {
  try {
    const executionerRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const source = inspectCleanSourceRevision(executionerRoot);
    const configPath = admittedFile(options.configPath);
    const value = readOwnerConfig(configPath);
    const now = new Date().toISOString();
    const admission = createPrivateRealRunAdmission(value, {
      now,
      forbiddenRoots: [source.repositoryRoot],
      ownerConfigPath: configPath,
    });
    if (!admission.ok) return failed(admission.error.code);
    const owner = value as RealRunOwnerInputsV1;
    if (
      !inside(owner.roots.runtime.path, configPath) ||
      !samePath(owner.roots.evidence.path, options.evidenceRoot)
    ) return failed("owner_config_invalid");

    const secretStore = new WindowsDpapiSecretStore({
      root: owner.roots.secrets.path,
      forbiddenRoots: [source.repositoryRoot],
      now: () => now,
    });
    const browser = createPlaywrightPersistentBrowserSession({
      binding: admission.binding,
    });
    const navigator = browser as PlaywrightPersistentBrowserSession &
      AccountEntryNavigator;
    const structural = createPlaywrightLiveEntryStructuralSource(browser);
    const classified = createClassifiedAccountObservationSource(
      createLiveEntryVerifier(structural),
    );
    const resolver = new WindowsDpapiSecretResolver({
      root: owner.roots.secrets.path,
      forbiddenRoots: [source.repositoryRoot],
      now: () => now,
    });
    const credentials = createStage2AccountEntryCredentialMutationAdapter(
      browser,
      classified,
      resolver,
      owner.accountMode,
    );
    const targetSuffix = opaqueSuffix(owner.target.handleId, "target_ref_");
    const profileSuffix = opaqueSuffix(owner.profileRef, "profile_ref_");
    return await runStage2AccountAccess({
      sourceRevision: source.sourceRevision,
      revisionId: owner.revisionId,
      approvalId: owner.approval.approvalId,
      journeyId: owner.journeyId as never,
      accountMode: owner.accountMode,
      targetHandleId: owner.target.handleId,
      profileLeaseId: `profile_lease_${profileSuffix}` as ProfileLeaseId,
      target: {
        schemaVersion: 1,
        atsFamily: "workday",
        hostId: `host_${targetSuffix}` as TargetHostId,
        tenantId: `tenant_${targetSuffix}` as TargetTenantId,
        postingId: `posting_${targetSuffix}` as TargetPostingId,
      },
      accountSecretHandleId: owner.accountSecret.handleId as SecretHandleId,
      accountSecretExpiresAt: owner.accountSecret.expiresAt,
      gmailAuthorizationHandleId:
        owner.gmailAuthorization.handleId as SecretHandleId,
      gmailAuthorizationExpiresAt: owner.gmailAuthorization.expiresAt,
      now,
    }, {
      secretStore,
      browser,
      navigator,
      credentials,
      evidence: {
        write: async (acceptance) => writeAccountAccessEvidence({
          root: owner.roots.evidence.path,
          acceptance,
          sensitiveValues: [
            owner.target.url,
            owner.target.host,
            owner.target.tenant,
            owner.target.posting,
            owner.roots.runtime.path,
            owner.roots.secrets.path,
            owner.roots.evidence.path,
            configPath,
          ],
        }),
      },
      nextOperationId: () =>
        `operation_${randomBytes(16).toString("hex")}` as OperationId,
    }, signal);
  } catch {
    return failed(signal.aborted ? "operation_cancelled" : "owner_config_invalid");
  }
}

function admittedFile(value: string): string {
  if (
    !isAbsolute(value) ||
    normalize(value) !== value ||
    lstatSync(value).isSymbolicLink() ||
    !statSync(value).isFile() ||
    statSync(value).size < 2 ||
    statSync(value).size > 64 * 1024
  ) throw new TypeError("invalid owner config");
  const canonical = realpathSync.native(value);
  if (comparable(canonical) !== comparable(resolve(value))) {
    throw new TypeError("invalid owner config");
  }
  return canonical;
}

function readOwnerConfig(path: string): unknown {
  const bytes = readFileSync(path);
  try {
    if (
      bytes.byteLength < 2 ||
      bytes.byteLength > 64 * 1024 ||
      (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    ) throw new TypeError("invalid owner config");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    bytes.fill(0);
  }
}

function opaqueSuffix(value: string, prefix: string): string {
  const suffix = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(suffix)) {
    throw new TypeError("invalid opaque reference");
  }
  return suffix;
}

function inside(root: string, child: string): boolean {
  const relativePath = relative(realpathSync.native(root), realpathSync.native(child));
  return relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(relativePath);
}

function samePath(left: string, right: string): boolean {
  try {
    return comparable(realpathSync.native(left)) ===
      comparable(realpathSync.native(right));
  } catch {
    return false;
  }
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function failed(code: string): Stage2AccountAccessResult {
  return Object.freeze({ ok: false, code });
}
