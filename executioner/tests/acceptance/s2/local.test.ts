import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  admittedNpmCliPath,
  captureStage2Config,
  createLocalStage2AcceptancePorts,
  LocalStage2Command,
  readStage2ReviewAcceptance,
  writeStage2ReviewAcceptance,
  writeStage2AcceptanceManifest,
} from "../../../src/acceptance/s2-local.ts";
import type { Stage2AcceptanceManifest } from "../../../src/acceptance/s2-gate.ts";
import { runStage2RealAcceptance } from "../../../src/acceptance/s2-gate.ts";
import {
  prepareStage2RunStorage,
  readStage2StorageCatalog,
} from "../../../src/composition/private/s2-run-storage.ts";

const secret = "never-retain-this-password";
const targetUrl = "https://tenant.wd5.myworkdayjobs.com/en-US/Careers/job/Title_R12345";

test("config capture hashes exact bytes and returns only admitted opaque identifiers", async () => {
  withRun((paths) => {
    writeFileSync(paths.configPath, JSON.stringify(ownerConfig()), "utf8");
    const first = captureStage2Config(paths.configPath);
    assert.match(first.configSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual({ ...first, configSha256: "hash" }, {
      configSha256: "hash",
      contractRevision: "s2-owner-inputs-v1",
      revisionId: "revision_0123456789abcdef",
      approvalId: "approval_0123456789abcdef",
      journeyId: "journey_0123456789abcdef",
      targetHandleId: "target_ref_0123456789abcdef",
    });
    assert.equal(JSON.stringify(first).includes(secret), false);
    assert.equal(JSON.stringify(first).includes(targetUrl), false);

    writeFileSync(paths.configPath, `${JSON.stringify(ownerConfig())}\n`, "utf8");
    assert.notEqual(captureStage2Config(paths.configPath).configSha256, first.configSha256);
  });
});

test("Review reader admits only the exact sanitized result contract", () => {
  withRun((paths) => {
    writeFileSync(join(paths.evidenceRoot, "review-acceptance.json"), JSON.stringify(reviewPacket()), "utf8");
    assert.deepEqual(readStage2ReviewAcceptance(paths.evidenceRoot), reviewPacket());

    writeFileSync(
      join(paths.evidenceRoot, "review-acceptance.json"),
      JSON.stringify({ ...reviewPacket(), rawUrl: targetUrl }),
      "utf8",
    );
    assert.throws(
      () => readStage2ReviewAcceptance(paths.evidenceRoot),
      /review acceptance evidence denied/u,
    );
  });
});

test("Review reader rejects legacy acceptance when the phase-specific file is absent", () => {
  withRun((paths) => {
    writeFileSync(join(paths.evidenceRoot, "acceptance.json"), JSON.stringify(reviewPacket()), "utf8");
    assert.throws(
      () => readStage2ReviewAcceptance(paths.evidenceRoot),
      /review acceptance evidence denied/u,
    );
  });
});

test("Review writer seals one exact sanitized acceptance for outer reconciliation", () => {
  withRun((paths) => {
    writeStage2ReviewAcceptance(paths.evidenceRoot, reviewPacket(), [secret, targetUrl]);
    assert.deepEqual(readStage2ReviewAcceptance(paths.evidenceRoot), reviewPacket());
    const raw = readFileSync(join(paths.evidenceRoot, "review-acceptance.json"), "utf8");
    assert.equal(raw.includes(secret), false);
    assert.equal(raw.includes(targetUrl), false);
    assert.throws(
      () => writeStage2ReviewAcceptance(paths.evidenceRoot, reviewPacket(), []),
      /evidence unavailable/u,
    );
  });
});

test("gate manifest writer is one-shot, bounded, and excludes config secrets and raw target values", () => {
  withRun((paths) => {
    writeStage2AcceptanceManifest(paths.evidenceRoot, gateManifest());
    const bytes = readFileSync(join(paths.evidenceRoot, "s2-acceptance-manifest.json"), "utf8");
    assert.equal(bytes.includes(secret), false);
    assert.equal(bytes.includes(targetUrl), false);
    assert.deepEqual(JSON.parse(bytes), gateManifest());
    assert.throws(
      () => writeStage2AcceptanceManifest(paths.evidenceRoot, gateManifest()),
      /acceptance-gate evidence unavailable/u,
    );
  });
});

test("local ports bind quality, isolated Review, manifest, and exact finalization in order", async () => {
  const calls: unknown[] = [];
  const paths = layoutPaths(resolve("protected-storage"));
  const executionerRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const npmExecPath = process.env.npm_execpath;
  if (process.platform === "win32") {
    assert.equal(typeof npmExecPath, "string");
    assert.equal(isAbsolute(npmExecPath ?? ""), true);
    assert.equal(admittedNpmCliPath(npmExecPath, process.execPath), npmExecPath);
  }
  const ports = createLocalStage2AcceptancePorts(executionerRoot, {
    sourceCapture: () => ({
      repositoryRoot: resolve("repository"),
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    }),
    configCapture: () => ({
      configSha256: "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      contractRevision: "s2-owner-inputs-v1",
      revisionId: "revision_0123456789abcdef",
      approvalId: "approval_0123456789abcdef",
      journeyId: "journey_0123456789abcdef",
      targetHandleId: "target_ref_0123456789abcdef",
    }),
    command: {
      run: async (executable, args, options) => {
        calls.push(["quality", executable, args, options.cwd]);
        return 0;
      },
    },
    live: {
      run: async (args) => {
        calls.push(["live", args]);
        return 0;
      },
    },
    resultRead: () => reviewPacket(),
    manifestWrite: (_root, manifest) => calls.push(["manifest", manifest.cleanup]),
    completionAudit: async (root) => calls.push(["audit", root]),
    finalize: async (request) => calls.push(["finalize", request]),
  });

  assert.equal(await ports.quality.run(), 0);
  assert.equal(await ports.journey.run(paths), 0);
  await ports.cleanup.finalize(paths, gateManifest());
  assert.deepEqual(calls, [
    process.platform === "win32"
      ? ["quality", process.execPath, [npmExecPath, "run", "quality"], executionerRoot]
      : ["quality", "npm", ["run", "quality"], executionerRoot],
    ["live", [
      "--config", paths.configPath,
      "--stop-after", "review",
      "--evidence-root", paths.evidenceRoot,
    ]],
    ["manifest", "pending_exact_finalization"],
    ["audit", paths.evidenceRoot],
    ["finalize", {
      storageRoot: resolve("protected-storage"),
      ownerConfigPath: paths.configPath,
      evidenceRoot: paths.evidenceRoot,
    }],
  ]);
});

test("local ports fail closed before finalization when Review completion audit is denied", async () => {
  let finalized = false;
  const paths = layoutPaths(resolve("protected-storage"));
  const ports = createLocalStage2AcceptancePorts(resolve("executioner"), {
    manifestWrite: () => undefined,
    completionAudit: async () => { throw new Error("injected audit denial"); },
    finalize: async () => { finalized = true; },
  });

  await assert.rejects(ports.cleanup.finalize(paths, gateManifest()), /injected audit denial/u);
  assert.equal(finalized, false);
});

test("real local failure composition seals terminal, process, disposal, and retained storage", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-local-failure-"));
  try {
    const layout = await prepareStage2RunStorage({
      storageRoot,
      runKey: "run_20260828_failureaudit0001",
    }, { protect: async () => undefined });
    const owner = {
      schemaVersion: 1,
      contractRevision: "s2-owner-inputs-v1",
      revisionId: "revision_0123456789abcdef",
      journeyId: "journey_0123456789abcdef",
      target: {
        handleId: "target_ref_0123456789abcdef",
        url: "https://tenant.wd5.myworkdayjobs.com/en-US/Careers/job/Title_R12345",
        host: "tenant.wd5.myworkdayjobs.com",
        tenant: "tenant",
        posting: "R12345",
      },
      approval: { approvalId: "approval_0123456789abcdef" },
      roots: {
        runtime: { path: layout.runtimeRoot },
        secrets: { path: layout.secretsRoot },
        evidence: { path: layout.evidenceRoot },
      },
      policy: { cleanupLeaseHours: 24, retentionDays: 30 },
    };
    writeFileSync(layout.ownerConfigPath, JSON.stringify(owner), "utf8");
    const config = captureStage2Config(layout.ownerConfigPath);
    mkdirSync(join(layout.evidenceRoot, "monitor"));
    writeFileSync(
      join(layout.evidenceRoot, "monitor", "0001-questionnaire-state_observed.ack.json"),
      "{}",
      "utf8",
    );
    writeFileSync(join(layout.evidenceRoot, "terminal-artifact.json"), JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-terminal-artifact-v1",
      resultCode: "pre_review_failed",
      terminal: {
        schemaVersion: 4,
        journeyId: owner.journeyId,
        status: "failed",
        completedPages: 3,
        errorCode: "browser_effect_uncertain",
      },
    }), "utf8");
    writeFileSync(
      join(layout.evidenceRoot, "external-monitor-observer-failure.json"),
      JSON.stringify({ status: "failed", failureCode: "structure_classification" }),
      "utf8",
    );
    writeFileSync(join(layout.evidenceRoot, "process-audit.json"), JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-windows-process-audit-v2",
      status: "pass",
      runKey: layout.runKey,
      journeyId: owner.journeyId,
      targetHandleId: owner.target.handleId,
      configSha256: config.configSha256,
      processLiveNonceSha256: "a".repeat(64),
      processIssuedAt: "2026-08-28T12:00:00.000Z",
      processOwnerPid: 1234,
      processOwnerStartedAt: "2026-08-28T12:00:01.000Z",
      processExitObservedAt: "2026-08-28T12:01:00.000Z",
      jobCloseApplied: true,
      membersObservedBeforeClose: 0,
      membersAliveAfterClose: 0,
      monitorFileCount: 1,
      monitorChainSha256: "b".repeat(64),
      checkedAt: "2026-08-28T12:01:01.000Z",
    }), "utf8");
    const ports = createLocalStage2AcceptancePorts(resolve("executioner"), {
      sourceCapture: () => ({
        repositoryRoot: resolve("repository"),
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      }),
    });

    await ports.cleanup.sealFailure?.({
      configPath: layout.ownerConfigPath,
      evidenceRoot: layout.evidenceRoot,
    }, "real_journey_failed", {
      source: {
        repositoryRoot: resolve("repository"),
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      },
      config,
    });

    assert.equal(existsSync(layout.transientRoot), false);
    assert.equal(JSON.parse(readFileSync(join(layout.evidenceRoot, "completion-audit.json"), "utf8"))
      .runStatus, "failed");
    assert.equal(JSON.parse(readFileSync(join(layout.evidenceRoot, "disposal-audit.json"), "utf8"))
      .status, "pass");
    assert.equal(readStage2StorageCatalog(storageRoot).entries[0]?.runStatus, "failed");
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("real gate-to-local composition seals every post-journey terminal against its admitted source", async () => {
  const scenarios = [
    { key: "failterminal0001", terminal: "failed", journeyCode: 1, expected: "real_journey_failed" },
    { key: "blockterminal001", terminal: "blocked", journeyCode: 1, expected: "real_journey_failed" },
    { key: "cancelterminal01", terminal: "cancelled", journeyCode: 130, expected: "operation_cancelled" },
    { key: "sourcedrift00000", terminal: "review_reached", journeyCode: 0, expected: "source_changed" },
    { key: "configdrift00000", terminal: "review_reached", journeyCode: 0, expected: "config_changed" },
    { key: "reviewreconcile1", terminal: "review_reached", journeyCode: 0, expected: "result_reconciliation_failed" },
  ] as const;
  for (const scenario of scenarios) {
    const storageRoot = mkdtempSync(join(tmpdir(), `hunt-s2-gate-${scenario.key}-`));
    try {
      const layout = await prepareStage2RunStorage({
        storageRoot,
        runKey: `run_20260828_${scenario.key}`,
      }, { protect: async () => undefined });
      const owner = failureOwner(layout);
      writeFileSync(layout.ownerConfigPath, JSON.stringify(owner), "utf8");
      const admittedConfig = captureStage2Config(layout.ownerConfigPath);
      const admittedSource = {
        repositoryRoot: resolve("repository"),
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      };
      let sourceCaptures = 0;
      let configCaptures = 0;
      const ports = createLocalStage2AcceptancePorts(resolve("executioner"), {
        sourceCapture: () => {
          sourceCaptures += 1;
          return scenario.expected === "source_changed" && sourceCaptures >= 3
            ? { ...admittedSource, sourceRevision: "1123456789abcdef0123456789abcdef01234567" }
            : admittedSource;
        },
        configCapture: () => {
          configCaptures += 1;
          return scenario.expected === "config_changed" && configCaptures >= 3
            ? { ...admittedConfig, configSha256: "f".repeat(64) }
            : admittedConfig;
        },
        command: { run: async () => 0 },
        live: { run: async () => {
          seedFailureEvidence(layout, owner, admittedConfig, scenario.terminal);
          return scenario.journeyCode;
        } },
        resultRead: () => ({
          ...reviewPacket(),
          sourceRevision: admittedSource.sourceRevision,
          configSha256: scenario.expected === "result_reconciliation_failed"
            ? "e".repeat(64)
            : admittedConfig.configSha256,
        }),
      });
      const result = await runStage2RealAcceptance({
        configPath: layout.ownerConfigPath,
        evidenceRoot: layout.evidenceRoot,
      }, ports);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("failure scenario unexpectedly passed");
      assert.equal(result.code, scenario.expected);
      assert.equal(result.cleanup, "retained_for_exact_reconciliation");
      assert.equal(existsSync(layout.transientRoot), false);
      const audit = JSON.parse(readFileSync(
        join(layout.evidenceRoot, "completion-audit.json"), "utf8",
      ));
      assert.equal(audit.gateFailureCode, scenario.expected);
      assert.equal(audit.terminalStatus, scenario.terminal);
      assert.equal(audit.sourceRevision, admittedSource.sourceRevision);
      const binding = JSON.parse(readFileSync(
        join(layout.evidenceRoot, "failure-source-binding.json"), "utf8",
      ));
      assert.equal(binding.configSha256, admittedConfig.configSha256);
      assert.equal(binding.sourceRevision, admittedSource.sourceRevision);
      assert.equal(JSON.parse(readFileSync(join(layout.evidenceRoot, "disposal-audit.json"), "utf8"))
        .status, "pass");
      assert.equal(readStage2StorageCatalog(storageRoot).entries[0]?.runStatus,
        scenario.terminal === "blocked" ? "blocked" : "failed");
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  }
});

test("local command converts a synchronous spawn denial to a stable failure code", async () => {
  const command = new LocalStage2Command();
  assert.equal(await command.run("\0", [], { cwd: resolve("executioner") }), 1);
});

test("local command returns cancellation before attempting a child launch", async () => {
  const controller = new AbortController();
  controller.abort();
  const command = new LocalStage2Command();
  assert.equal(await command.run("\0", [], {
    cwd: resolve("executioner"),
    signal: controller.signal,
  }), 130);
});

test("Windows quality fails closed when npm_execpath is not an admitted absolute CLI", {
  skip: process.platform !== "win32",
}, async () => {
  const previous = process.env.npm_execpath;
  let invoked = false;
  process.env.npm_execpath = "npm-cli.js";
  try {
    const ports = createLocalStage2AcceptancePorts(resolve("executioner"), {
      command: {
        run: async () => {
          invoked = true;
          return 0;
        },
      },
    });
    assert.equal(await ports.quality.run(), 1);
    assert.equal(invoked, false);
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  }
});

test("npm CLI admission binds to the exact current Node installation", () => {
  withNpmLayout(({ expectedCli, nodeExecutable, root }) => {
    writeFileSync(expectedCli, "console.log('npm')", "utf8");
    assert.equal(admittedNpmCliPath(expectedCli, nodeExecutable), expectedCli);

    const copiedCli = join(root, "copied", "npm-cli.js");
    mkdirSync(resolve(copiedCli, ".."), { recursive: true });
    copyFileSync(expectedCli, copiedCli);
    assert.throws(
      () => admittedNpmCliPath(copiedCli, nodeExecutable),
      /npm executable denied/u,
    );
  });
});

test("npm CLI admission rejects a hard-linked bundled CLI", () => {
  withNpmLayout(({ expectedCli, nodeExecutable, root }) => {
    const source = join(root, "source.js");
    writeFileSync(source, "console.log('npm')", "utf8");
    linkSync(source, expectedCli);
    assert.throws(
      () => admittedNpmCliPath(expectedCli, nodeExecutable),
      /npm executable denied/u,
    );
  });
});

test("npm CLI admission rejects a missing bundled CLI", () => {
  withNpmLayout(({ expectedCli, nodeExecutable }) => {
    assert.throws(
      () => admittedNpmCliPath(expectedCli, nodeExecutable),
      /npm executable denied/u,
    );
  });
});

test("npm CLI admission rejects a directory in the bundled CLI slot", () => {
  withNpmLayout(({ expectedCli, nodeExecutable }) => {
    mkdirSync(expectedCli);
    assert.throws(
      () => admittedNpmCliPath(expectedCli, nodeExecutable),
      /npm executable denied/u,
    );
  });
});

test("npm CLI admission rejects wrong-name and UNC paths", () => {
  withNpmLayout(({ expectedCli, nodeExecutable }) => {
    const wrongName = join(resolve(expectedCli, ".."), "npm.js");
    writeFileSync(wrongName, "console.log('npm')", "utf8");
    assert.throws(
      () => admittedNpmCliPath(wrongName, nodeExecutable),
      /npm executable denied/u,
    );
    assert.throws(
      () => admittedNpmCliPath("\\\\server\\share\\npm-cli.js", nodeExecutable),
      /npm executable denied/u,
    );
  });
});

test("npm CLI admission rejects symlinked path lineage", () => {
  withNpmLayout(({ expectedCli, nodeExecutable, root }) => {
    const expectedBin = resolve(expectedCli, "..");
    const externalBin = join(root, "external-bin");
    rmSync(expectedBin, { recursive: true, force: true });
    mkdirSync(externalBin);
    writeFileSync(join(externalBin, "npm-cli.js"), "console.log('npm')", "utf8");
    symlinkSync(externalBin, expectedBin, "junction");
    assert.throws(
      () => admittedNpmCliPath(expectedCli, nodeExecutable),
      /npm executable denied/u,
    );
  });
});

function ownerConfig() {
  return {
    schemaVersion: 1,
    contractRevision: "s2-owner-inputs-v1",
    revisionId: "revision_0123456789abcdef",
    journeyId: "journey_0123456789abcdef",
    target: { handleId: "target_ref_0123456789abcdef", url: targetUrl },
    approval: { approvalId: "approval_0123456789abcdef" },
    accountSecret: { value: secret },
  };
}

function failureOwner(layout: Awaited<ReturnType<typeof prepareStage2RunStorage>>) {
  return {
    schemaVersion: 1,
    contractRevision: "s2-owner-inputs-v1",
    revisionId: "revision_0123456789abcdef",
    journeyId: "journey_0123456789abcdef",
    target: {
      handleId: "target_ref_0123456789abcdef",
      url: targetUrl,
      host: "tenant.wd5.myworkdayjobs.com",
      tenant: "tenant",
      posting: "R12345",
    },
    approval: { approvalId: "approval_0123456789abcdef" },
    roots: {
      runtime: { path: layout.runtimeRoot },
      secrets: { path: layout.secretsRoot },
      evidence: { path: layout.evidenceRoot },
    },
    policy: { cleanupLeaseHours: 24, retentionDays: 30 },
  };
}

function seedFailureEvidence(
  layout: Awaited<ReturnType<typeof prepareStage2RunStorage>>,
  owner: ReturnType<typeof failureOwner>,
  config: ReturnType<typeof captureStage2Config>,
  status: "review_reached" | "blocked" | "cancelled" | "failed",
): void {
  mkdirSync(join(layout.evidenceRoot, "monitor"));
  writeFileSync(
    join(layout.evidenceRoot, "monitor", "0001-questionnaire-state_observed.ack.json"),
    "{}", "utf8",
  );
  const terminal = status === "failed"
    ? { schemaVersion: 4, journeyId: owner.journeyId, status, completedPages: 3,
      errorCode: "browser_effect_uncertain" }
    : status === "blocked"
    ? { schemaVersion: 4, journeyId: owner.journeyId, status, completedPages: 2,
      factualOutcome: { source: "target_identity", result: {
        kind: "posting_unavailable", reason: "closed",
      } } }
    : { schemaVersion: 4, journeyId: owner.journeyId, status, completedPages: 6 };
  writeFileSync(join(layout.evidenceRoot, "terminal-artifact.json"), JSON.stringify({
    schemaVersion: 1,
    evidenceRevision: "s2-terminal-artifact-v1",
    resultCode: status === "review_reached" ? "review_reached" : `application_${status}`,
    terminal,
  }), "utf8");
  writeFileSync(join(layout.evidenceRoot, "process-audit.json"), JSON.stringify({
    schemaVersion: 1,
    evidenceRevision: "s2-windows-process-audit-v2",
    status: "pass",
    runKey: layout.runKey,
    journeyId: owner.journeyId,
    targetHandleId: owner.target.handleId,
    configSha256: config.configSha256,
    processLiveNonceSha256: "a".repeat(64),
    processIssuedAt: "2026-08-28T12:00:00.000Z",
    processOwnerPid: 1234,
    processOwnerStartedAt: "2026-08-28T12:00:01.000Z",
    processExitObservedAt: "2026-08-28T12:01:00.000Z",
    jobCloseApplied: true,
    membersObservedBeforeClose: 0,
    membersAliveAfterClose: 0,
    monitorFileCount: 1,
    monitorChainSha256: "b".repeat(64),
    checkedAt: "2026-08-28T12:01:01.000Z",
  }), "utf8");
}

function reviewPacket() {
  return {
    schemaVersion: 1,
    evidenceRevision: "s2-review-acceptance-v1",
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    configSha256: "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
    contractRevision: "s2-owner-inputs-v1",
    revisionId: "revision_0123456789abcdef",
    approvalId: "approval_0123456789abcdef",
    journeyId: "journey_0123456789abcdef",
    targetHandleId: "target_ref_0123456789abcdef",
    checkpoint: "review",
    status: "passed",
    reviewProof: "independently_verified",
    submitPresent: true,
    submitActivated: false,
    privacyScan: "pass",
  } as const;
}

function gateManifest(): Stage2AcceptanceManifest {
  const review = reviewPacket();
  return {
    schemaVersion: 1,
    acceptanceRevision: "s2-real-acceptance-gate-v1",
    status: "review_verified",
    sourceRevision: review.sourceRevision,
    configSha256: review.configSha256,
    contractRevision: review.contractRevision,
    revisionId: review.revisionId,
    approvalId: review.approvalId,
    journeyId: review.journeyId,
    targetHandleId: review.targetHandleId,
    checkpoint: "review",
    quality: "pass",
    reviewProof: "independently_verified",
    submitPresent: true,
    submitActivated: false,
    privacyScan: "pass",
    cleanup: "pending_exact_finalization",
  };
}

function layoutPaths(storageRoot: string) {
  const runKey = "run_20260804_abcdefghijklmnop";
  return {
    configPath: resolve(storageRoot, "transient", runKey, "owner-input.json"),
    evidenceRoot: resolve(storageRoot, "retained", runKey, "evidence"),
  };
}

function withRun(operation: (paths: { configPath: string; evidenceRoot: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-acceptance-"));
  const runKey = "run_20260804_abcdefghijklmnop";
  const configPath = resolve(root, "transient", runKey, "owner-input.json");
  const evidenceRoot = resolve(root, "retained", runKey, "evidence");
  mkdirSync(resolve(configPath, ".."), { recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });
  try {
    operation({ configPath, evidenceRoot });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withNpmLayout(operation: (paths: {
  expectedCli: string;
  nodeExecutable: string;
  root: string;
}) => void): void {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-npm-"));
  const nodeExecutable = join(root, "node.exe");
  const expectedCli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(resolve(expectedCli, ".."), { recursive: true });
  writeFileSync(nodeExecutable, "node", "utf8");
  try {
    operation({ expectedCli, nodeExecutable, root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
