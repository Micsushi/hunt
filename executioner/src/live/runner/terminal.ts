import type { AccountAccessTargetFact } from "./account-access.ts";
import type { AccountVerifiedFact } from "./account-verified.ts";

export type Stage2TerminalResult =
  | {
      readonly ok: true;
      readonly acceptance: {
        readonly checkpoint: "account_access" | "mailbox_candidate" | "account_verified";
        readonly sourceRevision: string;
        readonly revisionId: string;
      };
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly fact?: AccountAccessTargetFact | AccountVerifiedFact;
    };

export function formatStage2TerminalResult(result: Stage2TerminalResult): string {
  const value = result.ok
    ? {
        status: "passed",
        checkpoint: result.acceptance.checkpoint,
        sourceRevision: result.acceptance.sourceRevision,
        revisionId: result.acceptance.revisionId,
      }
    : {
        status: result.fact === undefined ? "failed" : "blocked",
        code: result.code,
        ...(result.fact === undefined ? {} : { fact: result.fact }),
      };
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 512) {
    return '{"status":"failed","code":"terminal_output_denied"}\n';
  }
  return serialized;
}
