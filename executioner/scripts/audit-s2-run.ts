import { auditStage2AccountAccessCompletion } from "../src/composition/private/s2-completion-audit.ts";
import { parseStage2CompletionAuditArgs } from "../src/live/runner/completion-audit.ts";

try {
  const args = parseStage2CompletionAuditArgs(process.argv.slice(2));
  const audit = await auditStage2AccountAccessCompletion(args.evidenceRoot);
  process.stdout.write(`${JSON.stringify(audit)}\n`);
} catch {
  process.stdout.write('{"status":"failed","code":"completion_audit_denied"}\n');
  process.exitCode = 1;
}
