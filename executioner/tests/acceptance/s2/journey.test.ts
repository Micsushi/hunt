import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  browserPageId,
  browserTargetToken,
  boundedText,
  fieldId,
  generatedOperationId,
  journeyId as exactJourneyId,
  type DurableJourneyState,
  type SemanticPageSnapshot,
} from "../../../src/contracts/index.ts";
import type {
  RecoverBrowserInterruptionInput,
  RecoveryBrowserPageTruth,
  RecoveryCheckpoint,
  RecoveryDependencies,
} from "../../../src/journey/recovery/index.ts";
import {
  runStage2RealJourney,
  type Stage2RealJourneyRuntime,
  type Stage2RealJourneyRuntimeBinding,
} from "../../../src/acceptance/s2-journey.ts";
import { writeStage2TerminalArtifact } from "../../../src/acceptance/s2-terminal-artifact.ts";
import { reviewPageFixture } from "../../interaction/review/fixtures.ts";

const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
const config = Object.freeze({
  configSha256: "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
  contractRevision: "s2-owner-inputs-v1",
  revisionId: "revision_0123456789abcdef",
  approvalId: "approval_0123456789abcdef",
  journeyId: "journey_0123456789abcdef",
  targetHandleId: "target_ref_0123456789abcdef",
});

test("the unavailable opaque runtime binding fails before any journey effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-unbound-terminal-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot),
      undefined,
      ports(),
      new AbortController().signal,
    );
    assertFailureCode(result, "runtime_binding_failed");
    assert.deepEqual(JSON.parse(readFileSync(join(evidenceRoot, "terminal-artifact.json"), "utf8")), {
      schemaVersion: 1,
      evidenceRevision: "s2-terminal-artifact-v1",
      resultCode: "runtime_binding_failed",
      terminal: {
        schemaVersion: 4,
        journeyId: config.journeyId,
        status: "failed",
        completedPages: 0,
        errorCode: "owner_config_invalid",
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-source binding denial keeps its safe causal terminal code", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-owner-source-terminal-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot),
      { bind: async () => { throw new TypeError("application owner source denied"); } },
      ports(),
      new AbortController().signal,
    );
    assertFailureCode(result, "runtime_binding_failed");
    assert.equal(result.terminal.status, "failed");
    if (result.terminal.status === "failed") {
      assert.equal(result.terminal.errorCode, "owner_config_invalid");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-aborted journeys persist a cancelled terminal without binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-pre-aborted-terminal-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await runStage2RealJourney(invocation(evidenceRoot), undefined, ports(), controller.signal);
    assertFailureCode(result, "operation_cancelled");
    assert.equal(JSON.parse(readFileSync(join(evidenceRoot, "terminal-artifact.json"), "utf8")).terminal.status,
      "cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one bound runtime recovers, proves pre-Review and Review, seals evidence, then cleans", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-journey-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const calls: string[] = [];
  let accepted: unknown;
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot),
      binding(runtime(calls, evidenceRoot)),
      {
        now: () => "2026-08-05T12:00:00.000Z",
        writeAcceptance: async (_root, value) => {
          calls.push("acceptance.write");
          accepted = value;
        },
        writeTerminalArtifact: async (root, value) => {
          calls.push("terminal-artifact.write");
          writeStage2TerminalArtifact(root, value);
        },
      },
      new AbortController().signal,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      "runtime.bind",
      "account.verify",
      "recovery.pending",
      "recovery.state.load",
      "recovery.browser.inspect",
      "recovery.state.save",
      "recovery.record",
      "application.run",
      "review.capture",
      "privacy.forbiddenTokens",
      "acceptance.write",
      "cleanup.close",
      "terminal-artifact.write",
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(evidenceRoot, "terminal-artifact.json"), "utf8")), {
      schemaVersion: 1,
      evidenceRevision: "s2-terminal-artifact-v1",
      resultCode: "review_reached",
      terminal: {
        schemaVersion: 4,
        journeyId: config.journeyId,
        status: "review_reached",
        completedPages: 3,
      },
    });
    assert.deepEqual(accepted, {
      schemaVersion: 1,
      evidenceRevision: "s2-review-acceptance-v1",
      sourceRevision,
      ...config,
      checkpoint: "review",
      status: "passed",
      reviewProof: "independently_verified",
      submitPresent: true,
      submitActivated: false,
      privacyScan: "pass",
    });
    const packetRoot = join(evidenceRoot, "real-evidence");
    assert.equal(existsSync(join(packetRoot, "browser-truth.json")), true);
    assert.equal(existsSync(join(packetRoot, "summary.json")), true);
    const manifest = JSON.parse(readFileSync(join(packetRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.sourceRevision, sourceRevision);
    assert.equal(manifest.journeyId, config.journeyId);
    assert.equal(manifest.privacyScan, "pass");
    assert.equal(manifest.retention.rawDomRetained, false);
    assert.equal(manifest.retention.screenshotsRetained, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tenant-skipped Resume is recorded as missing rather than falsely verified", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-journey-skipped-resume-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const value = runtime([], evidenceRoot);
  value.recovery.pending = async () => null;
  value.application.run = async () => {
    const baseline = preReview();
    return {
      ok: true,
      value: {
        ...baseline,
        completedPages: 2,
        pageChecks: [baseline.pageChecks[0]!, baseline.pageChecks[2]!],
      },
    };
  };
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot), binding(value), ports(), new AbortController().signal,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const summary = JSON.parse(readFileSync(
      join(evidenceRoot, "real-evidence", "summary.json"), "utf8",
    ));
    assert.deepEqual(summary.verificationSummaries[1], {
      kind: "resume",
      status: "missing",
      verifiedCount: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance write failure retains recovery and stale terminal evidence blocks retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-journey-retry-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const cleanupModes: boolean[] = [];
  try {
    const first = runtime([], evidenceRoot);
    first.recovery.pending = async () => null;
    first.cleanup.close = async (_signal, accepted = false) => {
      cleanupModes.push(accepted);
      return true;
    };
    assertFailureCode(await runStage2RealJourney(
      invocation(evidenceRoot), binding(first), {
        now: () => "2026-08-05T12:00:00.000Z",
        writeAcceptance: async () => { throw new Error("injected acceptance write failure"); },
      }, new AbortController().signal,
    ), "evidence_failed");
    assert.equal(existsSync(join(evidenceRoot, "real-evidence", "manifest.json")), true);
    assert.deepEqual(cleanupModes, [false]);
    assert.equal(JSON.parse(readFileSync(join(evidenceRoot, "terminal-artifact.json"), "utf8")).resultCode,
      "evidence_failed");

    const second = runtime([], evidenceRoot);
    second.recovery.pending = async () => null;
    second.cleanup.close = async (_signal, accepted = false) => {
      cleanupModes.push(accepted);
      return true;
    };
    const retry = await runStage2RealJourney(
      invocation(evidenceRoot), binding(second), {
        now: () => "2026-08-06T12:00:00.000Z",
        writeAcceptance: async () => undefined,
      }, new AbortController().signal,
    );
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(retry.terminalArtifactErrorCode, "terminal_artifact_persistence_failed");
    assert.deepEqual(cleanupModes, [false, true]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const checkpoint of ["resume", "questionnaire", "review"] as const) {
  test(`recovery at ${checkpoint} passes the exact durable walk cursor`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-recover-${checkpoint}-`));
    const evidenceRoot = resolve(root, "evidence");
    mkdirSync(evidenceRoot);
    const value = runtime([], evidenceRoot);
    const plan = recoveryPlan([], checkpoint);
    let received: unknown;
    value.recovery.pending = async () => plan;
    value.application.run = async (_signal, resume) => {
      received = resume;
      return { ok: true, value: preReview() };
    };
    try {
      assert.equal((await runStage2RealJourney(
        invocation(evidenceRoot), binding(value), ports(), new AbortController().signal,
      )).ok, true);
      assert.deepEqual((received as { currentPage?: unknown }).currentPage,
        checkpoint === "review" ? "pre_review" : checkpoint);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a recovery stop fails closed before application and still cleans the bound runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-recovery-stop-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const calls: string[] = [];
  const value = runtime(calls, evidenceRoot);
  value.recovery.pending = async () => ({
    ...recoveryPlan(calls),
    input: {
      ...recoveryPlan(calls).input,
      interruption: { code: "browser_effect_uncertain", effect: "possible" },
    },
  });
  try {
    assertFailureCode(await runStage2RealJourney(
      invocation(evidenceRoot),
      binding(value),
      ports(),
      new AbortController().signal,
    ), "recovery_failed");
    assert.equal(calls.includes("application.run"), false);
    assert.equal(calls.at(-1), "cleanup.close");
    assert.equal(existsSync(join(evidenceRoot, "real-evidence")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account proof failure preserves CAPTCHA fact and stops before recovery or application", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-stop-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const calls: string[] = [];
  const value = runtime(calls, evidenceRoot);
  value.account.verify = async () => {
    calls.push("account.verify");
    return {
      ok: false,
      code: "manual_intervention",
      fact: { kind: "manual_intervention", reason: "captcha" },
    };
  };
  try {
    assertFailureCode(await runStage2RealJourney(
      invocation(evidenceRoot), binding(value), ports(), new AbortController().signal,
    ), "captcha");
    assert.deepEqual(calls, ["runtime.bind", "account.verify", "cleanup.close"]);
    assert.equal(existsSync(join(evidenceRoot, "real-evidence")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account posting fact becomes an exact value-free terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-fact-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const value = runtime([], evidenceRoot);
  value.account.verify = async () => ({
    ok: false,
    code: "posting_unavailable",
    fact: { kind: "posting_unavailable", reason: "closed" },
  });
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot), binding(value), ports(), new AbortController().signal,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.terminal, {
      schemaVersion: 4,
      journeyId: config.journeyId,
      status: "blocked",
      completedPages: 0,
      factualOutcome: {
        source: "target_identity",
        result: { kind: "posting_unavailable", reason: "closed" },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider cancellation remains a cancelled terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-provider-cancel-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const value = runtime([], evidenceRoot);
  value.account.verify = async () => ({ ok: false, code: "operation_cancelled" });
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot), binding(value), ports(), new AbortController().signal,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.terminal.status, "cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("application failure preserves its exact code and completed-page count", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-terminal-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const value = runtime([], evidenceRoot);
  value.recovery.pending = async () => null;
  value.application.run = async () => ({
    ok: false,
    error: {
      checkpoint: "questionnaire",
      completedPages: 4,
      failure: {
        code: "question_unknown",
        retryable: false,
        owner: "questionnaire",
        classifier: "questionnaire_page",
        primitive: "question_control",
        unknownLayer: "question",
        page: "questionnaire",
        attempt: 1,
      },
      submitActivated: false,
      privacyScan: "pass",
    },
  });
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot), binding(value), ports(), new AbortController().signal,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.terminal, {
      schemaVersion: 4,
      journeyId: config.journeyId,
      status: "failed",
      completedPages: 4,
      errorCode: "question_unknown",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runStage2RealJourney retains the failed application owner until release expiry", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-journey-retention-owner-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const calls: string[] = [];
  const value = runtime(calls, evidenceRoot);
  value.recovery.pending = async () => null;
  let retained = false;
  let releaseCalls = 0;
  let closeCalls = 0;
  value.application.run = async () => ({
    ok: false,
    error: {
      checkpoint: "profile",
      completedPages: 1,
      failure: {
        code: "browser_timeout",
        retryable: false,
        owner: "profile",
        classifier: "profile_page",
        primitive: "profile_control",
        unknownLayer: "ui_behavior",
        page: "profile",
        attempt: 1,
      },
      submitActivated: false,
      privacyScan: "pass",
    },
  });
  value.cleanup.preserve = async () => {
    retained = true;
    return true;
  };
  value.cleanup.retentionExpiresAt = () => retained && releaseCalls === 0
    ? new Date(Date.now() + 25).toISOString()
    : undefined;
  value.cleanup.release = async () => {
    releaseCalls += 1;
    calls.push("runtime.release", "monitor.close", "profile.close", "context.close");
    retained = false;
    return true;
  };
  value.cleanup.close = async () => {
    calls.push("fallback.close");
    closeCalls += 1;
    retained = false;
    return true;
  };
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot), binding(value), ports(), new AbortController().signal,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "pre_review_failed");
    assert.equal(result.terminal.status, "failed");
    if (result.terminal.status !== "failed") return;
    assert.equal(result.terminal.errorCode, "browser_timeout");
    assert.equal(retained, true);
    assert.equal(closeCalls, 0);
    for (let attempt = 0; attempt < 50 && releaseCalls === 0; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(releaseCalls, 1);
    assert.equal(retained, false);
    assert.equal(closeCalls, 0);
    assert.equal(result.terminal.status, "failed");
    assert.equal(result.terminal.completedPages, 1);
    assert.deepEqual(calls.slice(-4), [
      "runtime.release",
      "monitor.close",
      "profile.close",
      "context.close",
    ]);
    assert.doesNotMatch(JSON.stringify(result), /submitActivated":true/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runStage2RealJourney falls back once when retention is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-journey-retention-fallback-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const value = runtime([], evidenceRoot);
  value.recovery.pending = async () => null;
  let preserveCalls = 0;
  let closeCalls = 0;
  value.application.run = async () => ({
    ok: false,
    error: {
      checkpoint: "profile",
      completedPages: 1,
      failure: {
        code: "browser_timeout",
        retryable: false,
        owner: "profile",
        classifier: "profile_page",
        primitive: "profile_control",
        unknownLayer: "ui_behavior",
        page: "profile",
        attempt: 1,
      },
      submitActivated: false,
      privacyScan: "pass",
    },
  });
  value.cleanup.preserve = async () => {
    preserveCalls += 1;
    return false;
  };
  value.cleanup.close = async () => {
    closeCalls += 1;
    return true;
  };
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot), binding(value), ports(), new AbortController().signal,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "pre_review_failed");
    assert.equal(result.terminal.status, "failed");
    if (result.terminal.status !== "failed") return;
    assert.equal(result.terminal.errorCode, "browser_timeout");
    assert.equal(preserveCalls, 1);
    assert.equal(closeCalls, 1);
    assert.equal(result.cleanupErrorCode, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup failure does not replace the original journey failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-primary-failure-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const value = runtime([], evidenceRoot);
  value.account.verify = async () => ({ ok: false, code: "browser_effect_uncertain" });
  value.cleanup.close = async () => false;
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot), binding(value), ports(), new AbortController().signal,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "account_verification_failed");
    assert.equal(result.terminal.status, "failed");
    if (result.terminal.status === "failed") {
      assert.equal(result.terminal.errorCode, "browser_effect_uncertain");
    }
    assert.equal(result.cleanupErrorCode, "browser_profile_cleanup_failed");
    const artifact = JSON.parse(readFileSync(join(evidenceRoot, "terminal-artifact.json"), "utf8"));
    assert.equal(artifact.resultCode, "account_verification_failed");
    assert.equal(artifact.terminal.errorCode, "browser_effect_uncertain");
    assert.equal(artifact.cleanupErrorCode, "browser_profile_cleanup_failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale terminal artifact fails closed without being overwritten", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-stale-terminal-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  try {
    const first = await runStage2RealJourney(
      invocation(evidenceRoot), undefined, ports(), new AbortController().signal,
    );
    assertFailureCode(first, "runtime_binding_failed");
    const before = readFileSync(join(evidenceRoot, "terminal-artifact.json"), "utf8");
    const second = await runStage2RealJourney(
      invocation(evidenceRoot), undefined, ports(), new AbortController().signal,
    );
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.terminalArtifactErrorCode, "terminal_artifact_persistence_failed");
    assert.equal(readFileSync(join(evidenceRoot, "terminal-artifact.json"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("arbitrary stage exceptions use only the truthful internal terminal code", async () => {
  for (const stage of ["bind", "account", "recovery", "application", "review", "evidence"] as const) {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-internal-${stage}-`));
    const evidenceRoot = resolve(root, "evidence");
    mkdirSync(evidenceRoot);
    const value = runtime([], evidenceRoot);
    value.recovery.pending = async () => null;
    if (stage === "account") value.account.verify = async () => { throw new Error("arbitrary"); };
    if (stage === "recovery") value.recovery.pending = async () => { throw new Error("arbitrary"); };
    if (stage === "application") value.application.run = async () => { throw new Error("arbitrary"); };
    if (stage === "review") value.review.capture = async () => { throw new Error("arbitrary"); };
    if (stage === "evidence") value.privacy.forbiddenTokens = async () => { throw new Error("arbitrary"); };
    const selectedBinding = stage === "bind"
      ? { bind: async () => { throw new Error("arbitrary"); } }
      : binding(value);
    try {
      const result = await runStage2RealJourney(
        invocation(evidenceRoot), selectedBinding, ports(), new AbortController().signal,
      );
      assert.equal(result.ok, false);
      if (result.ok || result.terminal.status !== "failed") continue;
      assert.equal(result.terminal.errorCode, "mcp_internal_error");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("wrongly bound account proof stops before recovery or application", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-binding-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const calls: string[] = [];
  const value = runtime(calls, evidenceRoot);
  value.account.verify = async () => ({
    ok: true,
    proof: { ...accountProof(), journeyId: "journey_wrongwrongwrong1" },
  });
  try {
    assertFailureCode(await runStage2RealJourney(
      invocation(evidenceRoot), binding(value), ports(), new AbortController().signal,
    ), "account_verification_failed");
    assert.equal(calls.includes("recovery.pending"), false);
    assert.equal(calls.includes("application.run"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recovery plan for another journey revision is rejected before recovery ports", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-recovery-binding-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const calls: string[] = [];
  const value = runtime(calls, evidenceRoot);
  const plan = recoveryPlan(calls);
  let recoveryPortCalled = false;
  value.recovery.pending = async () => ({
    input: {
      ...plan.input,
      sourceRevision: "revision_fedcba9876543210" as never,
    },
    dependencies: {
      ...plan.dependencies,
      state: {
        ...plan.dependencies.state,
        load: async (...args) => {
          recoveryPortCalled = true;
          return plan.dependencies.state.load(...args);
        },
      },
    },
    resume: plan.resume,
  });
  try {
    assertFailureCode(await runStage2RealJourney(
      invocation(evidenceRoot),
      binding(value),
      ports(),
      new AbortController().signal,
    ), "recovery_failed");
    assert.equal(recoveryPortCalled, false);
    assert.equal(calls.includes("application.run"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unverified pre-Review, denied Review, and evidence privacy failure never emit acceptance", async () => {
  for (const scenario of [
    "application",
    "application_accessor",
    "review",
    "privacy",
    "privacy_empty",
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-${scenario}-`));
    const evidenceRoot = resolve(root, "evidence");
    mkdirSync(evidenceRoot);
    const calls: string[] = [];
    const value = runtime(calls, evidenceRoot);
    value.recovery.pending = async () => null;
    if (scenario === "application") {
      value.application.run = async () => ({
        ok: true,
        value: { ...preReview(), checkpoint: "questionnaire_verified" },
      });
    }
    if (scenario === "application_accessor") {
      value.application.run = async () => Object.defineProperty({}, "ok", {
        enumerable: true,
        get: () => { throw new Error("malformed application result"); },
      }) as never;
    }
    if (scenario === "review") {
      value.review.capture = async () => {
        const captured = reviewCapture();
        return {
          ...captured,
          request: {
            ...captured.request,
            verification: [],
          },
        };
      };
    }
    if (scenario === "privacy") {
      value.privacy.forbiddenTokens = async () => [config.journeyId];
    }
    if (scenario === "privacy_empty") {
      value.privacy.forbiddenTokens = async () => [];
    }
    let writes = 0;
    try {
      const result = await runStage2RealJourney(
        invocation(evidenceRoot),
        binding(value),
        {
          now: () => "2026-08-05T12:00:00.000Z",
          writeAcceptance: async () => { writes += 1; },
        },
        new AbortController().signal,
      );
      assertFailureCode(
        result,
        scenario === "application" || scenario === "application_accessor"
          ? "pre_review_failed"
          : scenario === "review"
            ? "review_failed"
            : "evidence_failed",
      );
      assert.equal(writes, 0);
      assert.equal(calls.at(-1), "cleanup.close");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function invocation(evidenceRoot: string) {
  return Object.freeze({
    args: {
      configPath: resolve(evidenceRoot, "..", "owner-input.json"),
      evidenceRoot,
    },
    source: {
      repositoryRoot: resolve(evidenceRoot, "..", "repository"),
      sourceRevision,
    },
    config,
  });
}

function ports() {
  return {
    now: () => "2026-08-05T12:00:00.000Z",
    writeAcceptance: async () => undefined,
  };
}

function binding(
  value: Stage2RealJourneyRuntime & { readonly calls?: string[] },
): Stage2RealJourneyRuntimeBinding {
  return {
    bind: async () => {
      value.calls?.push("runtime.bind");
      return value;
    },
  } as Stage2RealJourneyRuntimeBinding;
}

function runtime(calls: string[], evidenceRoot: string): Stage2RealJourneyRuntime & { calls: string[] } {
  return {
    calls,
    account: {
      verify: async () => {
        calls.push("account.verify");
        return { ok: true, proof: accountProof() };
      },
    },
    recovery: {
      pending: async () => {
        calls.push("recovery.pending");
        return recoveryPlan(calls);
      },
    },
    application: {
      run: async () => {
        calls.push("application.run");
        return { ok: true, value: preReview() };
      },
    },
    review: {
      capture: async () => {
        calls.push("review.capture");
        return reviewCapture();
      },
    },
    privacy: {
      forbiddenTokens: async () => {
        calls.push("privacy.forbiddenTokens");
        return ["owner-secret-value-that-must-not-appear"];
      },
    },
    cleanup: {
      preserve: async () => false,
      release: async () => false,
      retentionExpiresAt: () => undefined,
      close: async () => {
        calls.push("cleanup.close");
        return true;
      },
    },
  };
}

function assertFailureCode(
  result: Awaited<ReturnType<typeof runStage2RealJourney>>,
  code: string,
): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, code);
}

function accountProof() {
  return Object.freeze({
    schemaVersion: 1 as const,
    proofRevision: "s2-account-session-proof-v1" as const,
    status: "unsealed" as const,
    sourceRevision,
    configSha256: config.configSha256,
    revisionId: config.revisionId,
    approvalId: config.approvalId,
    journeyId: config.journeyId,
    targetHandleId: config.targetHandleId,
    accountState: "application_ready" as const,
    independentlyObservedVerifiedState: true as const,
    verificationProof: "credential_sign_in" as const,
    provider: "workday-auth" as const,
    consumedCandidateCount: 0 as const,
    messageBodyRetained: false as const,
    submitActivated: false as const,
  });
}

function preReview() {
  return Object.freeze({
    checkpoint: "pre_review" as const,
    completedPages: 3,
    pageChecks: Object.freeze([
      check("profile", "profile_verified", 3),
      check("resume", "resume_verified", 1),
      check("questionnaire", "questionnaire_verified", 2),
    ]),
    submitActivated: false as const,
    privacyScan: "pass" as const,
  });
}

function check(page: "resume" | "profile" | "questionnaire", checkpoint: "resume_verified" | "profile_verified" | "questionnaire_verified", count: number) {
  return Object.freeze({
    page,
    checkpoint,
    independentlyVerified: true as const,
    requiredFields: count,
    verifiedFields: count,
    duplicateRows: 0,
  });
}

function reviewCapture() {
  const journeyId = exactJourneyId(config.journeyId);
  const operationId = generatedOperationId("operation_reviewstopproof01");
  const pageId = browserPageId("page-review");
  const requiredFieldId = fieldId("review-required");
  const page = Object.freeze({
    pageIdentity: Object.freeze({ kind: "workday" as const, page: "review" as const }),
    fields: Object.freeze([Object.freeze({
      fieldId: requiredFieldId,
      target: browserTargetToken("review-summary-only"),
      label: boundedText("Required review summary"),
      required: true,
      behavior: "text" as const,
      options: Object.freeze([]),
      state: "populated" as const,
    })]),
  }) satisfies SemanticPageSnapshot;
  const state = Object.freeze({
    schemaVersion: 3 as const,
    journeyId,
    status: "running" as const,
    pageId,
    revision: 7,
  }) satisfies DurableJourneyState;
  return {
    page: reviewPageFixture(),
    request: {
      state,
      operationId,
      pageId,
      page,
      verification: [{ kind: "verified" as const, fieldId: requiredFieldId }],
      completion: { kind: "complete" as const, decision: { kind: "stop_review" as const } },
    },
  };
}

function recoveryPlan(
  calls: string[],
  recoveredPage: "resume" | "questionnaire" | "review" = "resume",
): {
  input: RecoverBrowserInterruptionInput;
  dependencies: RecoveryDependencies;
  resume: (state: RecoveryCheckpoint) => {
    currentPage: "resume" | "profile" | "questionnaire" | "pre_review";
    pageChecks: readonly ReturnType<typeof check>[];
  };
} {
  const journeyId = config.journeyId as never;
  const recoveryRevision = config.revisionId as never;
  const operationId = "operation_0123456789abcdef" as never;
  const target = Object.freeze({
    schemaVersion: 1 as const,
    atsFamily: "workday" as const,
    hostId: "host_0123456789abcdef" as never,
    tenantId: "tenant_0123456789abcdef" as never,
    postingId: "posting_0123456789abcdef" as never,
  });
  const page = Object.freeze({
    id: `page-${recoveredPage}` as never,
    kind: recoveredPage,
  });
  const checkpoint: RecoveryCheckpoint = Object.freeze({
    schemaVersion: 1,
    journeyId,
    sourceRevision: recoveryRevision,
    revision: 3,
    target,
    page,
    verification: "verified",
    terminal: null,
  });
  const truth: RecoveryBrowserPageTruth = Object.freeze({
    page,
    target,
    verification: "verified",
    surface: "primary",
  });
  return {
    resume: (state) => ({
      currentPage: state.page.kind === "review" ? "pre_review" : state.page.kind as
        "resume" | "profile" | "questionnaire",
      pageChecks: [
        check("profile", "profile_verified", 3),
        check("resume", "resume_verified", 1),
        ...(recoveredPage === "resume" ? [] : [
          check("questionnaire", "questionnaire_verified", 2),
        ]),
      ],
    }),
    input: {
      schemaVersion: 1,
      journeyId,
      sourceRevision: recoveryRevision,
      expectedTarget: target,
      operationId,
      interruption: { code: "popup_observed", effect: "none" },
    },
    dependencies: {
      state: {
        load: async () => {
          calls.push("recovery.state.load");
          return { ok: true, value: checkpoint };
        },
        save: async (request) => {
          calls.push("recovery.state.save");
          return { ok: true, value: request.state };
        },
      },
      browser: {
        inspect: async () => {
          calls.push("recovery.browser.inspect");
          return { ok: true, value: { pages: [truth] } };
        },
        reload: async () => ({ ok: true, value: undefined }),
        reattach: async () => ({ ok: true, value: undefined }),
      },
      reconciliation: {
        record: async () => {
          calls.push("recovery.record");
          return { ok: true, value: undefined };
        },
      },
      terminal: {
        commit: async (request) => ({ ok: true, value: request.terminal }),
      },
    },
  };
}
