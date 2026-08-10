import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  captureStage2Config,
  createLocalStage2AcceptancePorts,
  readStage2ReviewAcceptance,
  writeStage2ReviewAcceptance,
  writeStage2AcceptanceManifest,
} from "../../../src/acceptance/s2-local.ts";
import type { Stage2AcceptanceManifest } from "../../../src/acceptance/s2-gate.ts";

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
  const ports = createLocalStage2AcceptancePorts(resolve("executioner"), {
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
    ["quality", process.platform === "win32" ? "npm.cmd" : "npm", ["run", "quality"], resolve("executioner")],
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
