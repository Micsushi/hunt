import { resolve } from "node:path";

import { inspectCleanSourceRevision } from "../src/composition/private/s2-clean-source-revision.ts";
import { parseStage2RealAcceptanceArgs } from "../src/acceptance/s2-gate.ts";
import {
  captureStage2Config,
  writeStage2ReviewAcceptance,
} from "../src/acceptance/s2-local.ts";
import { runStage2RealJourney } from "../src/acceptance/s2-journey.ts";
import {
  stage2RealJourneyRuntimeBinding,
} from "../src/acceptance/s2-production-binding.ts";
import { formatStage2ReviewJourneyTerminal } from "../src/live/runner/terminal.ts";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  const args = parseStage2RealAcceptanceArgs(process.argv.slice(2));
  const cwd = resolve(import.meta.dirname, "..");
  const result = await runStage2RealJourney(
    {
      args,
      source: inspectCleanSourceRevision(cwd),
      config: captureStage2Config(args.configPath),
    },
    stage2RealJourneyRuntimeBinding,
    {
      now: () => new Date().toISOString(),
      writeAcceptance: async (root, value) => {
        writeStage2ReviewAcceptance(root, value, []);
      },
    },
    controller.signal,
  );
  process.stdout.write(formatStage2ReviewJourneyTerminal(result));
  process.exitCode = result.ok
    ? 0
    : result.code === "operation_cancelled"
      ? 130
      : 1;
} catch {
  process.stdout.write('{"status":"failed","code":"runner_admission_failed"}\n');
  process.exitCode = 2;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
