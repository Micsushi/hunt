import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const executioner = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(executioner, "..");
const npmCli = process.env.npm_execpath || (
  process.platform === "win32"
    ? resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : undefined
);

function git(...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function assertClean(when: string): void {
  const status = git("status", "--porcelain", "--untracked-files=all");
  if (status !== "") throw new Error(`dirty candidate worktree ${when}:\n${status}`);
}

function runNpm(args: string[]): number {
  const result = spawnSync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...args] : args, {
    cwd: executioner,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

assertClean("before gates");
const candidate = git("rev-parse", "HEAD");
console.log(`S1 connection candidate: ${candidate}`);

const commands = [
  ["ci"],
  ["run", "typecheck"],
  [
    "test",
    "--",
    "tests/architecture",
    "tests/acceptance/components",
    "tests/connections",
    "tests/security/privacy",
  ],
  ["test", "--", "tests/contracts/no-skipped-conformance.test.ts"],
  ["run", "quality"],
] as const;

let exitCode = 0;
for (const args of commands) {
  console.log(`\n> npm ${args.join(" ")}`);
  exitCode = runNpm([...args]);
  if (exitCode !== 0) break;
}

assertClean("after gates");
if (git("rev-parse", "HEAD") !== candidate) {
  throw new Error("candidate HEAD changed during gates");
}
process.exitCode = exitCode;
