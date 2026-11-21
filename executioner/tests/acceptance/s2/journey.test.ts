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
import { createC1TerminalPublisher } from "../../../src/observability/c1-outcomes.ts";

const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
const config = Object.freeze({
  configSha256: "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
  contractRevision: "s2-owner-inputs-v1",
  revisionId: "revision_0123456789abcdef",
  approvalId: "approval_0123456789abcdef",
  journeyId: "journey_0123456789abcdef",
  targetHandleId: "target_ref_0123456789abcdef",
});

test("a failed journey preserves its terminal across C1 reporting failure and a retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-c1-outcome-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const calls: Array<{ url: string; body: unknown }> = [];
  const publish = createC1TerminalPublisher(config.targetHandleId, {
    HUNT_C1_OUTCOME_BASE_URL: "http://127.0.0.1:8001",
    HUNT_C1_OUTCOME_JOB_ID: "42",
    HUNT_C1_OUTCOME_TARGET_HANDLE_ID: config.targetHandleId,
    HUNT_C1_OUTCOME_TOKEN: "service-token",
  }, (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 503 });
  }) as typeof fetch)!;
  try {
    const result = await runStage2RealJourney(invocation(evidenceRoot), undefined,
      { ...ports(), publishC1Terminal: publish }, new AbortController().signal);
    assertFailureCode(result, "runtime_binding_failed");
    assert.deepEqual(calls, [{ url: "http://127.0.0.1:8001/jobs/42/c3-outcome",
      body: { outcome: "failed", reason: "owner_config_invalid" } }]);
    const path = join(evidenceRoot, "terminal-artifact.json");
    const original = readFileSync(path, "utf8");
    assert.deepEqual(JSON.parse(original).terminal, result.terminal);

    const retry = await runStage2RealJourney(
      invocation(evidenceRoot),
      { bind: async () => { throw new TypeError("application owner source denied"); } },
      ports(),
      new AbortController().signal,
    );
    assertFailureCode(retry, "runtime_binding_failed");
    assert.equal(retry.terminal.status, "failed");
    if (retry.terminal.status === "failed") assert.equal(retry.terminal.errorCode, "owner_config_invalid");
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(retry.terminalArtifactErrorCode, "terminal_artifact_persistence_failed");
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one bound runtime recovers, proves pre-Review and Review, seals evidence, then cleans", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-journey-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const calls: string[] = [];
  const timingEvents: string[] = [];
  const outcomes: unknown[] = [];
  let accepted: unknown;
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot),
      binding({
        ...runtime(calls, evidenceRoot),
        timing: { record(event) { timingEvents.push(event); } },
      }),
      {
        now: () => "2026-08-05T12:00:00.000Z",
        publishC1Terminal: createC1TerminalPublisher(config.targetHandleId, {
          HUNT_C1_OUTCOME_BASE_URL: "http://127.0.0.1:8001",
          HUNT_C1_OUTCOME_JOB_ID: "42",
          HUNT_C1_OUTCOME_TARGET_HANDLE_ID: config.targetHandleId,
          HUNT_C1_OUTCOME_TOKEN: "service-token",
        }, (async (_url, init) => {
          assert.equal(existsSync(join(evidenceRoot, "terminal-artifact.json")), true);
          outcomes.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 200 });
        }) as typeof fetch),
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
    assert.deepEqual(outcomes, [{ outcome: "ready_for_review", reason: "review_reached" }]);
    assert.deepEqual(timingEvents, [
      "runtime_review_verification_completed",
      "runtime_review_acceptance_sealing_completed",
      "runtime_total_completed",
    ]);
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

test("an abort after independently verified Review cannot rewrite the committed terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-review-commit-abort-"));
  const evidenceRoot = resolve(root, "evidence");
  mkdirSync(evidenceRoot);
  const controller = new AbortController();
  const calls: string[] = [];
  const value = runtime(calls, evidenceRoot);
  const capture = value.review.capture;
  value.review.capture = async (signal) => {
    const result = await capture(signal);
    controller.abort();
    return result;
  };
  let acceptanceWrites = 0;
  try {
    const result = await runStage2RealJourney(
      invocation(evidenceRoot),
      binding(value),
      { ...ports(), writeAcceptance: async () => { acceptanceWrites += 1; } },
      controller.signal,
    );
    assert.equal(result.ok, true);
    assert.equal(result.terminal.status, "review_reached");
    assert.equal(acceptanceWrites, 1);
    assert.equal(calls.includes("privacy.forbiddenTokens"), true);
    assert.equal(calls.at(-1), "cleanup.close");
    assert.equal(JSON.parse(readFileSync(
      join(evidenceRoot, "terminal-artifact.json"), "utf8",
    )).resultCode, "review_reached");
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
