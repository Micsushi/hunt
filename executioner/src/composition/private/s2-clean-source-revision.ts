import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const PRODUCTION_SCOPE = Object.freeze([
  ":(top)executioner/src",
  ":(top)executioner/scripts",
  ":(top)executioner/package.json",
  ":(top)executioner/package-lock.json",
  ":(top)executioner/README.md",
]);

export interface GitInspectionResult {
  readonly status: number | null;
  readonly stdout: string;
}

export interface GitInspectionProcess {
  run(args: readonly string[]): GitInspectionResult;
}

export interface CleanSourceRevision {
  readonly repositoryRoot: string;
  readonly sourceRevision: string;
}

export function inspectCleanSourceRevision(
  cwd: string,
  process: GitInspectionProcess = new LocalGitInspectionProcess(cwd),
): CleanSourceRevision {
  const root = process.run(["rev-parse", "--show-toplevel"]);
  const revision = process.run(["rev-parse", "HEAD"]);
  if (root.status !== 0 || revision.status !== 0) unavailable();
  const repositoryRoot = root.stdout.trim();
  const sourceRevision = revision.stdout.trim();
  if (repositoryRoot.length === 0 || !/^[0-9a-f]{40}$/u.test(sourceRevision)) {
    unavailable();
  }
  const patch = process.run([
    "diff",
    "--binary",
    "--no-ext-diff",
    "HEAD",
    "--",
    ...PRODUCTION_SCOPE,
  ]);
  const untracked = process.run([
    "ls-files", "-z", "--others", "--exclude-standard", "--", ...PRODUCTION_SCOPE,
  ]);
  if (patch.status !== 0 || untracked.status !== 0) unavailable();
  const untrackedPaths = untracked.stdout.split("\0").filter((path) => path !== "").sort();
  if (patch.stdout === "" && untrackedPaths.length === 0) {
    return Object.freeze({ repositoryRoot, sourceRevision });
  }
  const snapshot = createHash("sha256");
  snapshot.update("hunt-c3-production-snapshot-v1\0", "utf8");
  snapshot.update(sourceRevision, "ascii");
  snapshot.update("\0", "ascii");
  snapshot.update(patch.stdout, "utf8");
  snapshot.update("\0", "ascii");
  for (const path of untrackedPaths) {
    const blob = process.run(["hash-object", "--no-filters", "--", path]);
    const blobHash = blob.stdout.trim();
    if (blob.status !== 0 || !/^[0-9a-f]{40}$/u.test(blobHash)) unavailable();
    snapshot.update(path, "utf8");
    snapshot.update("\0", "ascii");
    snapshot.update(blobHash, "ascii");
    snapshot.update("\0", "ascii");
  }
  return Object.freeze({
    repositoryRoot,
    sourceRevision: snapshot.digest("hex").slice(0, 40),
  });
}

class LocalGitInspectionProcess implements GitInspectionProcess {
  readonly #cwd: string;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  run(args: readonly string[]): GitInspectionResult {
    const result = spawnSync("git", [...args], {
      cwd: this.#cwd,
      shell: false,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Object.freeze({
      status: result.error === undefined && result.signal === null ? result.status : null,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
    });
  }
}

function unavailable(): never {
  throw new Error("source revision unavailable");
}
