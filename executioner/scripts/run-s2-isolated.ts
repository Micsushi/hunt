import {
  runWindowsIsolatedStage2Acceptance,
  supportsWindowsIsolatedNodeRuntime,
} from "../src/live/runner/windows-isolated-process.ts";
import { resolve } from "node:path";

if (process.platform !== "win32") {
  await import("./run-s2-real.ts");
} else if (!supportsWindowsIsolatedNodeRuntime(process.versions.node)) {
  process.stdout.write('{"status":"failed","code":"runner_admission_failed"}\n');
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const arguments_ = process.argv.slice(2);
    const exitCode = await runWindowsIsolatedStage2Acceptance(
      arguments_,
      {
        signal: controller.signal,
        runnerPath: resolve(import.meta.dirname, "run-s2-real.ts"),
      },
    );
    const args = (await import("../src/live/runner/args.ts"))
      .parseStage2AcceptanceArgs(arguments_);
    if (["resume_verified", "profile_verified", "questionnaire_verified", "pre_review"]
      .includes(args.checkpoint)) {
      (await import("../src/composition/private/s2-page-local-terminal.ts"))
        .sealPageLocalTerminal(args, exitCode);
    }
    process.exitCode = exitCode;
  } catch {
    process.stdout.write('{"status":"failed","code":"runner_admission_failed"}\n');
    process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
