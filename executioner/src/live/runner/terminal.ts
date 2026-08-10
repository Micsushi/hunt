import type { AccountAccessTargetFact } from "./account-access.ts";
import type { AccountVerifiedFact } from "./account-verified.ts";

type Stage2ReviewJourneyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: string;
      readonly cleanupErrorCode?: "browser_profile_cleanup_failed";
      readonly terminal: {
        readonly status: "review_reached" | "failed" | "blocked" | "cancelled";
        readonly errorCode?: string;
      };
    };

export type Stage2TerminalResult =
  | {
      readonly ok: true;
      readonly acceptance: {
        readonly checkpoint:
          | "account_access"
          | "mailbox_candidate"
          | "account_verified"
          | "resume_verified"
          | "profile_verified"
          | "questionnaire_verified"
          | "pre_review";
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

export function formatStage2ReviewJourneyTerminal(
  result: Stage2ReviewJourneyResult,
): string {
  const value = result.ok
    ? { status: "passed", checkpoint: "review", submitActivated: false }
    : {
        status: "failed",
        code: result.code,
        terminalStatus: result.terminal.status,
        ...(result.terminal.status === "failed"
          ? { errorCode: result.terminal.errorCode }
          : {}),
        ...(result.cleanupErrorCode === undefined
          ? {}
          : { cleanupErrorCode: result.cleanupErrorCode }),
      };
  const serialized = `${JSON.stringify(value)}\n`;
  return Buffer.byteLength(serialized, "utf8") <= 512
    ? serialized
    : '{"status":"failed","code":"terminal_output_denied"}\n';
}
