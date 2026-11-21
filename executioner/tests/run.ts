import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testRunnerArgs } from "./runner.ts";

const args = ["--experimental-test-module-mocks", ...testRunnerArgs(process.argv.slice(2))];
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "hunt-c3-tests-"));
const result = spawnSync(process.execPath, args, {
  env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
if (result.status === 0) {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} else {
  console.error(`Test files retained at ${scratch}`);
}
