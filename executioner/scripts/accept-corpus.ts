import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runFrozenAcceptance } from "../src/corpus/acceptance/index.ts";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--frozen") {
  throw new Error("usage: corpus:accept -- --frozen <bundle>");
}
const bundlePath = resolve(args[1]!);
const executioner = resolve(fileURLToPath(import.meta.url), "..", "..");
const repository = resolve(executioner, "..");
const currentIdentity = () => ({
  sourceRevision: git("rev-parse", "HEAD"),
  sourceTree: git("rev-parse", "HEAD^{tree}"),
  clean: git("status", "--porcelain", "--untracked-files=all") === "",
});
const runRoot = dirname(bundlePath);
const report = await runFrozenAcceptance(
  bundlePath,
  resolve(runRoot, "ledger.json"),
  {
    currentIdentity,
    async runFixture(fixtureId) {
      const testPath = `tests/fixtures/workday/variants/${fixtureId}/variant.test.ts`;
      const result = spawnSync(process.execPath, ["tests/run.ts", testPath], {
        cwd: executioner,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error !== undefined) throw result.error;
      if (result.status !== 0) {
        process.stderr.write(result.stderr);
        return { ok: false, code: "fixture_failed", retryable: false };
      }
      return { ok: true };
    },
  },
);
await mkdir(runRoot, { recursive: true });
await writeFile(
  resolve(runRoot, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status === "rejected") process.exitCode = 1;

function git(...gitArgs: string[]): string {
  const result = spawnSync("git", gitArgs, {
    cwd: repository,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(" ")} failed`);
  return result.stdout.trim();
}
