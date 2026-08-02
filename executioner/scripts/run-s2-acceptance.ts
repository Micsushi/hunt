import { parseStage2AcceptanceArgs } from "../src/live/runner/args.ts";
import { formatStage2TerminalResult } from "../src/live/runner/terminal.ts";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  const args = parseStage2AcceptanceArgs(process.argv.slice(2));
  const result = args.checkpoint === "mailbox_candidate"
    ? await (await import("../src/composition/s2-mailbox-candidate-runner.ts"))
      .runStage2MailboxCandidateFromOwnerConfig(args, controller.signal)
    : args.checkpoint === "account_verified"
    ? await (await import("../src/composition/s2-account-verified-runner.ts"))
      .runStage2AccountVerifiedFromOwnerConfig(args, controller.signal)
    : await (await import("../src/composition/s2-account-access-runner.ts"))
      .runStage2AccountAccessFromOwnerConfig(args, controller.signal);
  process.stdout.write(formatStage2TerminalResult(result));
  if (result.ok) {
    process.exitCode = 0;
  } else {
    process.exitCode = result.code === "operation_cancelled" ? 130 : 1;
  }
} catch {
  process.stdout.write('{"status":"failed","code":"runner_admission_failed"}\n');
  process.exitCode = 2;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
