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
  const result = await runStage2RealJourney(
    invocation(resolve("evidence")),
    undefined,
    ports(),
    new AbortController().signal,
  );
  assert.deepEqual(result, { ok: false, code: "runtime_binding_failed" });
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
      },
      new AbortController().signal,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      "runtime.bind",
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
    ]);
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

test("acceptance write failure retains recovery and exact evidence is retryable", async () => {
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
    assert.deepEqual(await runStage2RealJourney(
      invocation(evidenceRoot), binding(first), {
        now: () => "2026-08-05T12:00:00.000Z",
        writeAcceptance: async () => { throw new Error("injected acceptance write failure"); },
      }, new AbortController().signal,
    ), { ok: false, code: "evidence_failed" });
    assert.equal(existsSync(join(evidenceRoot, "real-evidence", "manifest.json")), true);
    assert.deepEqual(cleanupModes, [false]);

    const second = runtime([], evidenceRoot);
    second.recovery.pending = async () => null;
    second.cleanup.close = async (_signal, accepted = false) => {
      cleanupModes.push(accepted);
      return true;
    };
    assert.equal((await runStage2RealJourney(
      invocation(evidenceRoot), binding(second), {
        now: () => "2026-08-06T12:00:00.000Z",
        writeAcceptance: async () => undefined,
      }, new AbortController().signal,
    )).ok, true);
    assert.deepEqual(cleanupModes, [false, true]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const checkpoint of ["profile", "questionnaire", "review"] as const) {
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
    assert.deepEqual(await runStage2RealJourney(
      invocation(evidenceRoot),
      binding(value),
      ports(),
      new AbortController().signal,
    ), { ok: false, code: "recovery_failed" });
    assert.equal(calls.includes("application.run"), false);
    assert.equal(calls.at(-1), "cleanup.close");
    assert.equal(existsSync(join(evidenceRoot, "real-evidence")), false);
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
    assert.deepEqual(await runStage2RealJourney(
      invocation(evidenceRoot),
      binding(value),
      ports(),
      new AbortController().signal,
    ), { ok: false, code: "recovery_failed" });
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
      assert.deepEqual(result, {
        ok: false,
        code: scenario === "application" || scenario === "application_accessor"
          ? "pre_review_failed"
          : scenario === "review"
            ? "review_failed"
            : "evidence_failed",
      });
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
      close: async () => {
        calls.push("cleanup.close");
        return true;
      },
    },
  };
}

function preReview() {
  return Object.freeze({
    checkpoint: "pre_review" as const,
    completedPages: 3,
    pageChecks: Object.freeze([
      check("resume", "resume_verified", 1),
      check("profile", "profile_verified", 3),
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
  recoveredPage: "profile" | "questionnaire" | "review" = "profile",
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
        check("resume", "resume_verified", 1),
        check("profile", "profile_verified", 3),
        ...(recoveredPage === "profile" ? [] : [
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
