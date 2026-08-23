import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  classifyStage2ReadinessExit,
  readStage2ReadinessCertificate,
} from
  "../../../scripts/private/synthetic-readiness.ts";

const digest = "a".repeat(64);
const runtimeKey = "b".repeat(64);

test("the readiness certificate requires two clean consecutive runs and an exact runtime key", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-c3-readiness-certificate-"));
  const path = join(root, "readiness-certificate.json");
  try {
    const issuedAt = new Date(Date.now() - 1_000).toISOString();
    const run = (runOrdinal: number) => ({
      runOrdinal,
      status: "pass",
      childPid: 1000 + runOrdinal,
      monitorRecords: 10,
      watchdogChecks: 11,
      processCleanup: "pass",
      portCleanup: "pass",
      profileCleanup: "pass",
      submitActivated: false,
      evidenceSha256: digest,
      logFile: `run_${runOrdinal}/value-free.ndjson`,
    });
    const certificate = {
      schemaVersion: 1,
      certificateRevision: "c3-synthetic-readiness-v1",
      status: "pass",
      sourceRevision: "c".repeat(40),
      runtimeKeySha256: runtimeKey,
      nodeVersion: "22.23.2",
      npmVersion: "10.9.8",
      playwrightLockSha256: digest,
      browserExecutableSha256: digest,
      pagePort: 43871,
      monitorPort: 43872,
      observerReadyBeforeRunRoot: true,
      freshRunRoots: true,
      consecutiveRuns: [run(1), run(2)],
      submitActivated: false,
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + 24 * 60 * 60 * 1_000).toISOString(),
    };
    writeFileSync(path, `${JSON.stringify(certificate)}\n`);
    assert.equal(readStage2ReadinessCertificate(path, runtimeKey).status, "pass");
    assert.throws(
      () => readStage2ReadinessCertificate(path, "d".repeat(64)),
      /synthetic readiness denied/u,
    );
    writeFileSync(path, `${JSON.stringify({
      ...certificate,
      consecutiveRuns: [run(1)],
    })}\n`);
    assert.throws(
      () => readStage2ReadinessCertificate(path, runtimeKey),
      /synthetic readiness denied/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the synthetic launcher binds an observer before creating a run root and cannot Submit", () => {
  const source = readFileSync(
    resolve("scripts", "private", "synthetic-readiness.ts"),
    "utf8",
  );
  const child = readFileSync(resolve("scripts", "run-s2-readiness-child.ts"), "utf8");
  assert.ok(source.indexOf("await monitor.start()") < source.indexOf("mkdirSync(profileRoot"));
  assert.ok(source.indexOf("mkdirSync(profileRoot") <
    source.indexOf("runWindowsIsolatedStage2Acceptance(["));
  assert.match(source, /WATCHDOG_STALE_MS/u);
  assert.match(source, /membersAliveAfterClose/u);
  assert.match(child, /127\.0\.0\.1/u);
  assert.match(child, /Submit application/u);
  assert.match(child, /await submit\.isEnabled\(\)/u);
  assert.match(child, /createStage2ExternalMonitorRuntime/u);
  assert.match(child, /writeStage2ExternalMonitorAcknowledgement/u);
  assert.match(child, /headless: false/u);
  assert.doesNotMatch(child, /\.click\s*\(/u);
});

test("the package exposes only explicit readiness run and verification commands", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  assert.match(packageJson.scripts["readiness:s2"] ?? "", /run-with-s2-runtime\.ps1 scripts\/run-s2-readiness\.ts/u);
  assert.match(
    packageJson.scripts["readiness:s2:verify"] ?? "",
    /run-with-s2-runtime\.ps1 scripts\/verify-s2-readiness\.ts/u,
  );
  assert.doesNotMatch(packageJson.scripts["readiness:s2"] ?? "", /live:s2|prepare:s2-run/u);
});

test("readiness failures preserve their causal lifecycle phase", () => {
  assert.equal(classifyStage2ReadinessExit(21, 2), "browser_launch");
  assert.equal(classifyStage2ReadinessExit(22, 4), "page_binding");
  assert.equal(classifyStage2ReadinessExit(23, 6), "evidence");
  assert.equal(classifyStage2ReadinessExit(24, 1), "monitor");
  assert.equal(classifyStage2ReadinessExit(25, 7), "cleanup");
  assert.equal(classifyStage2ReadinessExit(125, 0), "child_spawn");
  assert.equal(classifyStage2ReadinessExit(125, 1), "cleanup");
});
