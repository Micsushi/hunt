import { runWindowsIsolatedStage2Acceptance } from "../src/live/runner/windows-isolated-process.ts";
import { resolve } from "node:path";

if (process.platform !== "win32") {
  await import("./run-s2-real.ts");
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    process.exitCode = await runWindowsIsolatedStage2Acceptance(
      process.argv.slice(2),
      {
        signal: controller.signal,
        runnerPath: resolve(import.meta.dirname, "run-s2-real.ts"),
      },
    );
  } catch {
    process.stdout.write('{"status":"failed","code":"runner_admission_failed"}\n');
    process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
