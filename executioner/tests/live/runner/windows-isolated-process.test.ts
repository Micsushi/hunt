import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  runWindowsIsolatedStage2Acceptance,
  supportsWindowsIsolatedNodeRuntime,
  windowsIsolatedRunnerScript,
} from "../../../src/live/runner/windows-isolated-process.ts";

const fixture = resolve("tests", "fixtures", "windows-isolated-runner-probe.ts");

test("Windows isolated live runs admit only the proven Node 22 runtime", () => {
  for (const version of ["22.18.0", "22.23.2"]) {
    assert.equal(supportsWindowsIsolatedNodeRuntime(version), true, version);
  }
  for (const version of ["22.17.9", "23.0.0", "24.14.0", "25.6.1", "v22.23.2", "22.23"]) {
    assert.equal(supportsWindowsIsolatedNodeRuntime(version), false, version);
  }
});

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
    "QueryInformationJobObject",
    "OpenProcess",
    "process-audit.json",
    "s2-windows-process-audit-v2",
    "processLiveNonceSha256",
    "monitorChainSha256",
    "isolated runner CreateDesktop failed:",
    "isolated runner CreateJobObject failed:",
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

test("Windows isolated runner inherits the value-free trace flag", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hunt-c3-runner-env-"));
  try {
    const output = join(directory, "environment.txt");
    assert.equal(await runWindowsIsolatedStage2Acceptance([
      "environment",
      output,
    ], {
      runnerPath: fixture,
      environment: {
        ...process.env,
        HUNT_C3_VALUE_FREE_ACCOUNT_TRACE: "1",
      },
    }), 0);
    assert.equal(await readFile(output, "utf8"), "1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows isolated runner seals exact post-job descendant cleanup evidence", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hunt-c3-process-audit-"));
  try {
    const argvOutput = join(directory, "argv.json");
    assert.equal(await runWindowsIsolatedStage2Acceptance([
      "argv",
      argvOutput,
      "--evidence-root",
      directory,
    ], { runnerPath: fixture }), 0);
    const audit = JSON.parse(await readFile(join(directory, "process-audit.json"), "utf8"));
    assert.deepEqual(Object.keys(audit), [
      "schemaVersion",
      "evidenceRevision",
      "status",
      "jobCloseApplied",
      "membersObservedBeforeClose",
      "membersAliveAfterClose",
      "checkedAt",
    ]);
    assert.equal(audit.status, "pass");
    assert.equal(audit.jobCloseApplied, true);
    assert.equal(audit.membersAliveAfterClose, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows Review runner binds process cleanup to config, run, target, and live monitor ledger", {
  skip: process.platform !== "win32",
}, async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "hunt-c3-process-bound-"));
  const runKey = "run_20260810_processbindingxx";
  const configPath = join(storageRoot, "transient", runKey, "owner-input.json");
  const evidenceRoot = join(storageRoot, "retained", runKey, "evidence");
  try {
    await mkdir(resolve(configPath, ".."), { recursive: true });
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      journeyId: "journey_abcdefghijklmnop",
      target: { handleId: "target_ref_abcdefghijklmnop" },
    }));
    const argvOutput = join(storageRoot, "argv.json");
    assert.equal(await runWindowsIsolatedStage2Acceptance([
      "identity", argvOutput,
      "--evidence-root", evidenceRoot,
      "--config", configPath,
    ], { runnerPath: fixture }), 0);
    const audit = JSON.parse(await readFile(join(evidenceRoot, "process-audit.json"), "utf8"));
    const producer = JSON.parse(await readFile(argvOutput, "utf8"));
    assert.equal(audit.evidenceRevision, "s2-windows-process-audit-v2");
    assert.equal(audit.runKey, runKey);
    assert.equal(audit.journeyId, "journey_abcdefghijklmnop");
    assert.equal(audit.targetHandleId, "target_ref_abcdefghijklmnop");
    assert.match(audit.configSha256, /^[0-9a-f]{64}$/u);
    assert.match(audit.processLiveNonceSha256, /^[0-9a-f]{64}$/u);
    assert.equal(audit.processOwnerPid, producer.pid);
    assert.match(audit.processOwnerStartedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.ok(Date.parse(audit.processExitObservedAt) <= Date.parse(audit.checkedAt));
    assert.equal(audit.monitorFileCount, 0);
    assert.match(audit.monitorChainSha256, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
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
    const pids = await readJsonWhenReady<{
      readonly runnerPid: number;
      readonly descendantPid: number;
    }>(output);
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

test("live:s2 enters through the same-revision gate and its real slice remains isolated", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  assert.match(packageJson.scripts?.["live:s2"] ?? "", /run-with-s2-runtime\.ps1 scripts\/run-s2-acceptance\.ts/u);
  const gate = await readFile("scripts/run-s2-acceptance.ts", "utf8");
  assert.match(gate, /executeStage2AcceptanceCli/u);
  assert.match(gate, /createLocalStage2AcceptancePorts/u);
  assert.match(gate, /import\.meta\.dirname/u);
  const local = await readFile("src/acceptance/s2-local.ts", "utf8");
  assert.match(local, /taskkill\.exe/u);
  assert.match(local, /"\/PID"[\s\S]*"\/T"[\s\S]*"\/F"/u);
  assert.doesNotMatch(local, /"\/IM"/u);
  assert.match(local, /supportsWindowsIsolatedNodeRuntime\(process\.versions\.node\)/u);
  const wrapper = await readFile("scripts/run-s2-isolated.ts", "utf8");
  assert.match(wrapper, /runWindowsIsolatedStage2Acceptance/u);
  assert.match(wrapper, /supportsWindowsIsolatedNodeRuntime\(process\.versions\.node\)/u);
  assert.match(wrapper, /run-s2-real/u);
  assert.doesNotMatch(wrapper, /connectOverCDP/u);
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("probe timed out");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

async function readJsonWhenReady<Value>(path: string): Promise<Value> {
  let value: Value | undefined;
  await waitFor(async () => {
    try {
      value = JSON.parse(await readFile(path, "utf8")) as Value;
      return true;
    } catch {
      return false;
    }
  });
  return value!;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
