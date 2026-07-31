import assert from "node:assert/strict";
import test from "node:test";

import { eventId } from "../../src/contracts/index.ts";
import {
  contractFixtures,
  statefulScenarioProviderFactories,
} from "../../src/testing/contracts/index.ts";

test("provider-attributed factual terminal events project value-free blocked progress", async () => {
  const cases = [
    {
      component: "F5",
      phase: "page_understanding",
      step: "classify",
    },
    {
      component: "F6",
      phase: "answer_resolution",
      step: "resolve",
    },
  ] as const;

  const lease = statefulScenarioProviderFactories.EventSink.create();
  try {
    for (const [index, coordinates] of cases.entries()) {
      const appended = await lease.provider.append({
        event: {
          ...contractFixtures.event,
          ...coordinates,
          eventId: eventId(`event-factual-${index}`),
          kind: "journey_terminal",
        },
      }, new AbortController().signal);
      assert.equal(appended.ok, true);
      if (!appended.ok) continue;
      assert.deepEqual(appended.value.progress, {
        journeyId: contractFixtures.journeyState.journeyId,
        status: "blocked",
        completedSteps: contractFixtures.progress.completedSteps,
      });
      assert.equal("factualOutcome" in appended.value.progress, false);
      assert.equal("errorCode" in appended.value.progress, false);
    }
  } finally {
    await lease.cleanup();
  }
});

test("provider step failures do not masquerade as factual blocked progress", async () => {
  const lease = statefulScenarioProviderFactories.EventSink.create();
  try {
    const appended = await lease.provider.append({
      event: {
        ...contractFixtures.event,
        component: "F5",
        phase: "page_understanding",
        step: "classify",
        eventId: eventId("event-provider-failure"),
        kind: "step_failed",
      },
    }, new AbortController().signal);
    assert.equal(appended.ok, true);
    if (!appended.ok) return;
    assert.notEqual(appended.value.progress.status, "blocked");
  } finally {
    await lease.cleanup();
  }
});
