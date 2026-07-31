import { execFileSync } from "node:child_process";

export const frozenContractRevision =
  "f75c5b5e483fc1e58372e6872a284fb7782a5390" as const;

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
