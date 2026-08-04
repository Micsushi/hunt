import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.equal(calls.some((args) => args.includes("--binary")), true);
  assert.equal(calls.some((args) => args.includes("--others")), true);
  assert.equal(
    calls.some((args) => args.includes(":(top)executioner/package-lock.json")),
    true,
  );
});

test("production changes receive a deterministic snapshot revision instead of being rejected", () => {
  const inspection = (patch: string): GitInspectionProcess => ({
    run(args) {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { status: 0, stdout: "C:/repo\n" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { status: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n" };
      }
      if (args[0] === "diff") return { status: 0, stdout: patch };
      return { status: 0, stdout: "" };
    },
  });

  const first = inspectCleanSourceRevision("C:/repo/executioner", inspection("patch-a"));
  const replay = inspectCleanSourceRevision("C:/repo/executioner", inspection("patch-a"));
  const changed = inspectCleanSourceRevision("C:/repo/executioner", inspection("patch-b"));

  assert.match(first.sourceRevision, /^[0-9a-f]{40}$/u);
  assert.notEqual(first.sourceRevision, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(replay.sourceRevision, first.sourceRevision);
  assert.notEqual(changed.sourceRevision, first.sourceRevision);
});

test("untracked production files participate in the snapshot revision", () => {
  const inspection = (blob: string): GitInspectionProcess => ({
    run(args) {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { status: 0, stdout: "C:/repo\n" };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { status: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n" };
      }
      if (args[0] === "ls-files") {
        return { status: 0, stdout: "executioner/src/live/runner/new.ts\0" };
      }
      if (args[0] === "hash-object") return { status: 0, stdout: `${blob}\n` };
      return { status: 0, stdout: "" };
    },
  });

  const first = inspectCleanSourceRevision(
    "C:/repo/executioner",
    inspection("1111111111111111111111111111111111111111"),
  );
  const changed = inspectCleanSourceRevision(
    "C:/repo/executioner",
    inspection("2222222222222222222222222222222222222222"),
  );
  assert.notEqual(first.sourceRevision, changed.sourceRevision);
});

test("production source admission still rejects unavailable Git inspection", () => {
  const process: GitInspectionProcess = {
    run() {
      return { status: 1, stdout: "" };
    },
  };
  assert.throws(
    () => inspectCleanSourceRevision("C:/repo/executioner", process),
    /source revision unavailable/u,
  );
});

test("local source inspection admits a bounded multi-file integration diff", async () => {
  const source = await readFile(
    new URL("../../src/composition/private/s2-clean-source-revision.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /maxBuffer: 4 \* 1024 \* 1024/u);
});
