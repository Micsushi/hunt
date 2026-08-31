import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";

import { writeAtomicJsonEvidence } from "../../live/evidence/private/atomic-json-evidence.ts";
import { readStage2TerminalArtifact } from "../../acceptance/s2-terminal-artifact.ts";
import { admitProfileFieldLearningEvidence } from
  "../../live/evidence/profile-field-learning.ts";
import {
  admitPendingProfileQuestionsEvidence,
  admitQuestionAnswerLearningEvidence,
} from
  "../../live/evidence/question-answer-learning.ts";
import { verifyManifestRetainedFiles } from "./s2-retained-file-integrity.ts";
import { readWindowsProcessAudit } from "../../live/evidence/windows-process-audit.ts";
import { inspectStage2ReviewCompletion } from "./s2-review-completion-audit.ts";
import { inspectStage2ApplicationFailureCompletion } from
  "./s2-application-failure-completion-audit.ts";
import { sweepExpiredVerificationReplayClaims } from "./s2-verification-replay-ledger.ts";

const RUN_KEY = /^run_\d{8}_[a-z0-9]{16}$/u;
const TARGET_HOST = /^[a-z0-9.-]{4,253}$/u;
const TARGET_TENANT = /^[a-z0-9-]{2,64}$/u;
const TARGET_POSTING = /^[A-Za-z0-9-]{2,64}$/u;
const ACCOUNT_ACCESS_RETAINED_FILES = new Set([
  "acceptance.json",
  "completion-audit.json",
  "diagnostics.json",
  "monitor-ack.json",
  "monitor-visible.png",
  "process-audit.json",
]);
const ACCOUNT_VERIFIED_RETAINED_FILES = new Set([
  "acceptance.json",
  "completion-audit.json",
  "monitor-ack.json",
  "monitor-visible.png",
  "process-audit.json",
]);
const REVIEW_RETAINED_FILES = new Set([
  "acceptance.json",
  "application-walk-acceptance.json",
  "completion-audit.json",
  "monitor-ack.json",
  "monitor-visible.png",
  "page-local-inspection.json",
  "pending-profile-questions.json",
  "profile-field-learning-02.json",
  "profile-field-learning.json",
  "question-answer-learning.json",
  "process-audit.json",
  "review-acceptance.json",
  "s2-acceptance-manifest.json",
  "terminal-artifact.json",
  "value-free-trace.ndjson",
]);
const APPLICATION_FAILURE_RETAINED_FILES = new Set([
  "acceptance.json",
  "application-walk-acceptance.json",
  "completion-audit.json",
  "external-monitor-observer-failure.json",
  "failure-source-binding.json",
  "page-local-inspection.json",
  "pending-profile-questions.json",
  "process-audit.json",
  "profile-field-learning-02.json",
  "profile-field-learning.json",
  "question-answer-learning.json",
  "terminal-artifact.json",
  "value-free-trace.ndjson",
]);

export interface Stage2StoragePath {
  readonly path: string;
  readonly directory: boolean;
}

export interface Stage2StorageProtector {
  protect(paths: readonly Stage2StoragePath[]): Promise<void>;
}

export async function protectStage2StoragePaths(
  paths: readonly Stage2StoragePath[],
  protector: Stage2StorageProtector = localModeProtector,
): Promise<void> {
  await protector.protect(paths);
}

export interface Stage2RunStorageLayout {
  readonly storageRoot: string;
  readonly recipientBindingId: string;
  readonly verificationConsumptionRoot: string;
  readonly runKey: string;
  readonly transientRoot: string;
  readonly ownerConfigPath: string;
  readonly runtimeRoot: string;
  readonly secretsRoot: string;
  readonly retainedRunRoot: string;
  readonly evidenceRoot: string;
}

export interface Stage2StorageTarget {
  readonly host: string;
  readonly tenant: string;
  readonly posting: string;
}

export interface Stage2StorageCatalogEntryV1 {
  readonly runKey: string;
  readonly target: Stage2StorageTarget;
  readonly completedAt: string;
  readonly retainUntil: string;
  readonly runStatus: "passed" | "blocked" | "failed";
  readonly monitorClassification: string;
  readonly sourceRevision: string;
  readonly evidenceDirectory: string;
  readonly transientCleanup: "pass";
}

export interface Stage2StorageCatalogV1 {
  readonly schemaVersion: 1;
  readonly storageRevision: "s2-run-storage-v1";
  readonly entries: readonly Stage2StorageCatalogEntryV1[];
}

export interface Stage2StorageInventoryV1 {
  readonly schemaVersion: 1;
  readonly inventoryRevision: "s2-run-storage-inventory-v1";
  readonly counts: {
    readonly finalized: number;
    readonly readyToFinalize: number;
    readonly unfinished: number;
    readonly legacyRetained: number;
    readonly invalid: number;
    readonly unmanagedEntries: number;
  };
  readonly runs: readonly {
    readonly runKey: string;
    readonly disposition:
      | "finalized_stays"
      | "ready_to_finalize"
      | "unfinished_goes_after_exact_discard"
      | "legacy_retained_review"
      | "invalid_review";
  }[];
}

export interface PrepareStage2RunStorageRequest {
  readonly storageRoot: string;
  readonly runKey?: string;
}

export interface FinalizeStage2RunStorageRequest {
  readonly storageRoot: string;
  readonly ownerConfigPath: string;
  readonly evidenceRoot: string;
}

export interface FinalizeStage2RunStorageResult {
  readonly runKey: string;
  readonly target: Stage2StorageTarget;
  readonly retainUntil: string;
  readonly transientCleanup: "pass";
}

export interface DiscardStage2RunStorageRequest {
  readonly storageRoot: string;
  readonly ownerConfigPath: string;
  readonly evidenceRoot: string;
}

export interface DiscardStage2RunStorageResult {
  readonly runKey: string;
  readonly transientCleanup: "pass";
  readonly retainedCleanup: "pass";
}

export async function prepareStage2RunStorage(
  request: PrepareStage2RunStorageRequest,
  protector: Stage2StorageProtector = localModeProtector,
): Promise<Stage2RunStorageLayout> {
  const storageRoot = admittedDirectory(request.storageRoot, true);
  const recipientBindingId = await persistentRecipientBinding(storageRoot, protector);
  const verificationConsumptionRoot = join(
    storageRoot,
    "bindings",
    "verification-consumption",
  );
  const runKey = request.runKey ?? generatedRunKey();
  if (!RUN_KEY.test(runKey)) denied("storage preparation denied");
  const transientParent = join(storageRoot, "transient");
  const retainedParent = join(storageRoot, "retained");
  mkdirSync(transientParent, { recursive: true, mode: 0o700 });
  mkdirSync(retainedParent, { recursive: true, mode: 0o700 });
  const transientRoot = join(transientParent, runKey);
  const retainedRunRoot = join(retainedParent, runKey);
  if (existsSync(transientRoot) || existsSync(retainedRunRoot)) {
    denied("storage preparation denied");
  }
  mkdirSync(transientRoot, { mode: 0o700 });
  mkdirSync(retainedRunRoot, { mode: 0o700 });
  const runtimeRoot = join(transientRoot, "runtime");
  const secretsRoot = join(transientRoot, "secrets");
  const evidenceRoot = join(retainedRunRoot, "evidence");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  mkdirSync(secretsRoot, { mode: 0o700 });
  mkdirSync(evidenceRoot, { mode: 0o700 });
  const ownerConfigPath = join(transientRoot, "owner-input.json");
  const descriptorPath = join(transientRoot, "storage-layout.json");
  closeSync(openSync(ownerConfigPath, "wx", 0o600));
  writeFileSync(descriptorPath, `${JSON.stringify({
    schemaVersion: 1,
    storageRevision: "s2-run-storage-v1",
    runKey,
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });

  const paths: readonly Stage2StoragePath[] = [
    { path: storageRoot, directory: true },
    { path: verificationConsumptionRoot, directory: true },
    { path: transientParent, directory: true },
    { path: retainedParent, directory: true },
    { path: transientRoot, directory: true },
    { path: retainedRunRoot, directory: true },
    { path: runtimeRoot, directory: true },
    { path: secretsRoot, directory: true },
    { path: evidenceRoot, directory: true },
    { path: ownerConfigPath, directory: false },
    { path: descriptorPath, directory: false },
  ];
  try {
    await protector.protect(paths);
  } catch {
    rmSync(transientRoot, { recursive: true, force: true });
    rmSync(retainedRunRoot, { recursive: true, force: true });
    denied("storage preparation denied");
  }
  return frozenLayout({
    storageRoot,
    recipientBindingId,
    verificationConsumptionRoot,
    runKey,
    transientRoot,
    ownerConfigPath,
    runtimeRoot,
    secretsRoot,
    retainedRunRoot,
    evidenceRoot,
  });
}

export async function finalizeStage2RunStorage(
  request: FinalizeStage2RunStorageRequest,
): Promise<FinalizeStage2RunStorageResult> {
  try {
    const storageRoot = admittedDirectory(request.storageRoot, false);
    const layout = existingLayout(storageRoot, request.ownerConfigPath, request.evidenceRoot);
    const owner = readOwnerStorageBinding(layout);
    const processAudit = readWindowsProcessAudit(layout.evidenceRoot);
    const completion = readCompletionAudit(layout.evidenceRoot);
    const completedAt = processAudit.checkedAt;
    const retainUntil = new Date(Date.parse(completedAt) + owner.retentionDays * 86_400_000)
      .toISOString();
    const retainedFiles = retainedFileDigests(layout.evidenceRoot, completion);
    writeAtomicJsonEvidence({
      root: layout.evidenceRoot,
      value: {
        schemaVersion: 1,
        evidenceRevision: "s2-run-storage-manifest-v1",
        disposition: "retained_sanitized_evidence",
        target: owner.target,
        completedAt,
        retainUntil,
        runStatus: completion.runStatus,
        monitorClassification: completion.monitorClassification,
        sourceRevision: completion.sourceRevision,
        retainedFiles,
        disposableCategories: [
          "owner_configuration",
          "runtime_state",
          "scoped_secret_records",
          "browser_profile",
        ],
      },
      sensitiveValues: [],
      label: "run-storage-manifest",
      fileName: "storage-manifest.json",
    });

    admittedDisposableTree(layout.transientRoot);
    rmSync(layout.transientRoot, { recursive: true, force: false });
    if (existsSync(layout.transientRoot)) denied("storage finalization denied");
    writeAtomicJsonEvidence({
      root: layout.evidenceRoot,
      value: {
        schemaVersion: 1,
        evidenceRevision: "s2-run-disposal-audit-v1",
        status: "pass",
        transientCleanup: "pass",
        completedAt,
      },
      sensitiveValues: [],
      label: "run-disposal-audit",
      fileName: "disposal-audit.json",
    });

    const entry: Stage2StorageCatalogEntryV1 = Object.freeze({
      runKey: layout.runKey,
      target: owner.target,
      completedAt,
      retainUntil,
      runStatus: completion.runStatus,
      monitorClassification: completion.monitorClassification,
      sourceRevision: completion.sourceRevision,
      evidenceDirectory: `${layout.runKey}/evidence`,
      transientCleanup: "pass",
    });
    const catalog = readStage2StorageCatalog(storageRoot);
    if (catalog.entries.some(({ runKey }) => runKey === layout.runKey)) {
      denied("storage finalization denied");
    }
    writeCatalog(storageRoot, [...catalog.entries, entry]);
    return Object.freeze({
      runKey: layout.runKey,
      target: owner.target,
      retainUntil,
      transientCleanup: "pass" as const,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "storage finalization denied") {
      throw error;
    }
    return denied("storage finalization denied");
  }
}

export function discardStage2RunStorage(
  request: DiscardStage2RunStorageRequest,
): DiscardStage2RunStorageResult {
  try {
    const storageRoot = admittedDirectory(request.storageRoot, false);
    const layout = existingLayout(storageRoot, request.ownerConfigPath, request.evidenceRoot);
    if (
      existsSync(join(layout.evidenceRoot, "completion-audit.json")) ||
      readStage2StorageCatalog(storageRoot).entries.some(({ runKey }) => runKey === layout.runKey)
    ) denied("storage discard denied");
    admittedDisposableTree(layout.transientRoot);
    admittedDisposableTree(layout.retainedRunRoot);
    rmSync(layout.transientRoot, { recursive: true, force: false });
    rmSync(layout.retainedRunRoot, { recursive: true, force: false });
    if (existsSync(layout.transientRoot) || existsSync(layout.retainedRunRoot)) {
      denied("storage discard denied");
    }
    return Object.freeze({
      runKey: layout.runKey,
      transientCleanup: "pass",
      retainedCleanup: "pass",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "storage discard denied") throw error;
    return denied("storage discard denied");
  }
}

export function readStage2StorageCatalog(storageRootValue: string): Stage2StorageCatalogV1 {
  const storageRoot = admittedDirectory(storageRootValue, false);
  const retained = join(storageRoot, "retained");
  if (!existsSync(retained)) {
    return Object.freeze({
      schemaVersion: 1,
      storageRevision: "s2-run-storage-v1",
      entries: Object.freeze([]),
    });
  }
  const catalogPath = join(retained, "catalog.json");
  if (!existsSync(catalogPath)) {
    return Object.freeze({
      schemaVersion: 1,
      storageRevision: "s2-run-storage-v1",
      entries: Object.freeze([]),
    });
  }
  try {
    const value = readBoundedJson(catalogPath, 256 * 1024) as Stage2StorageCatalogV1;
    if (
      value.schemaVersion !== 1 ||
      value.storageRevision !== "s2-run-storage-v1" ||
      !Array.isArray(value.entries) ||
      value.entries.length > 2_048
    ) denied("storage catalog denied");
    const entries = value.entries.map(exactCatalogEntry);
    return Object.freeze({
      schemaVersion: 1,
      storageRevision: "s2-run-storage-v1",
      entries: Object.freeze(entries),
    });
  } catch {
    return denied("storage catalog denied");
  }
}

export function inventoryStage2RunStorage(
  storageRootValue: string,
): Stage2StorageInventoryV1 {
  const storageRoot = admittedDirectory(storageRootValue, false);
  const transient = inventoryParent(join(storageRoot, "transient"));
  const retained = inventoryParent(join(storageRoot, "retained"), new Set(["catalog.json"]));
  const cataloged = new Set(
    readStage2StorageCatalog(storageRoot).entries.map(({ runKey }) => runKey),
  );
  const runKeys = [...new Set([...transient.runKeys, ...retained.runKeys, ...cataloged])]
    .sort();
  const counts = {
    finalized: 0,
    readyToFinalize: 0,
    unfinished: 0,
    legacyRetained: 0,
    invalid: 0,
    unmanagedEntries: transient.unmanagedEntries + retained.unmanagedEntries,
  };
  const runs = runKeys.map((runKey) => {
    const hasTransient = transient.runKeys.has(runKey);
    const hasRetained = retained.runKeys.has(runKey);
    const isCataloged = cataloged.has(runKey);
    const completionPath = join(
      storageRoot,
      "retained",
      runKey,
      "evidence",
      "completion-audit.json",
    );
    const hasCompletion = exactInventoryFile(completionPath);
    let disposition: Stage2StorageInventoryV1["runs"][number]["disposition"];
    if (isCataloged && hasRetained && !hasTransient) {
      counts.finalized += 1;
      disposition = "finalized_stays";
    } else if (!isCataloged && hasTransient && hasRetained && hasCompletion) {
      counts.readyToFinalize += 1;
      disposition = "ready_to_finalize";
    } else if (!isCataloged && hasTransient && hasRetained && !hasCompletion) {
      counts.unfinished += 1;
      disposition = "unfinished_goes_after_exact_discard";
    } else if (!isCataloged && !hasTransient && hasRetained) {
      counts.legacyRetained += 1;
      disposition = "legacy_retained_review";
    } else {
      counts.invalid += 1;
      disposition = "invalid_review";
    }
    return Object.freeze({ runKey, disposition });
  });
  return Object.freeze({
    schemaVersion: 1,
    inventoryRevision: "s2-run-storage-inventory-v1",
    counts: Object.freeze(counts),
    runs: Object.freeze(runs),
  });
}

function inventoryParent(
  path: string,
  ignoredFiles: ReadonlySet<string> = new Set(),
): { readonly runKeys: ReadonlySet<string>; readonly unmanagedEntries: number } {
  if (!existsSync(path)) return { runKeys: new Set(), unmanagedEntries: 0 };
  const root = admittedDirectory(path, false);
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.length > 2_049) denied("storage inventory denied");
  const runKeys = new Set<string>();
  let unmanagedEntries = 0;
  for (const entry of entries) {
    if (ignoredFiles.has(entry.name) && entry.isFile()) continue;
    if (entry.isDirectory() && RUN_KEY.test(entry.name)) {
      const child = join(root, entry.name);
      if (lstatSync(child).isSymbolicLink()) denied("storage inventory denied");
      admittedDirectory(child, false);
      runKeys.add(entry.name);
      continue;
    }
    unmanagedEntries += 1;
  }
  return { runKeys, unmanagedEntries };
}

function exactInventoryFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || status.size < 1 || status.size > 16 * 1024) {
    denied("storage inventory denied");
  }
  return true;
}

export function rebuildStage2StorageCatalog(storageRootValue: string): Stage2StorageCatalogV1 {
  const storageRoot = admittedDirectory(storageRootValue, false);
  const retained = admittedDirectory(join(storageRoot, "retained"), false);
  const directoryEntries = readdirSync(retained, { withFileTypes: true });
  if (directoryEntries.length > 2_049) denied("storage catalog rebuild denied");
  const entries: Stage2StorageCatalogEntryV1[] = [];
  for (const directoryEntry of directoryEntries) {
    if (directoryEntry.name === "catalog.json" && directoryEntry.isFile()) continue;
    if (!directoryEntry.isDirectory() || !RUN_KEY.test(directoryEntry.name)) {
      denied("storage catalog rebuild denied");
    }
    const runKey = directoryEntry.name;
    const evidenceRoot = admittedDirectory(join(retained, runKey, "evidence"), false);
    const manifest = readBoundedJson(
      join(evidenceRoot, "storage-manifest.json"),
      64 * 1024,
    ) as Record<string, unknown>;
    const disposal = readBoundedJson(
      join(evidenceRoot, "disposal-audit.json"),
      16 * 1024,
    ) as Record<string, unknown>;
    const target = object(manifest.target) as unknown as Stage2StorageTarget;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.evidenceRevision !== "s2-run-storage-manifest-v1" ||
      manifest.disposition !== "retained_sanitized_evidence" ||
      disposal.schemaVersion !== 1 ||
      disposal.evidenceRevision !== "s2-run-disposal-audit-v1" ||
      disposal.status !== "pass" ||
      disposal.transientCleanup !== "pass" ||
      disposal.completedAt !== manifest.completedAt
    ) denied("storage catalog rebuild denied");
    verifyManifestRetainedFiles(evidenceRoot, manifest.retainedFiles);
    entries.push(exactCatalogEntry({
      runKey,
      target,
      completedAt: manifest.completedAt as string,
      retainUntil: manifest.retainUntil as string,
      runStatus: manifest.runStatus as Stage2StorageCatalogEntryV1["runStatus"],
      monitorClassification: manifest.monitorClassification as string,
      sourceRevision: manifest.sourceRevision as string,
      evidenceDirectory: `${runKey}/evidence`,
      transientCleanup: "pass",
    }));
  }
  writeCatalog(storageRoot, entries);
  return readStage2StorageCatalog(storageRoot);
}

export function sweepExpiredStage2RetainedStorage(request: {
  readonly storageRoot: string;
  readonly now: string;
}): {
  readonly removed: number;
  readonly retained: number;
  readonly replayClaimsRemoved: number;
  readonly replayClaimsRetained: number;
} {
  if (!canonicalTimestamp(request.now)) denied("storage retention sweep denied");
  const storageRoot = admittedDirectory(request.storageRoot, false);
  const catalog = readStage2StorageCatalog(storageRoot);
  const retainedParent = join(storageRoot, "retained");
  const kept: Stage2StorageCatalogEntryV1[] = [];
  let removed = 0;
  for (const entry of catalog.entries) {
    if (Date.parse(entry.retainUntil) > Date.parse(request.now)) {
      kept.push(entry);
      continue;
    }
    const runRoot = join(retainedParent, entry.runKey);
    const evidenceRoot = join(runRoot, "evidence");
    try {
      if (
        !samePath(resolve(runRoot), runRoot) ||
        !existsSync(evidenceRoot) ||
        !existsSync(join(evidenceRoot, "storage-manifest.json")) ||
        !existsSync(join(evidenceRoot, "disposal-audit.json"))
      ) denied("storage retention sweep denied");
      admittedDisposableTree(runRoot);
      rmSync(runRoot, { recursive: true, force: false });
      removed += 1;
    } catch {
      return denied("storage retention sweep denied");
    }
  }
  writeCatalog(storageRoot, kept);
  const replayClaims = sweepExpiredVerificationReplayClaims(
    join(storageRoot, "bindings", "verification-consumption"),
    request.now,
  );
  return Object.freeze({
    removed,
    retained: kept.length,
    replayClaimsRemoved: replayClaims.removed,
    replayClaimsRetained: replayClaims.retained,
  });
}

const WINDOWS_STORAGE_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$items = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($null -eq $items -or $items.Count -lt 1 -or $items.Count -gt 16) { throw 'invalid input' }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allow = [System.Security.AccessControl.AccessControlType]::Allow
foreach ($item in $items) {
  $path = [string]$item.path
  $directory = [bool]$item.directory
  $attributes = [IO.File]::GetAttributes($path)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
  if ($directory -ne (($attributes -band [IO.FileAttributes]::Directory) -ne 0)) { throw 'kind' }
  if ($directory) {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($current)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($current, 'FullControl', $inherit, $propagation, $allow))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', $inherit, $propagation, $allow))
    [IO.Directory]::SetAccessControl($path, $acl)
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($current)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($current, 'FullControl', $allow))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', $allow))
    [IO.File]::SetAccessControl($path, $acl)
  }
}
[Console]::OpenStandardOutput().Write([byte[]](72,83,65,80,1), 0, 5)
`;

const localModeProtector: Stage2StorageProtector = Object.freeze({
  async protect(paths: readonly Stage2StoragePath[]) {
    if (process.platform !== "win32") {
      for (const item of paths) chmodSync(item.path, item.directory ? 0o700 : 0o600);
      return;
    }
    const payload = Buffer.from(JSON.stringify(paths), "utf8");
    try {
      if (payload.byteLength > 32 * 1024) throw new Error("storage ACL protection failed");
      const result = spawnSync(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          WINDOWS_STORAGE_ACL_SCRIPT,
        ],
        {
          input: payload,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 10_000,
          maxBuffer: 64,
          encoding: null,
          env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
        },
      );
      if (
        result.error !== undefined || result.signal !== null || result.status !== 0 ||
        !Buffer.isBuffer(result.stdout) ||
        !result.stdout.equals(Buffer.from([72, 83, 65, 80, 1]))
      ) throw new Error("storage ACL protection failed");
      result.stdout.fill(0);
    } finally {
      payload.fill(0);
    }
  },
});

function existingLayout(
  storageRoot: string,
  ownerConfigPathValue: string,
  evidenceRootValue: string,
): Stage2RunStorageLayout {
  const ownerConfigPath = admittedFile(ownerConfigPathValue, 1024 * 1024);
  const transientRoot = dirname(ownerConfigPath);
  const runKey = basename(transientRoot);
  if (!RUN_KEY.test(runKey)) denied("storage finalization denied");
  const expectedTransient = join(storageRoot, "transient", runKey);
  const retainedRunRoot = join(storageRoot, "retained", runKey);
  const evidenceRoot = admittedDirectory(evidenceRootValue, false);
  if (
    !samePath(transientRoot, expectedTransient) ||
    !samePath(evidenceRoot, join(retainedRunRoot, "evidence")) ||
    basename(ownerConfigPath) !== "owner-input.json"
  ) denied("storage finalization denied");
  const descriptor = readBoundedJson(join(transientRoot, "storage-layout.json"), 16 * 1024) as Record<string, unknown>;
  if (
    descriptor.schemaVersion !== 1 ||
    descriptor.storageRevision !== "s2-run-storage-v1" ||
    descriptor.runKey !== runKey ||
    Object.keys(descriptor).length !== 3
  ) denied("storage finalization denied");
  return frozenLayout({
    storageRoot,
    recipientBindingId: readPersistentRecipientBinding(storageRoot),
    verificationConsumptionRoot: join(
      storageRoot,
      "bindings",
      "verification-consumption",
    ),
    runKey,
    transientRoot,
    ownerConfigPath,
    runtimeRoot: join(transientRoot, "runtime"),
    secretsRoot: join(transientRoot, "secrets"),
    retainedRunRoot,
    evidenceRoot,
  });
}

function readOwnerStorageBinding(layout: Stage2RunStorageLayout): {
  readonly target: Stage2StorageTarget;
  readonly retentionDays: 30;
} {
  const owner = readBoundedJson(layout.ownerConfigPath, 1024 * 1024) as Record<string, unknown>;
  const target = object(owner.target);
  const roots = object(owner.roots);
  const runtime = object(roots.runtime);
  const secrets = object(roots.secrets);
  const evidence = object(roots.evidence);
  const policy = object(owner.policy);
  const host = target.host;
  const tenant = target.tenant;
  const posting = target.posting;
  const url = target.url;
  if (
    typeof host !== "string" || !TARGET_HOST.test(host) ||
    typeof tenant !== "string" || !TARGET_TENANT.test(tenant) ||
    typeof posting !== "string" || !TARGET_POSTING.test(posting) ||
    typeof url !== "string" ||
    runtime.path !== layout.runtimeRoot ||
    secrets.path !== layout.secretsRoot ||
    evidence.path !== layout.evidenceRoot ||
    policy.cleanupLeaseHours !== 24 ||
    policy.retentionDays !== 30
  ) denied("storage finalization denied");
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" || parsed.host !== host ||
      host.split(".")[0] !== tenant ||
      posting !== posting.toUpperCase() ||
      !parsed.pathname.split("/").at(-1)?.toUpperCase().endsWith(`_${posting}`)
    ) denied("storage finalization denied");
  } catch {
    denied("storage finalization denied");
  }
  return Object.freeze({
    target: Object.freeze({ host, tenant, posting }),
    retentionDays: 30,
  });
}

function readCompletionAudit(root: string): {
  readonly sourceRevision: string;
  readonly runStatus: "passed" | "blocked" | "failed";
  readonly monitorClassification: string;
  readonly allowedRootFiles: ReadonlySet<string>;
  readonly nestedEvidenceFiles: readonly string[];
  readonly terminalArtifactSha256: string | null;
} {
  const value = readBoundedJson(join(root, "completion-audit.json"), 16 * 1024) as Record<string, unknown>;
  const common =
    value.schemaVersion === 1 &&
    value.status === "pass" &&
    typeof value.sourceRevision === "string" &&
    /^[0-9a-f]{40}$/u.test(value.sourceRevision) &&
    typeof value.monitorClassification === "string" &&
    value.processCleanup === "pass" &&
    value.privacyScan === "pass" &&
    value.submitActivated === false;
  const accountAccess =
    value.evidenceRevision === "s2-account-access-completion-v1" &&
    value.monitor === "acknowledged" &&
    ["passed", "blocked", "failed"].includes(value.runStatus as string);
  const accountVerified =
    value.evidenceRevision === "s2-account-verified-completion-v2" &&
    value.monitor === "acknowledged" &&
    value.runStatus === "passed" &&
    value.monitorClassification === "application_ready" &&
    value.acceptance === "present" &&
    ((value.verificationProof === "gmail_candidate_consumed" &&
      value.provider === "gmail-api-v1" && value.consumedCandidateCount === 1) ||
    (value.verificationProof === "credential_sign_in" &&
      value.provider === "workday-auth" && value.consumedCandidateCount === 0) ||
    (value.verificationProof === "application_state_observed" &&
      value.provider === "workday-state" && value.consumedCandidateCount === 0)) &&
    value.messageBodyRetained === false;
  let allowedRootFiles: ReadonlySet<string> = accountAccess
    ? ACCOUNT_ACCESS_RETAINED_FILES
    : ACCOUNT_VERIFIED_RETAINED_FILES;
  let nestedEvidenceFiles: readonly string[] = Object.freeze([]);
  let terminalArtifactSha256: string | null = null;
  let review = false;
  let applicationFailure = false;
  if (value.evidenceRevision === "s2-review-completion-v1") {
    const inspection = inspectStage2ReviewCompletion(root);
    review = JSON.stringify(value) === JSON.stringify(inspection.audit);
    allowedRootFiles = REVIEW_RETAINED_FILES;
    nestedEvidenceFiles = Object.freeze([
      ...inspection.realEvidenceFiles,
      ...inspection.monitorFiles,
    ].sort());
    terminalArtifactSha256 = typeof value.terminalArtifactSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(value.terminalArtifactSha256)
      ? value.terminalArtifactSha256
      : null;
  }
  if (value.evidenceRevision === "s2-application-failure-completion-v1") {
    const inspection = inspectStage2ApplicationFailureCompletion(root);
    applicationFailure = JSON.stringify(value) === JSON.stringify(inspection.audit);
    allowedRootFiles = APPLICATION_FAILURE_RETAINED_FILES;
    nestedEvidenceFiles = inspection.nestedEvidenceFiles;
    terminalArtifactSha256 = typeof value.terminalArtifactSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(value.terminalArtifactSha256)
      ? value.terminalArtifactSha256
      : null;
  }
  if (
    !common ||
    review && (typeof value.terminalArtifactSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.terminalArtifactSha256)) ||
    (applicationFailure && terminalArtifactSha256 === null) ||
    (!accountAccess && !accountVerified && !review && !applicationFailure)
  ) {
    denied("storage finalization denied");
  }
  return Object.freeze({
    sourceRevision: value.sourceRevision as string,
    runStatus: value.runStatus as "passed" | "blocked" | "failed",
    monitorClassification: value.monitorClassification as string,
    allowedRootFiles,
    nestedEvidenceFiles,
    terminalArtifactSha256,
  });
}

function retainedFileDigests(
  root: string,
  completion: ReturnType<typeof readCompletionAudit>,
): readonly {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}[] {
  const names = readdirSync(root).sort();
  const nestedDirectories = new Set(
    completion.nestedEvidenceFiles.map((file) => {
      const separator = file.indexOf("/");
      if (separator < 1) denied("storage finalization denied");
      return file.slice(0, separator);
    }),
  );
  if (
    names.length < 2 || names.length > completion.allowedRootFiles.size + nestedDirectories.size ||
    names.some((name) => !completion.allowedRootFiles.has(name) && !nestedDirectories.has(name)) ||
    [...nestedDirectories].some((name) => !names.includes(name)) ||
    !names.includes("completion-audit.json") ||
    !names.includes("process-audit.json") ||
    completion.terminalArtifactSha256 !== null &&
      !names.includes("terminal-artifact.json")
  ) denied("storage finalization denied");
  for (const directoryName of nestedDirectories) {
    const expectedNames = completion.nestedEvidenceFiles
      .filter((file) => file.startsWith(`${directoryName}/`))
      .map((file) => file.slice(directoryName.length + 1))
      .sort();
    if (
      expectedNames.some((name) => name.length < 1 || name.includes("/")) ||
      readdirSync(admittedDirectory(join(root, directoryName), false)).sort().join("\0") !==
        expectedNames.join("\0")
    ) denied("storage finalization denied");
  }
  const files = [
    ...names.filter((name) => !nestedDirectories.has(name)),
    ...completion.nestedEvidenceFiles,
  ].sort();
  if (completion.terminalArtifactSha256 !== null) {
    const terminalPath = join(root, "terminal-artifact.json");
    readStage2TerminalArtifact(root);
    if (createHash("sha256").update(readFileSync(terminalPath)).digest("hex") !==
        completion.terminalArtifactSha256) {
      denied("storage finalization denied");
    }
  }
  return Object.freeze(files.map((file) => {
    const path = admittedFile(join(root, file), 12 * 1024 * 1024);
    const bytes = readFileSync(path);
    try {
      if (file === "profile-field-learning.json" ||
          file === "profile-field-learning-02.json") {
        try {
          admitProfileFieldLearningEvidence(JSON.parse(bytes.toString("utf8")));
        } catch {
          denied("storage finalization denied");
        }
      }
      if (file === "question-answer-learning.json") {
        try {
          admitQuestionAnswerLearningEvidence(JSON.parse(bytes.toString("utf8")));
        } catch {
          denied("storage finalization denied");
        }
      }
      if (file === "pending-profile-questions.json") {
        try {
          admitPendingProfileQuestionsEvidence(JSON.parse(bytes.toString("utf8")));
        } catch {
          denied("storage finalization denied");
        }
      }
      return Object.freeze({
        file,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      });
    } finally {
      bytes.fill(0);
    }
  }));
}

function writeCatalog(storageRoot: string, entriesValue: readonly Stage2StorageCatalogEntryV1[]): void {
  const retained = admittedDirectory(join(storageRoot, "retained"), false);
  const entries = [...entriesValue].map(exactCatalogEntry).sort((left, right) =>
    right.completedAt.localeCompare(left.completedAt)
  );
  const target = join(retained, "catalog.json");
  const partial = join(retained, `.catalog-${randomBytes(16).toString("hex")}.partial`);
  const payload = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    storageRevision: "s2-run-storage-v1",
    entries,
  }, null, 2)}\n`, "utf8");
  if (payload.byteLength > 256 * 1024) denied("storage catalog denied");
  try {
    writeFileSync(partial, payload, { flag: "wx", mode: 0o600 });
    chmodSync(partial, 0o600);
    renameSync(partial, target);
  } catch {
    denied("storage catalog denied");
  } finally {
    payload.fill(0);
    rmSync(partial, { force: true });
  }
}

function exactCatalogEntry(value: Stage2StorageCatalogEntryV1): Stage2StorageCatalogEntryV1 {
  if (
    !RUN_KEY.test(value.runKey) ||
    !TARGET_HOST.test(value.target?.host) ||
    !TARGET_TENANT.test(value.target?.tenant) ||
    !TARGET_POSTING.test(value.target?.posting) ||
    !canonicalTimestamp(value.completedAt) ||
    !canonicalTimestamp(value.retainUntil) ||
    Date.parse(value.retainUntil) <= Date.parse(value.completedAt) ||
    !["passed", "blocked", "failed"].includes(value.runStatus) ||
    typeof value.monitorClassification !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.sourceRevision) ||
    value.evidenceDirectory !== `${value.runKey}/evidence` ||
    value.transientCleanup !== "pass"
  ) denied("storage catalog denied");
  return Object.freeze({ ...value, target: Object.freeze({ ...value.target }) });
}

function admittedDisposableTree(root: string): void {
  const pending = [admittedDirectory(root, false)];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const name of readdirSync(current)) {
      count += 1;
      if (count > 512 || name === "." || name === "..") denied("storage finalization denied");
      const path = join(current, name);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) denied("storage finalization denied");
      if (status.isDirectory()) pending.push(admittedDirectory(path, false));
      else if (!status.isFile() || status.size > 12 * 1024 * 1024) {
        denied("storage finalization denied");
      }
    }
  }
}

function admittedDirectory(value: string, create: boolean): string {
  try {
    if (!isAbsolute(value) || normalize(value) !== value) throw new Error();
    if (create && !existsSync(value)) mkdirSync(value, { recursive: true, mode: 0o700 });
    if (lstatSync(value).isSymbolicLink() || !statSync(value).isDirectory()) throw new Error();
    const canonical = realpathSync.native(value);
    if (!samePath(canonical, resolve(value))) throw new Error();
    return canonical;
  } catch {
    return denied("storage path denied");
  }
}

function admittedFile(value: string, maximumBytes: number): string {
  try {
    if (!isAbsolute(value) || normalize(value) !== value) throw new Error();
    const status = lstatSync(value);
    if (status.isSymbolicLink() || !status.isFile() || status.size < 1 || status.size > maximumBytes) {
      throw new Error();
    }
    const canonical = realpathSync.native(value);
    if (!samePath(canonical, resolve(value))) throw new Error();
    return canonical;
  } catch {
    return denied("storage path denied");
  }
}

function readBoundedJson(pathValue: string, maximumBytes: number): unknown {
  const path = admittedFile(pathValue, maximumBytes);
  const bytes = readFileSync(path);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    bytes.fill(0);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return denied("storage finalization denied");
  }
  return value as Record<string, unknown>;
}

function generatedRunKey(): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `run_${day}_${randomBytes(8).toString("hex")}`;
}

async function persistentRecipientBinding(
  storageRoot: string,
  protector: Stage2StorageProtector,
): Promise<string> {
  const directory = join(storageRoot, "bindings");
  const path = join(directory, "recipient-binding.json");
  const verificationConsumptionRoot = join(directory, "verification-consumption");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(verificationConsumptionRoot, { recursive: true, mode: 0o700 });
  let created = false;
  if (!existsSync(path)) {
    const payload = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      bindingRevision: "s2-recipient-binding-v1",
      recipientBindingId: `recipient_${randomBytes(16).toString("hex")}`,
    }), "utf8");
    try {
      writeFileSync(path, payload, { flag: "wx", mode: 0o600 });
      created = true;
    } catch {
      if (!existsSync(path)) denied("storage preparation denied");
    } finally {
      payload.fill(0);
    }
  }
  try {
    await protector.protect([
      { path: directory, directory: true },
      { path: verificationConsumptionRoot, directory: true },
      { path, directory: false },
    ]);
    return readPersistentRecipientBinding(storageRoot);
  } catch {
    if (created) rmSync(path, { force: true });
    return denied("storage preparation denied");
  }
}

function readPersistentRecipientBinding(storageRoot: string): string {
  const value = readBoundedJson(
    join(storageRoot, "bindings", "recipient-binding.json"),
    4 * 1024,
  ) as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(value)) !== JSON.stringify([
      "schemaVersion",
      "bindingRevision",
      "recipientBindingId",
    ]) ||
    value.schemaVersion !== 1 ||
    value.bindingRevision !== "s2-recipient-binding-v1" ||
    typeof value.recipientBindingId !== "string" ||
    !/^recipient_[a-f0-9]{32}$/u.test(value.recipientBindingId)
  ) denied("storage preparation denied");
  return value.recipientBindingId;
}

function canonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function samePath(left: string, right: string): boolean {
  const normalizePath = (value: string) => {
    const normalized = normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalizePath(left) === normalizePath(right);
}

function frozenLayout(value: Stage2RunStorageLayout): Stage2RunStorageLayout {
  return Object.freeze({ ...value });
}

function denied(message: string): never {
  throw new Error(message);
}
