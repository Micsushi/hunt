import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

import { readStage2TerminalArtifact } from "../../acceptance/s2-terminal-artifact.ts";
import { writeAtomicJsonEvidence } from "../../live/evidence/private/atomic-json-evidence.ts";
import { admitProfileFieldLearningEvidence } from "../../live/evidence/profile-field-learning.ts";
import {
  admitPendingProfileQuestionsEvidence,
  admitQuestionAnswerLearningEvidence,
} from "../../live/evidence/question-answer-learning.ts";
import { readWindowsProcessAudit } from "../../live/evidence/windows-process-audit.ts";

const ROOT_FILES = new Set([
  "acceptance.json", "application-walk-acceptance.json", "page-local-inspection.json",
  "pending-profile-questions.json", "process-audit.json", "profile-field-learning.json",
  "profile-field-learning-02.json", "question-answer-learning.json", "terminal-artifact.json",
  "value-free-trace.ndjson", "failure-source-binding.json",
]);
const NESTED_DIRECTORIES = new Set(["auth-monitor", "monitor"]);

export interface Stage2ApplicationFailureBindingV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-application-failure-source-binding-v1";
  readonly sourceRevision: string;
  readonly configSha256: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
}

export interface Stage2ApplicationFailureCompletionAuditV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-application-failure-completion-v1";
  readonly status: "pass";
  readonly sourceRevision: string;
  readonly journeyId: string;
  readonly runStatus: "blocked" | "failed";
  readonly resultCode: string;
  readonly completedPages: number;
  readonly terminalArtifactSha256: string;
  readonly retainedEvidenceFileCount: number;
  readonly retainedEvidenceChainSha256: string;
  readonly monitorFileCount: number;
  readonly monitorClassification: "application_failed" | "application_blocked";
  readonly processCleanup: "pass";
  readonly privacyScan: "pass";
  readonly submitActivated: false;
}

export function writeStage2ApplicationFailureBinding(
  root: string,
  binding: Stage2ApplicationFailureBindingV1,
): string {
  admitBinding(binding);
  return writeAtomicJsonEvidence({
    root,
    value: binding,
    sensitiveValues: [],
    reviewedSha256Keys: ["configSha256"],
    label: "application failure source binding",
    fileName: "failure-source-binding.json",
  });
}

export async function auditStage2ApplicationFailureCompletion(
  rootValue: string,
): Promise<Stage2ApplicationFailureCompletionAuditV1> {
  try {
    const inspection = inspectStage2ApplicationFailureCompletion(rootValue, false);
    writeAtomicJsonEvidence({
      root: inspection.root,
      value: inspection.audit,
      sensitiveValues: [],
      reviewedSha256Keys: [
        "terminalArtifactSha256", "retainedEvidenceChainSha256",
      ],
      label: "application failure completion audit",
      fileName: "completion-audit.json",
    });
    return inspection.audit;
  } catch {
    return denied();
  }
}

export function inspectStage2ApplicationFailureCompletion(
  rootValue: string,
  requireAudit = true,
): {
  readonly root: string;
  readonly audit: Stage2ApplicationFailureCompletionAuditV1;
  readonly nestedEvidenceFiles: readonly string[];
} {
  const root = admittedRoot(rootValue);
  const terminal = readStage2TerminalArtifact(root);
  if (terminal.cleanupErrorCode !== undefined ||
      terminal.terminal.status !== "failed" && terminal.terminal.status !== "blocked" ||
      terminal.resultCode === "review_reached") denied();
  const processAudit = readWindowsProcessAudit(root);
  if (processAudit.evidenceRevision !== "s2-windows-process-audit-v2") denied();
  const binding = admitBinding(readJson(join(root, "failure-source-binding.json"), 16 * 1024));
  if (
    binding.configSha256 !== processAudit.configSha256 ||
    binding.journeyId !== processAudit.journeyId ||
    binding.targetHandleId !== processAudit.targetHandleId ||
    terminal.terminal.journeyId !== binding.journeyId
  ) denied();
  validateLearning(root);
  const inventory = evidenceInventory(root);
  if (inventory.monitorFileCount !== processAudit.monitorFileCount) denied();
  const terminalBytes = readStable(join(root, "terminal-artifact.json"), 16 * 1024);
  const audit: Stage2ApplicationFailureCompletionAuditV1 = Object.freeze({
    schemaVersion: 1,
    evidenceRevision: "s2-application-failure-completion-v1",
    status: "pass",
    sourceRevision: binding.sourceRevision,
    journeyId: binding.journeyId,
    runStatus: terminal.terminal.status,
    resultCode: terminal.resultCode,
    completedPages: terminal.terminal.completedPages,
    terminalArtifactSha256: digest(terminalBytes),
    retainedEvidenceFileCount: inventory.files.length,
    retainedEvidenceChainSha256: inventory.chainSha256,
    monitorFileCount: inventory.monitorFileCount,
    monitorClassification: terminal.terminal.status === "failed"
      ? "application_failed"
      : "application_blocked",
    processCleanup: "pass",
    privacyScan: "pass",
    submitActivated: false,
  });
  if (requireAudit) {
    const stored = readJson(join(root, "completion-audit.json"), 16 * 1024);
    if (JSON.stringify(stored) !== JSON.stringify(audit)) denied();
  }
  return Object.freeze({ root, audit, nestedEvidenceFiles: inventory.nestedFiles });
}

function evidenceInventory(root: string): {
  readonly files: readonly string[];
  readonly nestedFiles: readonly string[];
  readonly monitorFileCount: number;
  readonly chainSha256: string;
} {
  const files: string[] = [];
  const nestedFiles: string[] = [];
  let monitorFileCount = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "completion-audit.json") continue;
    if (entry.isFile()) {
      if (!ROOT_FILES.has(entry.name)) denied();
      files.push(entry.name);
      continue;
    }
    if (!entry.isDirectory() || !NESTED_DIRECTORIES.has(entry.name)) denied();
    const directory = admittedDirectory(join(root, entry.name));
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (!child.isFile() || !/^\d{4}-[a-z0-9_-]{3,180}(?:\.ack\.json|\.request\.json|\.taxonomy\.json|\.png)$/u.test(child.name)) {
        denied();
      }
      nestedFiles.push(`${entry.name}/${child.name}`);
      monitorFileCount += 1;
    }
  }
  const ordered = [...files, ...nestedFiles].sort();
  if (!files.includes("process-audit.json") || !files.includes("terminal-artifact.json") ||
      !files.includes("failure-source-binding.json") || monitorFileCount === 0) denied();
  const chain = ordered.map((file) => {
    const bytes = readStable(join(root, ...file.split("/")), 12 * 1024 * 1024);
    return `${file}:${digest(bytes)}\n`;
  }).join("");
  return Object.freeze({
    files: Object.freeze(ordered),
    nestedFiles: Object.freeze(nestedFiles.sort()),
    monitorFileCount,
    chainSha256: digest(Buffer.from(chain, "utf8")),
  });
}

function validateLearning(root: string): void {
  for (const name of ["profile-field-learning.json", "profile-field-learning-02.json"]) {
    try {
      admitProfileFieldLearningEvidence(readJson(join(root, name), 256 * 1024) as
        Parameters<typeof admitProfileFieldLearningEvidence>[0]);
    } catch (error) {
      if (error instanceof Error && /ENOENT/u.test(String((error as NodeJS.ErrnoException).code))) continue;
      denied();
    }
  }
  try {
    admitQuestionAnswerLearningEvidence(readJson(join(root, "question-answer-learning.json"), 256 * 1024) as
      Parameters<typeof admitQuestionAnswerLearningEvidence>[0]);
  } catch (error) {
    if (!(error instanceof Error && /ENOENT/u.test(String((error as NodeJS.ErrnoException).code)))) denied();
  }
  try {
    admitPendingProfileQuestionsEvidence(readJson(join(root, "pending-profile-questions.json"), 256 * 1024) as
      Parameters<typeof admitPendingProfileQuestionsEvidence>[0]);
  } catch (error) {
    if (!(error instanceof Error && /ENOENT/u.test(String((error as NodeJS.ErrnoException).code)))) denied();
  }
}

function admitBinding(value: unknown): Stage2ApplicationFailureBindingV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied();
  const candidate = value as Record<string, unknown>;
  const keys = ["schemaVersion", "evidenceRevision", "sourceRevision", "configSha256", "journeyId", "targetHandleId"];
  if (Object.keys(candidate).join("\0") !== keys.join("\0") ||
      candidate.schemaVersion !== 1 ||
      candidate.evidenceRevision !== "s2-application-failure-source-binding-v1" ||
      typeof candidate.sourceRevision !== "string" || !/^[0-9a-f]{40}$/u.test(candidate.sourceRevision) ||
      typeof candidate.configSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.configSha256) ||
      typeof candidate.journeyId !== "string" || !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(candidate.journeyId) ||
      typeof candidate.targetHandleId !== "string" || !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(candidate.targetHandleId)) denied();
  return Object.freeze(candidate as unknown as Stage2ApplicationFailureBindingV1);
}

function readJson(path: string, maximum: number): unknown {
  return JSON.parse(readStable(path, maximum).toString("utf8"));
}

function readStable(path: string, maximum: number): Buffer {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 ||
      before.size < 2 || before.size > maximum ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))) denied();
  const bytes = readFileSync(path);
  const after = statSync(path);
  if (after.size !== bytes.byteLength || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) denied();
  return bytes;
}

function admittedRoot(value: string): string {
  const root = admittedDirectory(value);
  if (basename(root) !== "evidence") denied();
  return root;
}

function admittedDirectory(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
      !statSync(value).isDirectory() || comparable(realpathSync.native(value)) !== comparable(resolve(value))) denied();
  return realpathSync.native(value);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new Error("application failure completion audit denied");
}
