import type { TerminalResultV4 } from "../contracts/index.ts";
import { writeAtomicJsonEvidence } from "../live/evidence/private/atomic-json-evidence.ts";

export interface Stage2TerminalArtifactV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-terminal-artifact-v1";
  readonly resultCode: string;
  readonly terminal: TerminalResultV4;
  readonly cleanupErrorCode?: "browser_profile_cleanup_failed";
}

export function writeStage2TerminalArtifact(
  root: string,
  value: Stage2TerminalArtifactV1,
): string {
  if (
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-terminal-artifact-v1" ||
    typeof value.resultCode !== "string" ||
    value.resultCode.length < 1 || value.resultCode.length > 128
  ) throw new TypeError("terminal artifact denied");
  return writeAtomicJsonEvidence({
    root,
    value: Object.freeze({ ...value }),
    sensitiveValues: [],
    label: "terminal artifact",
    fileName: "terminal-artifact.json",
  });
}
