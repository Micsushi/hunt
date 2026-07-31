import { spawnSync } from "node:child_process";

import { testTargets } from "./runner.ts";

const targets = testTargets(process.argv.slice(2));
const result = spawnSync(process.execPath, ["--test", ...targets], {
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
