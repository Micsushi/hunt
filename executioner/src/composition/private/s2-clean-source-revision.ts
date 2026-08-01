import { spawnSync } from "node:child_process";

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
  const worktree = process.run(["diff", "--quiet", "--", ...PRODUCTION_SCOPE]);
  const index = process.run(["diff", "--cached", "--quiet", "--", ...PRODUCTION_SCOPE]);
  const untracked = process.run([
    "ls-files", "--others", "--exclude-standard", "--", ...PRODUCTION_SCOPE,
  ]);
  if (
    worktree.status !== 0 || index.status !== 0 || untracked.status !== 0 ||
    untracked.stdout.trim() !== ""
  ) unavailable();
  return Object.freeze({ repositoryRoot, sourceRevision });
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
      maxBuffer: 64 * 1024,
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
