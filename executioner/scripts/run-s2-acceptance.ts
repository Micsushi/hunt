import { runStage2AccountAccessFromOwnerConfig } from "../src/composition/s2-account-access-runner.ts";
import { parseStage2AccountAccessArgs } from "../src/live/runner/args.ts";
import { formatStage2TerminalResult } from "../src/live/runner/terminal.ts";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  const args = parseStage2AccountAccessArgs(process.argv.slice(2));
  const result = await runStage2AccountAccessFromOwnerConfig(
    args,
    controller.signal,
  );
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
