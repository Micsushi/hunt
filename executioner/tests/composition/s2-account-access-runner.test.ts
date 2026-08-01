import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectCleanSourceRevision,
  type GitInspectionProcess,
} from "../../src/composition/s2-account-access-runner.ts";

test("production source admission returns the exact clean checked-out Git SHA", () => {
  const calls: string[][] = [];
  const process: GitInspectionProcess = {
    run(args) {
      calls.push([...args]);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { status: 0, stdout: "C:/repo\n" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { status: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n" };
      }
      return { status: 0, stdout: "" };
    },
  };
  assert.deepEqual(inspectCleanSourceRevision("C:/repo/executioner", process), {
    repositoryRoot: "C:/repo",
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.equal(calls.some((args) => args.includes("--cached")), true);
  assert.equal(calls.some((args) => args.includes("--others")), true);
  assert.equal(
    calls.some((args) => args.includes(":(top)executioner/package-lock.json")),
    true,
  );
});

test("production source admission rejects tracked, staged, or untracked production changes", () => {
  for (const dirtyCommand of ["worktree", "cached", "untracked"] as const) {
    const process: GitInspectionProcess = {
      run(args) {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return { status: 0, stdout: "C:/repo\n" };
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { status: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n" };
        }
        if (dirtyCommand === "worktree" && args[0] === "diff" && !args.includes("--cached")) {
          return { status: 1, stdout: "" };
        }
        if (dirtyCommand === "cached" && args.includes("--cached")) {
          return { status: 1, stdout: "" };
        }
        if (dirtyCommand === "untracked" && args.includes("--others")) {
          return { status: 0, stdout: "executioner/src/live/runner/new.ts\n" };
        }
        return { status: 0, stdout: "" };
      },
    };
    assert.throws(
      () => inspectCleanSourceRevision("C:/repo/executioner", process),
      /source revision unavailable/u,
    );
  }
});
