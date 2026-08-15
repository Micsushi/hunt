import {
  parseStage2AcceptanceArgs,
  type Stage2AcceptanceArgs,
} from "../src/live/runner/args.ts";
import { formatStage2TerminalResult } from "../src/live/runner/terminal.ts";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  const args = parseStage2AcceptanceArgs(process.argv.slice(2));
  const result = isApplicationCheckpoint(args.checkpoint)
    ? await runApplicationSlice(args, args.checkpoint, controller.signal)
    : args.checkpoint === "mailbox_candidate"
    ? await (await import("../src/composition/s2-mailbox-candidate-runner.ts"))
      .runStage2MailboxCandidateFromOwnerConfig(args, controller.signal)
    : args.checkpoint === "account_verified"
    ? await (await import("../src/composition/s2-account-verified-runner.ts"))
      .runStage2AccountVerifiedFromOwnerConfig(args, controller.signal)
    : await (await import("../src/composition/s2-account-access-runner.ts"))
      .runStage2AccountAccessFromOwnerConfig(args, controller.signal);
  process.stdout.write(formatStage2TerminalResult(result));
  process.exitCode = result.ok ? 0 : result.code === "operation_cancelled" ? 130 : 1;
} catch {
  process.stdout.write('{"status":"failed","code":"runner_admission_failed"}\n');
  process.exitCode = 2;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}

async function runApplicationSlice(
  args: Stage2AcceptanceArgs,
  checkpoint:
    | "resume_verified"
    | "profile_verified"
    | "questionnaire_verified"
    | "pre_review",
  signal: AbortSignal,
) {
  const application = await import("../src/composition/s2-application-walk-runner.ts");
  const runtime = await import("../src/acceptance/s2-playwright-runtime.ts");
  return application.runStage2ApplicationWalkFromOwnerConfig({
      checkpoint,
      configPath: args.configPath,
      evidenceRoot: args.evidenceRoot,
    }, signal, application.createStage2ApplicationWalkProductionBinding({
      runtime: runtime.createStage2PlaywrightLiveRuntimeBinding({
        monitorAuthentication: false,
      }),
    }));
}

function isApplicationCheckpoint(
  checkpoint: string,
): checkpoint is
  | "resume_verified"
  | "profile_verified"
  | "questionnaire_verified"
  | "pre_review" {
  return checkpoint === "resume_verified" ||
    checkpoint === "profile_verified" ||
    checkpoint === "questionnaire_verified" ||
    checkpoint === "pre_review";
}
