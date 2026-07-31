import { globSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const inputs = process.argv.slice(2);
const targets = (inputs.length === 0 ? ["tests"] : inputs).flatMap((input) =>
  statSync(input).isDirectory()
    ? globSync("**/*.test.ts", { cwd: input }).map((file) => join(input, file))
    : input,
);

const result = spawnSync(process.execPath, ["--test", ...targets], {
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
