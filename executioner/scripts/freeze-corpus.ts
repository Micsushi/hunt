import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { createFrozenBundle, verifyFrozenBundle } from "../src/corpus/freeze/index.ts";

const executioner = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(executioner, "..");

function git(...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function identity() {
  return {
    sourceRevision: git("rev-parse", "HEAD"),
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    clean: git("status", "--porcelain", "--untracked-files=all") === "",
  };
}

const args = process.argv.slice(2);
if (args.length > 2 || (args.length > 0 && args[0] !== "--output")) {
  throw new Error("usage: corpus:freeze [--output <bundle>]");
}
const current = identity();
const bundlePath = resolve(
  args[1] ?? joinRuntime(current.sourceRevision),
);

if (existsSync(bundlePath)) {
  const bundle = await verifyFrozenBundle(bundlePath, current);
  process.stdout.write(`${bundlePath}\n${bundle.runId}\n`);
} else {
  const s3 = resolve(executioner, "fixtures", "workday", "s3");
  const bundle = await createFrozenBundle({
    repositoryRoot: repository,
    executionerRoot: executioner,
    ...current,
    packageLockPath: resolve(executioner, "package-lock.json"),
    manifestPath: resolve(s3, "corpus-manifest.json"),
    variantMapPath: resolve(s3, "variant-map.json"),
    configPath: resolve(s3, "acceptance-config.json"),
    fixtureRoot: resolve(s3, "cases"),
  }, bundlePath);
  process.stdout.write(`${bundlePath}\n${bundle.runId}\n`);
}

function joinRuntime(revision: string): string {
  return resolve(repository, ".runtime", "c3-s3-corpus", revision, "bundle.json");
}
