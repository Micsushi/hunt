import { randomBytes } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
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
  EventId,
  OperationId,
  ProfileLeaseId,
  SecretHandleId,
  TargetHostId,
  TargetPostingId,
  TargetTenantId,
} from "../contracts/index.ts";
import { writeAccountAccessEvidence } from "../live/evidence/account-access-evidence.ts";
import { writeAccountAccessDiagnostics } from "../live/evidence/account-access-diagnostics.ts";
import {
  createOperatorMonitorInspectionHold,
} from "../live/evidence/operator-monitor-ack.ts";
import { createPrivateRealRunAdmission } from "../live/preflight/private/runtime-binding.ts";
import type { RealRunOwnerInputsV1 } from "../live/preflight/types.ts";
import {
  runStage2AccountAccess,
  type AccountEntryNavigator,
  type Stage2AccountAccessResult,
} from "../live/runner/account-access.ts";
import { WindowsDpapiSecretResolver } from "../secrets/windows-dpapi/private/resolver.ts";
import { WindowsDpapiSecretStore } from "../secrets/windows-dpapi/store.ts";
import { inspectCleanSourceRevision } from "./private/s2-clean-source-revision.ts";
import { matchesStage2OwnerStorageBinding } from "./private/s2-owner-storage-binding.ts";
export {
  inspectCleanSourceRevision,
  type GitInspectionProcess,
} from "./private/s2-clean-source-revision.ts";

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
    if (!matchesStage2OwnerStorageBinding({
      ownerConfigPath: configPath,
      runtimeRoot: owner.roots.runtime.path,
      ownerEvidenceRoot: owner.roots.evidence.path,
      requestedEvidenceRoot: options.evidenceRoot,
    })) return failed("owner_config_invalid");

    const secretStore = new WindowsDpapiSecretStore({
      root: owner.roots.secrets.path,
      forbiddenRoots: [source.repositoryRoot],
      now: () => now,
    });
    const valueFreeTrace = process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1"
      ? (event: string) => process.stderr.write(`${JSON.stringify({ trace: event })}\n`)
      : undefined;
    const inspectionHold = process.env.HUNT_C3_LIVE_INSPECTION_HOLD === "1"
      ? createOperatorMonitorInspectionHold({
        runtimeRoot: owner.roots.runtime.path,
        evidenceRoot: owner.roots.evidence.path,
        journeyId: owner.journeyId,
        targetHandleId: owner.target.handleId,
        host: owner.target.host,
        tenant: owner.target.tenant,
        posting: owner.target.posting,
      })
      : undefined;
    const browser = createPlaywrightPersistentBrowserSession({
      binding: admission.binding,
      accountTrace: valueFreeTrace,
      inspectionHold,
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
      valueFreeTrace,
    );
    const targetSuffix = opaqueSuffix(owner.target.handleId, "target_ref_");
    const profileSuffix = opaqueSuffix(owner.profileRef, "profile_ref_");
    const sensitiveValues = [
      owner.target.url,
      owner.target.host,
      owner.target.tenant,
      owner.target.posting,
      owner.roots.runtime.path,
      owner.roots.secrets.path,
      owner.roots.evidence.path,
      configPath,
    ];
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
          sensitiveValues,
        }),
      },
      diagnostics: {
        write: async (diagnostics) => writeAccountAccessDiagnostics({
          root: owner.roots.evidence.path,
          diagnostics,
          sensitiveValues,
        }),
      },
      nextOperationId: () =>
        `operation_${randomBytes(16).toString("hex")}` as OperationId,
      nextEventId: () =>
        `event_${randomBytes(16).toString("hex")}` as EventId,
      now: () => new Date().toISOString(),
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

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function failed(code: string): Stage2AccountAccessResult {
  return Object.freeze({ ok: false, code });
}
