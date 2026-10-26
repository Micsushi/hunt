import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { executeStage2AcceptanceCli } from "../../../src/acceptance/s2-cli.ts";
import type { Stage2AcceptanceGatePorts } from "../../../src/acceptance/s2-gate.ts";

const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
const configSha256 = "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";

test("CLI reports a bounded sanitized pass only after exact finalization", async () => {
  const result = await executeStage2AcceptanceCli(args(), passingPorts());
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.output), {
    status: "passed",
    checkpoint: "review",
    sourceRevision,
    configSha256,
    revisionId: "revision_0123456789abcdef",
    submitActivated: false,
    privacyScan: "pass",
    cleanup: "exact_finalization_passed",
  });
});

test("CLI admission and gate failures expose no path, URL, or exception detail", async () => {
  const bad = await executeStage2AcceptanceCli(["--config", "private.json"], passingPorts());
  assert.deepEqual(bad, {
    exitCode: 2,
    output: '{"status":"failed","code":"runner_admission_failed","cleanup":"not_started"}\n',
  });

  const ports = passingPorts();
  ports.quality.run = async () => {
    throw new Error("C:\\private\\owner-input.json https://secret.example");
  };
  const failed = await executeStage2AcceptanceCli(args(), ports);
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(JSON.parse(failed.output), {
    status: "failed",
    code: "quality_failed",
    cleanup: "retained_for_exact_reconciliation",
  });
  assert.equal(failed.output.includes("private"), false);
  assert.equal(failed.output.includes("https"), false);
});

function args(): string[] {
  const root = resolve("protected-storage");
  const runKey = "run_20260804_abcdefghijklmnop";
  return [
    "--config", resolve(root, "transient", runKey, "owner-input.json"),
    "--stop-after", "review",
    "--evidence-root", resolve(root, "retained", runKey, "evidence"),
  ];
}

function passingPorts(): Stage2AcceptanceGatePorts {
  const config = {
    configSha256,
    contractRevision: "s2-owner-inputs-v1",
    revisionId: "revision_0123456789abcdef",
    approvalId: "approval_0123456789abcdef",
    journeyId: "journey_0123456789abcdef",
    targetHandleId: "target_ref_0123456789abcdef",
  } as const;
  return {
    source: { capture: async () => ({ repositoryRoot: resolve("repository"), sourceRevision }) },
    config: { capture: async () => config },
    quality: { run: async () => 0 },
    journey: { run: async () => 0 },
    result: {
      read: async () => ({
        schemaVersion: 1,
        evidenceRevision: "s2-review-acceptance-v1",
        ...config,
        sourceRevision,
        checkpoint: "review",
        status: "passed",
        reviewProof: "independently_verified",
        submitPresent: true,
        submitActivated: false,
        privacyScan: "pass",
      }),
    },
    cleanup: { finalize: async () => undefined },
  };
}
