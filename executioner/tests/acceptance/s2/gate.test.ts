import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  parseStage2RealAcceptanceArgs,
  runStage2RealAcceptance,
  type Stage2AcceptanceGatePorts,
  type Stage2ConfigCapture,
  type Stage2AcceptanceManifest,
  type Stage2ReviewAcceptance,
  type Stage2SourceCapture,
} from "../../../src/acceptance/s2-gate.ts";

const source: Stage2SourceCapture = Object.freeze({
  repositoryRoot: resolve("repository"),
  sourceRevision: "0123456789abcdef0123456789abcdef01234567",
});
const config: Stage2ConfigCapture = Object.freeze({
  configSha256: "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
  contractRevision: "s2-owner-inputs-v1",
  revisionId: "revision_0123456789abcdef",
  approvalId: "approval_0123456789abcdef",
  journeyId: "journey_0123456789abcdef",
  targetHandleId: "target_ref_0123456789abcdef",
});
const review: Stage2ReviewAcceptance = Object.freeze({
  schemaVersion: 1,
  evidenceRevision: "s2-review-acceptance-v1",
  sourceRevision: source.sourceRevision,
  configSha256: config.configSha256,
  contractRevision: config.contractRevision,
  revisionId: config.revisionId,
  approvalId: config.approvalId,
  journeyId: config.journeyId,
  targetHandleId: config.targetHandleId,
  checkpoint: "review",
  status: "passed",
  reviewProof: "independently_verified",
  submitPresent: true,
  submitActivated: false,
  privacyScan: "pass",
});

test("the S2 gate accepts only the exact Review invocation and bound storage layout", () => {
  const args = layout("abcdefghijklmnop");
  assert.deepEqual(parseStage2RealAcceptanceArgs([
    "--config", args.configPath,
    "--stop-after", "review",
    "--evidence-root", args.evidenceRoot,
  ]), args);

  for (const values of [
    [],
    ["--config", args.configPath, "--stop-after", "account_verified", "--evidence-root", args.evidenceRoot],
    ["--config", args.configPath, "--stop-after", "review"],
    ["--config", args.configPath, "--config", args.configPath, "--stop-after", "review"],
    ["--config", "owner-input.json", "--stop-after", "review", "--evidence-root", args.evidenceRoot],
    ["--config", args.configPath, "--stop-after", "review", "--evidence-root", layout("qrstuvwxyzabcdef").evidenceRoot],
  ]) {
    assert.throws(() => parseStage2RealAcceptanceArgs(values), /invalid S2 acceptance arguments/u);
  }
});

test("the S2 gate runs quality and the journey on one immutable source and config before exact finalization", async () => {
  const calls: string[] = [];
  const result = await runStage2RealAcceptance(layout("abcdefghijklmnop"), ports(calls));

  assert.deepEqual(result, {
    ok: true,
    manifest: {
      schemaVersion: 1,
      acceptanceRevision: "s2-real-acceptance-gate-v1",
      status: "review_verified",
      sourceRevision: source.sourceRevision,
      configSha256: config.configSha256,
      contractRevision: config.contractRevision,
      revisionId: config.revisionId,
      approvalId: config.approvalId,
      journeyId: config.journeyId,
      targetHandleId: config.targetHandleId,
      checkpoint: "review",
      quality: "pass",
      reviewProof: "independently_verified",
      submitPresent: true,
      submitActivated: false,
      privacyScan: "pass",
      cleanup: "pending_exact_finalization",
    },
  });
  assert.deepEqual(calls, [
    "source", "config", "quality",
    "source", "config", "journey",
    "source", "config", "result", "finalize",
  ]);
});

test("quality failure stops before the live dependency and leaves exact cleanup to the operator", async () => {
  const calls: string[] = [];
  const dependencies = ports(calls);
  dependencies.quality.run = async () => {
    calls.push("quality");
    return 1;
  };

  assert.deepEqual(await runStage2RealAcceptance(layout("abcdefghijklmnop"), dependencies), {
    ok: false,
    code: "quality_failed",
    cleanup: "retained_for_exact_reconciliation",
  });
  assert.deepEqual(calls, ["source", "config", "quality"]);
});

test("repo-local config or evidence stops before quality", async () => {
  const calls: string[] = [];
  const dependencies = ports(calls);
  dependencies.source.capture = async () => {
    calls.push("source");
    return { ...source, repositoryRoot: resolve(".") };
  };
  assert.deepEqual(await runStage2RealAcceptance(
    layout("abcdefghijklmnop"),
    dependencies,
  ), {
    ok: false,
    code: "preflight_failed",
    cleanup: "retained_for_exact_reconciliation",
  });
  assert.deepEqual(calls, ["source", "config"]);
});

test("source or config drift stops before the real journey", async () => {
  for (const changed of ["source", "config"] as const) {
    const calls: string[] = [];
    const dependencies = ports(calls);
    let captures = 0;
    if (changed === "source") {
      dependencies.source.capture = async () => ({
        ...source,
        sourceRevision: ++captures === 1
          ? source.sourceRevision
          : "1123456789abcdef0123456789abcdef01234567",
      });
    } else {
      dependencies.config.capture = async () => ({
        ...config,
        configSha256: ++captures === 1
          ? config.configSha256
          : "99abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      });
    }
    assert.deepEqual(await runStage2RealAcceptance(layout("abcdefghijklmnop"), dependencies), {
      ok: false,
      code: `${changed}_changed`,
      cleanup: "retained_for_exact_reconciliation",
    });
    assert.equal(calls.includes("journey"), false);
    assert.equal(calls.includes("finalize"), false);
    assert.equal(calls.includes("seal-failure"), false);
  }
});

test("source capture normalizes the slash form emitted by Git on Windows", async () => {
  const calls: string[] = [];
  const dependencies = ports(calls);
  dependencies.source.capture = async () => ({
    ...source,
    repositoryRoot: source.repositoryRoot.replaceAll("\\", "/"),
  });
  assert.equal((await runStage2RealAcceptance(
    layout("abcdefghijklmnop"),
    dependencies,
  )).ok, true);
});

test("drift first observed after the live journey blocks reconciliation and finalization", async () => {
  for (const changed of ["source", "config"] as const) {
    const calls: string[] = [];
    const dependencies = ports(calls);
    let captures = 0;
    if (changed === "source") {
      dependencies.source.capture = async () => ({
        ...source,
        sourceRevision: ++captures < 3
          ? source.sourceRevision
          : "2123456789abcdef0123456789abcdef01234567",
      });
    } else {
      dependencies.config.capture = async () => ({
        ...config,
        configSha256: ++captures < 3
          ? config.configSha256
          : "79abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      });
    }
    const result = await runStage2RealAcceptance(layout("abcdefghijklmnop"), dependencies);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, `${changed}_changed`);
    assert.equal(calls.includes("journey"), true);
    assert.equal(calls.includes("result"), false);
    assert.equal(calls.includes("finalize"), false);
  }
});

test("exact finalizer failure cannot produce a passing gate", async () => {
  const calls: string[] = [];
  const dependencies = ports(calls);
  dependencies.cleanup.finalize = async () => {
    calls.push("finalize");
    throw new Error("denied");
  };
  assert.deepEqual(await runStage2RealAcceptance(layout("abcdefghijklmnop"), dependencies), {
    ok: false,
    code: "cleanup_finalize_failed",
    cleanup: "retained_for_exact_reconciliation",
  });
  assert.equal(calls.some((call) => call === "discard"), false);
});

test("journey failure, cancellation, and Review mismatch seal retained evidence without success finalization", async () => {
  for (const scenario of ["journey", "cancelled", "mismatch"] as const) {
    const calls: string[] = [];
    const dependencies = ports(calls);
    const controller = new AbortController();
    if (scenario === "journey") dependencies.journey.run = async () => 1;
    if (scenario === "cancelled") {
      dependencies.journey.run = async () => {
        controller.abort();
        return 130;
      };
    }
    if (scenario === "mismatch") {
      dependencies.result.read = async () => ({ ...review, submitActivated: true as never });
    }

    const result = await runStage2RealAcceptance(
      layout("abcdefghijklmnop"),
      dependencies,
      controller.signal,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, scenario === "journey"
        ? "real_journey_failed"
        : scenario === "cancelled"
        ? "operation_cancelled"
        : "result_reconciliation_failed");
      assert.equal(result.cleanup, "retained_for_exact_reconciliation");
    }
    assert.equal(calls.includes("finalize"), false);
    assert.equal(calls.includes("seal-failure"), true);
    assert.equal(calls.some((call) => call === "discard"), false);
  }
});

function ports(calls: string[]): Stage2AcceptanceGatePorts {
  return {
    source: {
      capture: async () => {
        calls.push("source");
        return source;
      },
    },
    config: {
      capture: async () => {
        calls.push("config");
        return config;
      },
    },
    quality: {
      run: async () => {
        calls.push("quality");
        return 0;
      },
    },
    journey: {
      run: async () => {
        calls.push("journey");
        return 0;
      },
    },
    result: {
      read: async () => {
        calls.push("result");
        return review;
      },
    },
    cleanup: {
      finalize: async (_args, manifest: Stage2AcceptanceManifest) => {
        calls.push("finalize");
        assert.equal(manifest.cleanup, "pending_exact_finalization");
      },
      sealFailure: async () => {
        calls.push("seal-failure");
      },
    },
  };
}

function layout(nonce: string) {
  const storageRoot = resolve("protected-storage");
  const runKey = `run_20260804_${nonce}`;
  return Object.freeze({
    configPath: resolve(storageRoot, "transient", runKey, "owner-input.json"),
    evidenceRoot: resolve(storageRoot, "retained", runKey, "evidence"),
  });
}
