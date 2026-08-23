import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { parseTerminalResultV4, type TerminalResultV4 } from "../contracts/index.ts";
import { writeAtomicJsonEvidence } from "../live/evidence/private/atomic-json-evidence.ts";

export interface Stage2TerminalArtifactV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-terminal-artifact-v1";
  readonly resultCode: string;
  readonly terminal: TerminalResultV4;
  readonly cleanupErrorCode?: "browser_profile_cleanup_failed";
}

export function admitStage2TerminalArtifact(
  value: unknown,
): Stage2TerminalArtifactV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("terminal artifact denied");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const expected = [
    "schemaVersion", "evidenceRevision", "resultCode", "terminal",
    ...(candidate.cleanupErrorCode === undefined ? [] : ["cleanupErrorCode"]),
  ];
  if (
    keys.length !== expected.length || expected.some((key, index) => keys[index] !== key) ||
    candidate.schemaVersion !== 1 ||
    candidate.evidenceRevision !== "s2-terminal-artifact-v1" ||
    typeof candidate.resultCode !== "string" ||
    !/^[a-z][a-z0-9_]{0,127}$/u.test(candidate.resultCode) ||
    candidate.cleanupErrorCode !== undefined &&
      candidate.cleanupErrorCode !== "browser_profile_cleanup_failed"
  ) throw new TypeError("terminal artifact denied");
  const terminal = parseTerminalResultV4(candidate.terminal);
  return Object.freeze({
    schemaVersion: 1,
    evidenceRevision: "s2-terminal-artifact-v1",
    resultCode: candidate.resultCode,
    terminal,
    ...(candidate.cleanupErrorCode === undefined ? {} : {
      cleanupErrorCode: candidate.cleanupErrorCode,
    }),
  });
}

export function writeStage2TerminalArtifact(
  root: string,
  value: Stage2TerminalArtifactV1,
): string {
  const admitted = admitStage2TerminalArtifact(value);
  return writeAtomicJsonEvidence({
    root,
    value: admitted,
    sensitiveValues: [],
    label: "terminal artifact",
    fileName: "terminal-artifact.json",
  });
}

export function readStage2TerminalArtifact(root: string): Stage2TerminalArtifactV1 {
  const path = join(admittedRoot(root), "terminal-artifact.json");
  if (
    lstatSync(path).isSymbolicLink() || !statSync(path).isFile() ||
    statSync(path).size < 2 || statSync(path).size > 16 * 1024 ||
    comparable(realpathSync.native(path)) !== comparable(resolve(path))
  ) throw new Error("terminal artifact denied");
  return admitStage2TerminalArtifact(JSON.parse(readFileSync(path, "utf8")));
}

function admittedRoot(value: string): string {
  if (
    !isAbsolute(value) || normalize(value) !== value ||
    lstatSync(value).isSymbolicLink() || !statSync(value).isDirectory() ||
    comparable(realpathSync.native(value)) !== comparable(resolve(value))
  ) throw new Error("terminal artifact denied");
  return realpathSync.native(value);
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
