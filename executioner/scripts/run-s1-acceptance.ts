import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_ACCEPTANCE_REPORT_BYTES,
  runDeterministicAcceptance,
} from "../tests/acceptance/s1/t2-support.ts";

const executioner = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(executioner, "..");

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

async function main(): Promise<void> {
  if (process.argv.slice(2).length !== 0) {
    throw new Error("S1 acceptance takes no options");
  }
  assertClean("before acceptance");
  const candidate = git("rev-parse", "HEAD");
  const result = await runDeterministicAcceptance({
    candidate,
    fixtureRoot: resolve(executioner, "fixtures/workday/s1"),
  });
  assertClean("after acceptance");
  if (git("rev-parse", "HEAD") !== candidate) {
    throw new Error("candidate HEAD changed during acceptance");
  }

  const serialized = `${JSON.stringify(result.report)}\n`;
  if (Buffer.byteLength(serialized) > MAX_ACCEPTANCE_REPORT_BYTES) {
    throw new Error("acceptance report exceeds 64 KiB");
  }
  const reportPath = resolve(
    repository,
    ".runtime/c3-s1-acceptance",
    candidate,
    "report.json",
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, serialized, "utf8");

  assertClean("after report");
  if (git("rev-parse", "HEAD") !== candidate) {
    throw new Error("candidate HEAD changed while writing acceptance report");
  }
  console.log(`S1 acceptance candidate: ${candidate}`);
  console.log("S1 acceptance runs: happy=3 fault=3");
  console.log(`S1 acceptance report: ${reportPath}`);
}

await main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
