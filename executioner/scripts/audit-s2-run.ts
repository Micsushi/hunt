import { auditStage2Completion } from "../src/composition/private/s2-any-completion-audit.ts";
import { parseStage2CompletionAuditArgs } from "../src/live/runner/completion-audit.ts";

try {
  const args = parseStage2CompletionAuditArgs(process.argv.slice(2));
  const audit = await auditStage2Completion(args.evidenceRoot);
  process.stdout.write(`${JSON.stringify(audit)}\n`);
} catch {
  process.stdout.write('{"status":"failed","code":"completion_audit_denied"}\n');
  process.exitCode = 1;
}
