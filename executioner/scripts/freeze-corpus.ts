import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFrozenBundle } from "../src/corpus/freeze/index.ts";

const executioner = resolve(fileURLToPath(import.meta.url), "..", "..");
const repository = resolve(executioner, "..");
const revision = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
const clean = git("status", "--porcelain", "--untracked-files=all") === "";
const corpus = resolve(executioner, "corpus", "workday-40");
const fixtureRoot = resolve(executioner, "fixtures", "workday", "corpus");
const bundlePath = resolve(
  repository,
  ".runtime",
  "c3-s3-corpus",
  revision,
  "bundle.json",
);

const bundle = await createFrozenBundle({
  repositoryRoot: repository,
  executionerRoot: executioner,
  sourceRevision: revision,
  sourceTree: tree,
  clean,
  packageLockPath: resolve(executioner, "package-lock.json"),
  manifestPath: resolve(corpus, "manifest.json"),
  variantMapPath: resolve(corpus, "variants.json"),
  fixtureManifestPath: resolve(fixtureRoot, "manifest.json"),
  declarationsPath: resolve(corpus, "variant-declarations.json"),
  impactPath: resolve(corpus, "contract-impact.json"),
  baselinePath: resolve(corpus, "source-reconciliation.json"),
  configPath: resolve(corpus, "acceptance.json"),
  fixtureRoot,
}, bundlePath);

process.stdout.write(`${bundlePath}\n${bundle.runId}\n`);

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
