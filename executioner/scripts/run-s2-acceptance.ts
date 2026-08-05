import { executeStage2AcceptanceCli } from "../src/acceptance/s2-cli.ts";
import { createLocalStage2AcceptancePorts } from "../src/acceptance/s2-local.ts";
import { resolve } from "node:path";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  const result = await executeStage2AcceptanceCli(
    process.argv.slice(2),
    createLocalStage2AcceptancePorts(resolve(import.meta.dirname, "..")),
    controller.signal,
  );
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
} catch {
  process.stdout.write('{"status":"failed","code":"runner_admission_failed","cleanup":"not_started"}\n');
  process.exitCode = 2;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
