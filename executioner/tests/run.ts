import { spawnSync } from "node:child_process";

import { testRunnerArgs } from "./runner.ts";

const result = spawnSync(process.execPath, testRunnerArgs(process.argv.slice(2)), {
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
