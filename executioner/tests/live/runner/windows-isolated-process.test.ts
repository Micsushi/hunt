import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  runWindowsIsolatedStage2Acceptance,
  windowsIsolatedRunnerScript,
} from "../../../src/live/runner/windows-isolated-process.ts";

const fixture = resolve("tests", "fixtures", "windows-isolated-runner-probe.ts");

test("Windows live runner owns an unswitched desktop and kill-on-close process job", () => {
  const source = windowsIsolatedRunnerScript();
  for (const required of [
    "CreateDesktop",
    "lpDesktop",
    "CreateJobObject",
    "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
    "PROC_THREAD_ATTRIBUTE_JOB_LIST",
    "UpdateProcThreadAttribute",
    "CREATE_SUSPENDED",
    "ResumeThread",
    "WaitForSingleObject",
    "GetExitCodeProcess",
  ]) assert.match(source, new RegExp(required, "u"), required);
  assert.doesNotMatch(source, /AssignProcessToJobObject/u);
  for (const forbidden of ["SwitchDesktop", "SetForegroundWindow", "connectOverCDP"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("Windows isolated runner round-trips trailing backslashes and attests its desktop", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hunt-c3-runner-"));
  try {
    const argvOutput = join(directory, "argv.json");
    assert.equal(await runWindowsIsolatedStage2Acceptance([
      "argv",
      argvOutput,
      "C:\\private\\evidence\\",
      "after",
    ], { runnerPath: fixture }), 0);
    assert.deepEqual(JSON.parse(await readFile(argvOutput, "utf8")), [
      "C:\\private\\evidence\\",
      "after",
    ]);

    const attestationOutput = join(directory, "attestation.txt");
    assert.equal(await runWindowsIsolatedStage2Acceptance([
      "attest",
      attestationOutput,
    ], { runnerPath: fixture }), 0);
    assert.equal(await readFile(attestationOutput, "utf8"), "ok");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation waits for the isolated runner and its descendant to exit", {
  skip: process.platform !== "win32",
  timeout: 15_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hunt-c3-cancel-"));
  const output = join(directory, "pids.json");
  const controller = new AbortController();
  try {
    const running = runWindowsIsolatedStage2Acceptance(["linger", output], {
      runnerPath: fixture,
      signal: controller.signal,
    });
    await waitFor(() => existsSync(output));
    const pids = JSON.parse(await readFile(output, "utf8")) as {
      readonly runnerPid: number;
      readonly descendantPid: number;
    };
    controller.abort();
    assert.equal(await running, 130);
    assert.equal(isProcessAlive(pids.runnerPid), false);
    assert.equal(isProcessAlive(pids.descendantPid), false);
  } finally {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pre-aborted launch confirms wrapper cleanup without waiting for timeout", {
  skip: process.platform !== "win32",
  timeout: 5_000,
}, async () => {
  const controller = new AbortController();
  controller.abort();
  const startedAt = Date.now();
  assert.equal(await runWindowsIsolatedStage2Acceptance([], {
    runnerPath: fixture,
    signal: controller.signal,
  }), 130);
  assert.ok(Date.now() - startedAt < 3_000);
});

test("live:s2 enters through the isolated runner wrapper", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  assert.equal(packageJson.scripts?.["live:s2"], "node scripts/run-s2-isolated.ts");
  const wrapper = await readFile("scripts/run-s2-isolated.ts", "utf8");
  assert.match(wrapper, /runWindowsIsolatedStage2Acceptance/u);
  assert.doesNotMatch(wrapper, /connectOverCDP/u);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("probe timed out");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
