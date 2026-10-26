import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  browserPageId,
  browserTargetToken,
  boundedText,
  fieldId,
  generatedOperationId,
  journeyId as exactJourneyId,
} from "../../../src/contracts/index.ts";
import { FileJourneyStateStore } from "../../../src/journey/state-store.ts";
import {
  inspectWorkdayReview,
  stopAtVerifiedReview,
} from "../../../src/interaction/review/index.ts";
import { reviewPageFixture } from "./fixtures.ts";

test("verified Review transition is terminal and idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-review-stop-"));
  try {
    const store = new FileJourneyStateStore(root);
    const signal = new AbortController().signal;
    const journeyId = exactJourneyId("journey_reviewterminal01");
    const pageId = browserPageId("page-review");
    const initialized = await store.initialize(journeyId, signal);
    assert.equal(initialized.ok, true);
    if (!initialized.ok) return;
    const running = await store.transition({
      journeyId,
      operationId: generatedOperationId("operation_reviewrunning001"),
      expectedRevision: initialized.value.revision,
      status: "running",
      pageId,
    }, signal);
    assert.equal(running.ok, true);
    if (!running.ok) return;
    const requiredFieldId = fieldId("review-terminal-required");

    const stopped = stopAtVerifiedReview({
      state: running.value.state,
      operationId: generatedOperationId("operation_reviewterminal01"),
      pageId,
      page: {
        pageIdentity: { kind: "workday", page: "review" },
        fields: [{
          fieldId: requiredFieldId,
          target: browserTargetToken("review-terminal-target"),
          label: boundedText("Verified Review field"),
          required: true,
          behavior: "text",
          options: [],
          state: "populated",
        }],
      },
      verification: [{ kind: "verified", fieldId: requiredFieldId }],
      completion: { kind: "complete", decision: { kind: "stop_review" } },
      structure: await inspectWorkdayReview(reviewPageFixture()),
    });
    assert.equal(stopped.kind, "review_confirmed");
    if (stopped.kind !== "review_confirmed") return;

    const terminal = await store.transition(stopped.transition, signal);
    assert.equal(terminal.ok, true);
    if (!terminal.ok) return;
    assert.equal(terminal.value.applied, true);
    assert.equal(terminal.value.state.status, "review_reached");

    const replay = await store.transition(stopped.transition, signal);
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.value.applied, false);
    assert.deepEqual(replay.value.state, terminal.value.state);

    assert.deepEqual(
      await store.transition({
        ...stopped.transition,
        operationId: generatedOperationId("operation_reviewpoststop001"),
        expectedRevision: terminal.value.state.revision,
        status: "running",
      }, signal),
      {
        ok: false,
        error: { code: "journey_transition_illegal", retryable: false },
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
