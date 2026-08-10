import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import {
  captureStage2Config,
  readStage2AcceptanceManifest,
  readStage2ReviewAcceptance,
} from "../../acceptance/s2-local.ts";
import type { Stage2ConfigCapture } from "../../acceptance/s2-gate.ts";
import {
  readAccountVerifiedEvidence,
} from "../../live/evidence/account-verified-evidence.ts";
import {
  admitApplicationWalkAcceptance,
  type ApplicationWalkAcceptanceV1,
} from "../../live/evidence/application-walk-evidence.ts";
import { writeAtomicJsonEvidence } from "../../live/evidence/private/atomic-json-evidence.ts";
import { readWindowsProcessAudit } from "../../live/evidence/windows-process-audit.ts";
import {
  readStage2AuthMonitorChain,
  readStage2ReviewMonitorChain,
} from "../../live/evidence/review-monitor-chain.ts";

const RUN_KEY = /^run_\d{8}_[a-z0-9]{16}$/u;
const REAL_EVIDENCE_FILES = [
  "real-evidence/browser-truth.json",
  "real-evidence/manifest.json",
  "real-evidence/summary.json",
] as const;

export interface Stage2ReviewCompletionAuditV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-review-completion-v1";
  readonly status: "pass";
  readonly sourceRevision: string;
  readonly journeyId: string;
  readonly runStatus: "passed";
  readonly acceptance: "present";
  readonly applicationWalk: "present";
  readonly acceptanceGate: "present";
  readonly realEvidence: "validated";
  readonly accountVerification: "present";
  readonly processBinding: "production_bound";
  readonly processAuditSha256: string;
  readonly authMonitor: "external_chain_acknowledged";
  readonly monitor: "external_chain_acknowledged";
  readonly monitorClassification: "review_verified";
  readonly processCleanup: "pass";
  readonly privacyScan: "pass";
  readonly submitPresent: true;
  readonly submitActivated: false;
}

export interface Stage2ReviewCompletionInspection {
  readonly audit: Stage2ReviewCompletionAuditV1;
  readonly realEvidenceFiles: typeof REAL_EVIDENCE_FILES;
  readonly monitorFiles: readonly string[];
}

export async function auditStage2ReviewCompletion(
  rootValue: string,
): Promise<Stage2ReviewCompletionAuditV1> {
  try {
    const inspection = inspectStage2ReviewCompletion(rootValue);
    writeAtomicJsonEvidence({
      root: admittedRoot(rootValue),
      value: inspection.audit,
      sensitiveValues: [],
      label: "review completion audit",
      fileName: "completion-audit.json",
    });
    return inspection.audit;
  } catch {
    return denied();
  }
}

export function inspectStage2ReviewCompletion(
  rootValue: string,
): Stage2ReviewCompletionInspection {
  try {
    const root = admittedRoot(rootValue);
    const config = captureStage2Config(ownerConfigPath(root));
    const account = readAccountVerifiedEvidence(root);
    const review = readStage2ReviewAcceptance(root);
    const gate = readStage2AcceptanceManifest(root);
    const application = readApplicationWalk(root);
    const packet = readRealEvidence(root);
    const processAudit = readWindowsProcessAudit(root);
    const processBytes = readStableFile(join(root, "process-audit.json"), 16 * 1024);
    const runKey = basename(dirname(root));
    if (
      processAudit.evidenceRevision !== "s2-windows-process-audit-v2" ||
      processAudit.runKey !== runKey || processAudit.journeyId !== config.journeyId ||
      processAudit.targetHandleId !== config.targetHandleId ||
      processAudit.configSha256 !== config.configSha256
    ) denied();
    const targetDigests = ownerTargetDigests(ownerConfigPath(root));
    const monitorExpected = {
      journeyId: config.journeyId,
      targetHandleId: config.targetHandleId,
      sourceRevision: review.sourceRevision,
      configSha256: config.configSha256,
      ...targetDigests,
      processLiveNonceSha256: processAudit.processLiveNonceSha256,
      processIssuedAt: processAudit.processIssuedAt,
      processCheckedAt: processAudit.checkedAt,
      processExitObservedAt: processAudit.processExitObservedAt,
      processInstanceSha256: createHash("sha256").update(
        `s2-process-instance-v1\0${processAudit.processOwnerPid}\0${processAudit.processOwnerStartedAt}`,
        "utf8",
      ).digest("hex"),
    } as const;
    const authMonitor = readStage2AuthMonitorChain(join(root, "auth-monitor"), monitorExpected);
    const monitor = readStage2ReviewMonitorChain(join(root, "monitor"), monitorExpected);
    const monitorFiles = [...authMonitor.files, ...monitor.files].sort();
    validateMonitorLedger(
      root,
      monitorFiles,
      processAudit.monitorFileCount,
      processAudit.monitorChainSha256,
    );
    if (
      !sameConfig(review, config) || !sameConfig(gate, config) ||
      account.sourceRevision !== review.sourceRevision || account.revisionId !== config.revisionId ||
      account.approvalId !== config.approvalId || account.journeyId !== config.journeyId ||
      account.targetHandleId !== config.targetHandleId ||
      review.sourceRevision !== gate.sourceRevision ||
      review.sourceRevision !== application.sourceRevision ||
      review.sourceRevision !== packet.sourceRevision ||
      application.revisionId !== config.revisionId ||
      application.approvalId !== config.approvalId ||
      application.journeyId !== config.journeyId ||
      application.targetHandleId !== config.targetHandleId ||
      packet.revisionId !== config.revisionId ||
      packet.approvalId !== config.approvalId ||
      packet.journeyId !== config.journeyId ||
      packet.requiredFieldCount !== application.pageChecks.reduce(
        (total, item) => total + item.verifiedFields,
        0,
      )
    ) denied();
    const audit: Stage2ReviewCompletionAuditV1 = Object.freeze({
      schemaVersion: 1,
      evidenceRevision: "s2-review-completion-v1",
      status: "pass",
      sourceRevision: review.sourceRevision,
      journeyId: review.journeyId,
      runStatus: "passed",
      acceptance: "present",
      applicationWalk: "present",
      acceptanceGate: "present",
      realEvidence: "validated",
      accountVerification: "present",
      processBinding: "production_bound",
      processAuditSha256: digest(processBytes),
      authMonitor: "external_chain_acknowledged",
      monitor: "external_chain_acknowledged",
      monitorClassification: "review_verified",
      processCleanup: "pass",
      privacyScan: "pass",
      submitPresent: true,
      submitActivated: false,
    });
    return Object.freeze({
      audit,
      realEvidenceFiles: REAL_EVIDENCE_FILES,
      monitorFiles: Object.freeze(monitorFiles),
    });
  } catch {
    return denied();
  }
}

function validateMonitorLedger(
  root: string,
  files: readonly string[],
  expectedCount: number,
  expectedSha256: string,
): void {
  const names = [...files].sort();
  if (names.length !== expectedCount || new Set(names).size !== names.length) denied();
  const lines = names.map((name) => `${name}:${digest(readStableFile(
    join(root, name),
    12 * 1024 * 1024,
  ))}\n`).join("");
  if (digest(Buffer.from(lines, "utf8")) !== expectedSha256) denied();
}

function readApplicationWalk(root: string): ApplicationWalkAcceptanceV1 {
  const value = JSON.parse(readStableFile(
    join(root, "application-walk-acceptance.json"),
    64 * 1024,
  ).toString("utf8")) as ApplicationWalkAcceptanceV1;
  return admitApplicationWalkAcceptance(value);
}

function readRealEvidence(root: string): {
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly requiredFieldCount: number;
} {
  const packetRoot = admittedDirectory(join(root, "real-evidence"));
  if (readdirSync(packetRoot).sort().join("\0") !==
    "browser-truth.json\0manifest.json\0summary.json") denied();
  const browserBytes = readStableFile(join(packetRoot, "browser-truth.json"), 4 * 1024);
  const manifestBytes = readStableFile(join(packetRoot, "manifest.json"), 4 * 1024);
  const summaryBytes = readStableFile(join(packetRoot, "summary.json"), 4 * 1024);
  const browser = JSON.parse(browserBytes.toString("utf8")) as Record<string, unknown>;
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const summary = JSON.parse(summaryBytes.toString("utf8")) as Record<string, unknown>;
  exactKeys(browser, [
    "schemaVersion", "observer", "page", "reviewSignatureIds", "completionEvidenceIds",
    "submitStructurallyPresent", "submitActivated",
  ]);
  if (
    browser.schemaVersion !== 1 || browser.observer !== "independent_browser" ||
    browser.page !== "review" || !validIds(browser.reviewSignatureIds, "review_signature") ||
    !validIds(browser.completionEvidenceIds, "completion_evidence") ||
    browser.submitStructurallyPresent !== true || browser.submitActivated !== false
  ) denied();
  exactKeys(manifest, [
    "schemaVersion", "manifestRevision", "sourceRevision", "configurationRevisionId",
    "configurationApprovalId", "journeyId", "sealedAt", "privacyScan", "artifactCount",
    "totalArtifactBytes", "retention", "artifacts",
  ]);
  const retention = record(manifest.retention);
  exactKeys(retention, [
    "retentionDays", "deleteAfter", "disposition", "screenshotsRetained", "rawDomRetained",
  ]);
  const sealedAt = timestamp(manifest.sealedAt);
  const expectedDeleteAfter = new Date(Date.parse(sealedAt) + 30 * 86_400_000).toISOString();
  if (
    manifest.schemaVersion !== 1 || manifest.manifestRevision !== "s2-real-evidence-manifest-v1" ||
    !revision(manifest.sourceRevision) || !opaque(manifest.configurationRevisionId, "revision") ||
    !opaque(manifest.configurationApprovalId, "approval") || !opaque(manifest.journeyId, "journey") ||
    manifest.privacyScan !== "pass" || manifest.artifactCount !== 2 ||
    manifest.totalArtifactBytes !== browserBytes.byteLength + summaryBytes.byteLength ||
    retention.retentionDays !== 30 || retention.deleteAfter !== expectedDeleteAfter ||
    retention.disposition !== "delete_after_retention" || retention.screenshotsRetained !== false ||
    retention.rawDomRetained !== false
  ) denied();
  const artifacts = manifest.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length !== 2) denied();
  const expectedArtifacts = [
    ["browser-truth.json", browserBytes],
    ["summary.json", summaryBytes],
  ] as const;
  for (const [index, [file, bytes]] of expectedArtifacts.entries()) {
    const artifact = record(artifacts[index]);
    exactKeys(artifact, ["file", "bytes", "sha256"]);
    if (
      artifact.file !== file || artifact.bytes !== bytes.byteLength ||
      artifact.sha256 !== digest(bytes)
    ) denied();
  }
  exactKeys(summary, [
    "schemaVersion", "evidenceRevision", "sourceRevision", "configurationRevisionId",
    "configurationApprovalId", "journeyId", "sealedAt", "milestones",
    "verificationSummaries", "errors", "missingEvidence", "diagnosticComparison",
  ]);
  const milestones = summary.milestones;
  const verifications = summary.verificationSummaries;
  if (
    summary.schemaVersion !== 1 || summary.evidenceRevision !== "s2-real-evidence-packet-v1" ||
    summary.sourceRevision !== manifest.sourceRevision ||
    summary.configurationRevisionId !== manifest.configurationRevisionId ||
    summary.configurationApprovalId !== manifest.configurationApprovalId ||
    summary.journeyId !== manifest.journeyId || summary.sealedAt !== sealedAt ||
    !allVerified(milestones, [
      "account_verified", "application_completed", "review_reached", "submit_guarded",
    ]) || !allVerified(verifications, [
      "account", "resume", "required_fields", "review", "submit_guard",
    ], true) || !Array.isArray(summary.errors) || summary.errors.length !== 0 ||
    !Array.isArray(summary.missingEvidence) || summary.missingEvidence.length !== 0
  ) denied();
  const comparison = record(summary.diagnosticComparison);
  exactKeys(comparison, [
    "browserTruthSha256", "reviewReached", "requiredFieldsComplete", "submitActivated",
    "matchesBrowserTruth",
  ]);
  if (
    comparison.browserTruthSha256 !== digest(browserBytes) || comparison.reviewReached !== true ||
    comparison.requiredFieldsComplete !== true || comparison.submitActivated !== false ||
    comparison.matchesBrowserTruth !== true
  ) denied();
  const required = (verifications as Record<string, unknown>[]).find(
    (item) => item.kind === "required_fields",
  );
  if (required === undefined || !Number.isSafeInteger(required.verifiedCount) ||
    (required.verifiedCount as number) < 1) denied();
  return Object.freeze({
    sourceRevision: manifest.sourceRevision,
    revisionId: manifest.configurationRevisionId,
    approvalId: manifest.configurationApprovalId,
    journeyId: manifest.journeyId,
    requiredFieldCount: required.verifiedCount as number,
  });
}

function allVerified(
  value: unknown,
  kinds: readonly string[],
  counted = false,
): boolean {
  if (!Array.isArray(value) || value.length !== kinds.length) return false;
  return kinds.every((kind, index) => {
    const item = record(value[index]);
    exactKeys(item, counted ? ["kind", "status", "verifiedCount"] : ["kind", "status"]);
    return item.kind === kind && item.status === "verified" &&
      (!counted || Number.isSafeInteger(item.verifiedCount) && (item.verifiedCount as number) > 0);
  });
}

function sameConfig(value: Stage2ConfigCapture, expected: Stage2ConfigCapture): boolean {
  return value.configSha256 === expected.configSha256 &&
    value.contractRevision === expected.contractRevision &&
    value.revisionId === expected.revisionId && value.approvalId === expected.approvalId &&
    value.journeyId === expected.journeyId && value.targetHandleId === expected.targetHandleId;
}

function ownerConfigPath(root: string): string {
  const runRoot = dirname(root);
  const runKey = basename(runRoot);
  const retained = dirname(runRoot);
  const storageRoot = dirname(retained);
  if (basename(root) !== "evidence" || basename(retained) !== "retained" || !RUN_KEY.test(runKey)) {
    denied();
  }
  return join(storageRoot, "transient", runKey, "owner-input.json");
}

function ownerTargetDigests(path: string): {
  readonly hostSha256: string;
  readonly tenantSha256: string;
  readonly postingSha256: string;
} {
  const owner = record(JSON.parse(readStableFile(path, 1024 * 1024).toString("utf8")));
  const target = record(owner.target);
  if (
    typeof target.host !== "string" || !/^[a-z0-9.-]{4,253}$/u.test(target.host) ||
    typeof target.tenant !== "string" || !/^[a-z0-9-]{2,64}$/u.test(target.tenant) ||
    typeof target.posting !== "string" || !/^[A-Za-z0-9-]{2,64}$/u.test(target.posting) ||
    target.host.split(".")[0] !== target.tenant
  ) denied();
  return Object.freeze({
    hostSha256: digest(Buffer.from(target.host, "utf8")),
    tenantSha256: digest(Buffer.from(target.tenant, "utf8")),
    postingSha256: digest(Buffer.from(target.posting, "utf8")),
  });
}

function readStableFile(path: string, maximumBytes: number): Buffer {
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 ||
    before.size < 2 || before.size > maximumBytes ||
    comparable(realpathSync.native(path)) !== comparable(resolve(path))
  ) denied();
  const bytes = readFileSync(path);
  const after = statSync(path);
  if (
    !after.isFile() || after.nlink !== 1 || after.size !== bytes.byteLength ||
    after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs
  ) denied();
  return bytes;
}

function admittedRoot(value: string): string {
  const root = admittedDirectory(value);
  if (basename(root) !== "evidence") denied();
  return root;
}

function admittedDirectory(value: string): string {
  if (
    !isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
    !statSync(value).isDirectory() ||
    comparable(realpathSync.native(value)) !== comparable(resolve(value))
  ) denied();
  return realpathSync.native(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key, index) => keys[index] !== key)) denied();
}

function validIds(value: unknown, prefix: string): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 16 &&
    new Set(value).size === value.length && value.every((item) => opaque(item, prefix));
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}

function revision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function opaque(value: unknown, prefix: string): value is string {
  return typeof value === "string" &&
    new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`, "u").test(value);
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value
  ) denied();
  return value;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new Error("review completion audit denied");
}
