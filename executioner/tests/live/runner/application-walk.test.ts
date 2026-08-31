import assert from "node:assert/strict";
import test from "node:test";

import {
  runObservedApplicationPageWalk,
  runStage2ApplicationWalk,
  type ApplicationWalkAcceptanceWriter,
  type Stage2ApplicationWalkTraceEvent,
} from "../../../src/live/runner/application-walk.ts";
import { dependenciesFor, truth } from "../../integration/s2-application-walk/fakes.ts";
import { walkFixture } from "../../integration/s2-application-walk/fixtures.ts";
import { liveApplicationExecutionPolicy } from
  "../../../src/contracts/application-execution-policy.ts";

test("writes the exact reconciled checkpoint only after browser cleanup passes", async () => {
  const calls: string[] = [];
  const written: unknown[] = [];
  const writer: ApplicationWalkAcceptanceWriter = {
    async write(acceptance) {
      calls.push("write");
      written.push(acceptance);
    },
  };
  const result = await runStage2ApplicationWalk(input(), {
    walk: dependenciesFor([
      truth("profile"), truth("profile"),
      truth("resume"), truth("resume"),
      truth("questionnaire"), truth("questionnaire"),
      truth("pre_review"),
    ], calls),
    laneAcceptances: {
      snapshot() {
        calls.push("snapshot");
        return [
          {
            schemaVersion: 1,
            checkpoint: "profile_verified",
            pageId: "page-profile",
            answerFallbackPolicy: "deterministic_site_valid_editable",
            pageType: "profile",
            verifiedFields: [],
            ownedDuplicateRows: 0,
            independentlyVerified: true,
            submitActivated: false,
            privacyScan: "pass",
          },
          {
            schemaVersion: 1,
            checkpoint: "resume_verified",
            pageId: "page-resume",
            fileCount: 1,
            verifiedFileCount: 1,
            independentlyVerified: true,
            submitActivated: false,
            privacyScan: "pass",
          },
          {
            schemaVersion: 1,
            checkpoint: "questionnaire_verified",
            answers: [],
            protectedPlaceholderCount: 0,
            independentlyVerified: true,
            submitActivated: false,
            privacyScan: "pass",
          },
        ] as never;
      },
    },
    cleanup: {
      async close() {
        calls.push("cleanup");
        return true;
      },
    },
    evidence: writer,
  }, new AbortController().signal);

  assert.equal(result.ok, true);
  assert.equal(calls.indexOf("cleanup") < calls.indexOf("write"), true);
  assert.equal(written.length, 1);
  if (!result.ok) return;
  assert.equal(result.acceptance.checkpoint, "pre_review");
  assert.equal(result.acceptance.completedPages, 3);
  assert.equal(result.acceptance.submitActivated, false);
  assert.equal(result.acceptance.privacyScan, "pass");
});

test("returns only the sanitized page failure after guaranteed cleanup", async () => {
  const calls: string[] = [];
  const trace: Stage2ApplicationWalkTraceEvent[] = [];
  const result = await runStage2ApplicationWalk(input(), {
    walk: dependenciesFor([truth("profile"), {
      ...truth("profile"),
      requiredFields: [{
        ...truth("profile").requiredFields[0]!,
        verification: "unverified",
      }],
    }, {
      ...truth("profile"),
      requiredFields: [{
        ...truth("profile").requiredFields[0]!,
        verification: "unverified",
      }],
    }], calls),
    laneAcceptances: { snapshot: () => [] },
    cleanup: {
      async close() {
        calls.push("cleanup");
        return true;
      },
    },
    evidence: {
      async write() {
        calls.push("write");
      },
    },
    trace: (event) => trace.push(event),
  }, new AbortController().signal);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "page_incomplete");
  assert.deepEqual(Object.keys(result.failure!).sort(), [
    "attempt", "classifier", "code", "owner", "page", "primitive",
    "retryable", "unknownLayer",
  ]);
  assert.equal(calls.includes("cleanup"), true);
  assert.equal(calls.includes("write"), false);
  assert.deepEqual(trace.map(({ kind }) => kind), [
    "application_walk_started",
    "application_walk_terminal",
  ]);
  const terminal = trace.at(-1);
  assert.equal(terminal?.kind, "application_walk_terminal");
  if (terminal?.kind !== "application_walk_terminal") return;
  assert.equal(terminal.status, "blocked");
  assert.equal(terminal.failure?.classifier, "required_field_gate");
  assert.equal(terminal.failure?.primitive, "required_field_verification");
  assert.equal(terminal.failure?.unknownLayer, "required_field");
  assert.equal(terminal.code, "page_incomplete");
  assert.equal(terminal.classifier, "required_field_gate");
  assert.equal(terminal.primitive, "required_field_verification");
  assert.equal(terminal.unknownLayer, "required_field");
  assert.equal(terminal.submitActivated, false);
});

test("retains an eligible profile session and skips ordinary cleanup", async () => {
  const calls: string[] = [];
  const result = await runStage2ApplicationWalk(input(), {
    walk: dependenciesFor([truth("profile"), {
      ...truth("profile"),
      requiredFields: [{ ...truth("profile").requiredFields[0]!, verification: "unverified" }],
    }], calls),
    laneAcceptances: { snapshot: () => [] },
    cleanup: {
      async preserve() {
        calls.push("preserve");
        return true;
      },
      async close() {
        calls.push("close");
        throw new Error("ordinary cleanup must be skipped");
      },
    },
    evidence: { async write() { calls.push("write"); } },
  }, new AbortController().signal);

  assert.equal(result.ok, false);
  assert.deepEqual(calls.slice(-1), ["preserve"]);
  assert.doesNotMatch(JSON.stringify(result), /submit|url|title|label|value|selector|error/iu);
});

test("rejects stale profile-session retention and falls back to cleanup", async () => {
  const calls: string[] = [];
  const result = await runStage2ApplicationWalk(input(), {
    walk: dependenciesFor([truth("profile"), {
      ...truth("profile"),
      requiredFields: [{ ...truth("profile").requiredFields[0]!, verification: "unverified" }],
    }], calls),
    laneAcceptances: { snapshot: () => [] },
    cleanup: {
      async preserve() {
        calls.push("preserve_rejected_stale_authority");
        return false;
      },
      async close() {
        calls.push("close");
        return true;
      },
    },
    evidence: { async write() { calls.push("write"); } },
  }, new AbortController().signal);

  assert.equal(result.ok, false);
  assert.deepEqual(calls.slice(-2), ["preserve_rejected_stale_authority", "close"]);
  assert.equal(calls.filter((call) => call === "close").length, 1);
  assert.doesNotMatch(JSON.stringify(result), /submit|url|title|label|value|selector|error/iu);
});

test("preservation diagnostics cannot suppress ordinary cleanup", async () => {
  const calls: string[] = [];
  const result = await runStage2ApplicationWalk(input(), {
    walk: dependenciesFor([truth("profile"), {
      ...truth("profile"),
      requiredFields: [{ ...truth("profile").requiredFields[0]!, verification: "unverified" }],
    }], calls),
    laneAcceptances: { snapshot: () => [] },
    cleanup: {
      async preserve() {
        calls.push("preserve_failed");
        throw new Error("stale authority");
      },
      async close() {
        calls.push("close");
        return true;
      },
    },
    evidence: { async write() { calls.push("write"); } },
  }, new AbortController().signal);

  assert.equal(result.ok, false);
  assert.deepEqual(calls.slice(-2), ["preserve_failed", "close"]);
});

test("cleanup failure is attached separately while profile failure stays primary", async () => {
  const calls: string[] = [];
  const result = await runStage2ApplicationWalk(input(), {
    walk: dependenciesFor([truth("profile")], calls, () => ({
      ok: false,
      error: {
        code: "page_incomplete",
        classifier: "profile_page",
        primitive: "profile_control",
        unknownLayer: "ui_behavior",
      },
    })),
    laneAcceptances: { snapshot: () => [] },
    cleanup: {
      async preserve() {
        calls.push("preserve_rejected");
        return false;
      },
      async close() {
        calls.push("close_failed");
        return false;
      },
    },
    evidence: { async write() { calls.push("write"); } },
  }, new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    code: "page_incomplete",
    failure: {
      attempt: 1,
      classifier: "profile_page",
      code: "page_incomplete",
      owner: "profile",
      page: "profile",
      primitive: "profile_control",
      retryable: false,
      unknownLayer: "ui_behavior",
    },
    cleanupErrorCode: "browser_profile_cleanup_failed",
  });
  assert.deepEqual(calls.slice(-2), ["preserve_rejected", "close_failed"]);
});

test("traces value-free page progress with question, answer, UI, and provenance summaries", async () => {
  const trace: Stage2ApplicationWalkTraceEvent[] = [];
  const calls: string[] = [];
  const result = await runStage2ApplicationWalk({ ...input(), stopAfter: "profile_verified" }, {
    walk: dependenciesFor([truth("profile"), truth("profile")], calls),
    laneAcceptances: {
      snapshot() {
        return [{
          schemaVersion: 1,
          checkpoint: "profile_verified",
          pageId: "page-profile",
          answerFallbackPolicy: "owner_facts_only",
          pageType: "profile",
          verifiedFields: [{
            fieldId: "identity.given_name",
            questionType: "identity",
            answerType: "text",
            uiBehavior: "text",
            uiVariant: "workday_text_v1",
            provenance: "owner_provided",
          }],
          ownedDuplicateRows: 0,
          independentlyVerified: true,
          submitActivated: false,
          privacyScan: "pass",
        }] as never;
      },
    },
    cleanup: { async close() { return true; } },
    evidence: { async write() {} },
    trace: (event) => trace.push(event),
  }, new AbortController().signal);

  assert.equal(result.ok, true);
  const progress = trace.find(({ kind }) => kind === "application_walk_progress");
  assert.equal(progress?.kind, "application_walk_progress");
  if (progress?.kind !== "application_walk_progress") return;
  assert.deepEqual(progress.questionTypes, ["identity"]);
  assert.deepEqual(progress.answerTypes, ["text"]);
  assert.deepEqual(progress.uiBehaviors, ["text"]);
  assert.deepEqual(progress.provenances, ["owner_provided"]);
  assert.equal(progress.requiredFields, 1);
  assert.equal(progress.verifiedFields, 1);
  assert.equal(progress.submitActivated, false);
});

test("retains monotonic active-fill timing separately from readiness and navigation", async () => {
  const trace: Stage2ApplicationWalkTraceEvent[] = [];
  let monotonic = 0;
  let wall = 0;
  const result = await runObservedApplicationPageWalk({
    walk: dependenciesFor([truth("profile"), truth("profile")], []),
    laneAcceptances: { snapshot: () => [] },
    trace: (event) => trace.push(event),
  }, {
    journeyId: walkFixture.journeyId,
    stopAfter: "profile_verified",
  }, new AbortController().signal, {
    timingClock: {
      monotonicNow: () => monotonic += 10,
      wallNow: () => new Date(Date.UTC(2026, 7, 10, 12, 0, 0, wall += 100)).toISOString(),
    },
  });

  assert.equal(result.ok, true);
  const progress = trace.find(({ kind }) => kind === "application_walk_progress");
  assert.equal(progress?.kind, "application_walk_progress");
  if (progress?.kind !== "application_walk_progress") return;
  assert.equal(progress.activeFillSloMs, 60_000);
  assert.equal(progress.activeFillWithinSlo, true);
  assert.equal(progress.activeFillDurationMs >= progress.reconciliationDurationMs, true);
  assert.equal(progress.committedReadbackDurationMs >= 0, true);
  assert.equal(progress.pageReadinessDurationMs >= 0, true);
  assert.equal(progress.navigationWaitDurationMs, 0);
  assert.match(progress.pageReadyAt, /Z$/u);
  const terminal = trace.at(-1);
  assert.equal(terminal?.kind, "application_walk_terminal");
  if (terminal?.kind === "application_walk_terminal") {
    assert.equal(terminal.applicationWalkDurationMs > 0, true);
  }
});

test("traced pre_review is a non-page transition without a timing completion", async () => {
  const trace: Stage2ApplicationWalkTraceEvent[] = [];
  const result = await runObservedApplicationPageWalk({
    walk: dependenciesFor([
      truth("profile"), truth("profile"), truth("resume"), truth("resume"),
      truth("questionnaire"), truth("questionnaire"), truth("pre_review"),
    ], []),
    laneAcceptances: { snapshot: () => [] },
    trace: (event) => trace.push(event),
  }, { journeyId: walkFixture.journeyId, stopAfter: "pre_review" },
  new AbortController().signal);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(trace.filter(({ kind }) => kind === "application_walk_progress").length, 3);
  const terminal = trace.at(-1);
  assert.equal(terminal?.kind, "application_walk_terminal");
  assert.equal(terminal?.kind === "application_walk_terminal" && terminal.checkpoint, "pre_review");
});

test("admitted answer fallback supports profile-less owner-fact and deterministic questionnaire walks", async () => {
  for (const executionMode of ["live", "synthetic_test_non_submittable"] as const) {
    const synthetic = executionMode === "synthetic_test_non_submittable";
    const result = await runStage2ApplicationWalk({
      ...input(),
      executionPolicy: liveApplicationExecutionPolicy(executionMode),
    }, {
      walk: dependenciesFor([
        truth("questionnaire"), truth("questionnaire"), truth("pre_review"),
      ], []),
      laneAcceptances: {
        snapshot: () => [{
          schemaVersion: 1,
          checkpoint: "questionnaire_verified",
          answers: [{
            pageId: "questionnaire-page-mode" as never,
            fieldId: "mode-answer" as never,
            questionId: "observed-question-0123456789abcdef01234567" as never,
            provenance: synthetic ? "visible_option" : "owner_provided",
            lane: synthetic ? "synthetic_test_default" : "live_owner_fact",
            protectedCategory: null,
            templateRevision: null,
            verification: "independent",
          }],
          protectedPlaceholderCount: 0,
          independentlyVerified: true,
          submitActivated: false,
          privacyScan: "pass",
        }],
      },
      cleanup: { async close() { return true; } },
      evidence: { async write() {} },
    }, new AbortController().signal);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(
      result.acceptance.answerFallbackPolicy,
      "deterministic_site_valid_editable",
    );
    if (result.ok) assert.equal(
      result.acceptance.liveProofEligibility,
      synthetic ? "ineligible_synthetic_answer" : "eligible",
    );
  }
});

function input() {
  return {
    executionPolicy: liveApplicationExecutionPolicy("live"),
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    configSha256: "a".repeat(64),
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: walkFixture.journeyId,
    targetHandleId: "target_ref_abcdefghijklmnop",
    stopAfter: "pre_review" as const,
  };
}
