import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  runCorpusAudit,
  runStaticCorpusAudit,
} from "../src/corpus/audit/index.ts";

const executioner = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(executioner, "..");
if (process.argv[2] === "--static") {
  if (process.argv.length !== 3) throw new TypeError("audit --static accepts no other arguments");
  const report = await runStaticCorpusAudit(executioner);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "passed") process.exitCode = 1;
  process.exit();
}
if (process.argv.length !== 2) throw new TypeError("audit accepts only --static");
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", shell: false, windowsHide: true });
  if (result.error !== undefined || result.status !== 0) throw new Error("source identity unavailable");
  return result.stdout.trim();
};
const current = {
  sourceRevision: git("rev-parse", "HEAD"),
  sourceTree: git("rev-parse", "HEAD^{tree}"),
  clean: git("status", "--porcelain", "--untracked-files=all") === "",
};
const bundlePath = resolve(repository, ".runtime", "c3-s3-corpus", current.sourceRevision, "bundle.json");
const report = await runCorpusAudit(executioner, bundlePath, current);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;
