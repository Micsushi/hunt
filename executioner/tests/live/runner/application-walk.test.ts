import assert from "node:assert/strict";
import test from "node:test";

import {
  runStage2ApplicationWalk,
  type ApplicationWalkAcceptanceWriter,
  type Stage2ApplicationWalkTraceEvent,
} from "../../../src/live/runner/application-walk.ts";
import { dependenciesFor, truth } from "../../integration/s2-application-walk/fakes.ts";
import { walkFixture } from "../../integration/s2-application-walk/fixtures.ts";

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
          { checkpoint: "profile_verified" },
          { checkpoint: "resume_verified" },
          { checkpoint: "questionnaire_verified" },
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

function input() {
  return {
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    configSha256: "a".repeat(64),
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: walkFixture.journeyId,
    targetHandleId: "target_ref_abcdefghijklmnop",
    stopAfter: "pre_review" as const,
  };
}
