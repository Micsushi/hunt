import { execFileSync } from "node:child_process";

export const frozenContractRevision =
  "d95e845e61bcf0a030b3b07c6d6261e3d95c1fad" as const;

const contractPath = ":(top)executioner/src/contracts";

export function assertFrozenContractTree(
  revision: string,
  repository: string,
): void {
  execFileSync(
    "git",
    ["diff", "--exit-code", revision, "--", contractPath],
    { cwd: repository, stdio: "pipe" },
  );

  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", contractPath],
    { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (untracked !== "") {
    throw new Error(`untracked contract file: ${untracked}`);
  }
}
