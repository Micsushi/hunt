import {
  parseEventEnvelopeV3,
  parseTerminalResultV4,
} from "../../contracts/index.ts";
import type {
  EventEnvelopeV3,
  JourneyId,
  TerminalResultV4,
} from "../../contracts/index.ts";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

export interface AccountAccessDiagnosticsEvidence {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-account-access-diagnostics-v1";
  readonly checkpoint: "account_access";
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly journeyId: JourneyId;
  readonly status: "passed" | "blocked" | "failed";
  readonly completedSteps: number;
  readonly events: readonly EventEnvelopeV3[];
  readonly terminal: TerminalResultV4 | null;
  readonly submitActivated: false;
  readonly privacyScan: "pass";
  readonly cleanup: "pass" | "failed";
}

export interface WriteAccountAccessDiagnosticsRequest {
  readonly root: string;
  readonly diagnostics: AccountAccessDiagnosticsEvidence;
  readonly sensitiveValues: readonly string[];
}

export type AccountAccessDiagnosticsDocument = AccountAccessDiagnosticsEvidence;

export async function writeAccountAccessDiagnostics(
  request: WriteAccountAccessDiagnosticsRequest,
): Promise<void> {
  const diagnostics = exactDiagnostics(request.diagnostics);
  writeAtomicJsonEvidence({
    root: request.root,
    value: diagnostics,
    sensitiveValues: request.sensitiveValues,
    label: "account-access-diagnostics",
    fileName: "diagnostics.json",
  });
}

export function readAccountAccessDiagnostics(
  root: string,
): AccountAccessDiagnosticsDocument {
  const canonicalRoot = admittedRoot(root);
  const path = join(canonicalRoot, "diagnostics.json");
  let value: unknown;
  try {
    if (
      lstatSync(path).isSymbolicLink() ||
      !statSync(path).isFile() ||
      statSync(path).size < 2 ||
      statSync(path).size > 64 * 1024 ||
      comparable(realpathSync.native(path)) !== comparable(resolve(path))
    ) denied();
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return denied();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return denied();
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "schemaVersion",
    "evidenceRevision",
    "checkpoint",
    "sourceRevision",
    "revisionId",
    "journeyId",
    "status",
    "completedSteps",
    "events",
    "terminal",
    "submitActivated",
    "privacyScan",
    "cleanup",
  ];
  const keys = Object.keys(record);
  if (
    keys.length !== expected.length ||
    expected.some((key, index) => keys[index] !== key)
  ) denied();
  const diagnostics = exactDiagnostics({
    schemaVersion: record.schemaVersion,
    evidenceRevision: record.evidenceRevision,
    checkpoint: record.checkpoint,
    sourceRevision: record.sourceRevision,
    revisionId: record.revisionId,
    journeyId: record.journeyId,
    status: record.status,
    completedSteps: record.completedSteps,
    events: record.events,
    terminal: record.terminal,
    submitActivated: record.submitActivated,
    privacyScan: record.privacyScan,
    cleanup: record.cleanup,
  } as AccountAccessDiagnosticsEvidence);
  return diagnostics;
}

function exactDiagnostics(
  value: AccountAccessDiagnosticsEvidence,
): AccountAccessDiagnosticsEvidence {
  const expected = [
    "schemaVersion",
    "evidenceRevision",
    "checkpoint",
    "sourceRevision",
    "revisionId",
    "journeyId",
    "status",
    "completedSteps",
    "events",
    "terminal",
    "submitActivated",
    "privacyScan",
    "cleanup",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key, index) => keys[index] !== key) ||
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-account-access-diagnostics-v1" ||
    value.checkpoint !== "account_access" ||
    !/^[0-9a-f]{40}$/u.test(value.sourceRevision) ||
    !/^revision_[A-Za-z0-9_-]{16,64}$/u.test(value.revisionId) ||
    !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
    !["passed", "blocked", "failed"].includes(value.status) ||
    !Number.isInteger(value.completedSteps) ||
    value.completedSteps < 0 ||
    value.completedSteps > 64 ||
    !Array.isArray(value.events) ||
    value.events.length > 128 ||
    value.submitActivated !== false ||
    value.privacyScan !== "pass" ||
    (value.cleanup !== "pass" && value.cleanup !== "failed")
  ) denied();

  const events = value.events.map((event) => {
    let parsed;
    try {
      parsed = parseEventEnvelopeV3(event);
    } catch {
      return denied();
    }
    if (
      parsed.journeyId !== value.journeyId ||
      !canonicalTimestamp(parsed.at)
    ) denied();
    return parsed;
  });
  if (
    events.filter(({ kind }) => kind === "step_completed").length !==
      value.completedSteps
  ) denied();

  let terminal = null;
  if (value.terminal !== null) {
    try {
      terminal = parseTerminalResultV4(value.terminal);
    } catch {
      return denied();
    }
    if (
      terminal.journeyId !== value.journeyId ||
      terminal.status !== value.status
    ) denied();
  } else if (value.status !== "passed") {
    denied();
  }
  if (value.status === "passed" && terminal !== null) denied();

  return Object.freeze({
    ...value,
    events: Object.freeze(events),
    terminal,
  }) as AccountAccessDiagnosticsEvidence;
}

function canonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function admittedRoot(value: string): string {
  try {
    if (
      !isAbsolute(value) ||
      normalize(value) !== value ||
      lstatSync(value).isSymbolicLink() ||
      !statSync(value).isDirectory() ||
      comparable(realpathSync.native(value)) !== comparable(resolve(value))
    ) denied();
    return realpathSync.native(value);
  } catch {
    return denied();
  }
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new Error("account-access-diagnostics evidence denied");
}
