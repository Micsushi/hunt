import assert from "node:assert/strict";
import test from "node:test";

import {
  runStage2ApplicationWalk,
  type ApplicationWalkAcceptanceWriter,
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
      truth("resume"), truth("resume"),
      truth("profile"), truth("profile"),
      truth("questionnaire"), truth("questionnaire"),
      truth("pre_review"),
    ], calls),
    laneAcceptances: {
      snapshot() {
        calls.push("snapshot");
        return [
          { checkpoint: "resume_verified" },
          { checkpoint: "profile_verified" },
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
  const result = await runStage2ApplicationWalk(input(), {
    walk: dependenciesFor([truth("resume"), {
      ...truth("resume"),
      requiredFields: [{
        ...truth("resume").requiredFields[0]!,
        verification: "unverified",
      }],
    }, {
      ...truth("resume"),
      requiredFields: [{
        ...truth("resume").requiredFields[0]!,
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
});

function input() {
  return {
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: walkFixture.journeyId,
    targetHandleId: "target_ref_abcdefghijklmnop",
    stopAfter: "pre_review" as const,
  };
}
