import assert from "node:assert/strict";
import test from "node:test";

import { eventId, parseTerminalResult } from "../../src/contracts/index.ts";
import {
  contractFixtures,
  requiredFactualTerminalConsumerCases,
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
    {
      component: "F8",
      phase: "verification",
      step: "verify",
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
  const cases = [
    { component: "F5", phase: "page_understanding", step: "classify" },
    { component: "F6", phase: "answer_resolution", step: "resolve" },
    { component: "F8", phase: "verification", step: "verify" },
  ] as const;
  const lease = statefulScenarioProviderFactories.EventSink.create();
  try {
    for (const [index, coordinates] of cases.entries()) {
      const appended = await lease.provider.append({
        event: {
          ...contractFixtures.event,
          ...coordinates,
          eventId: eventId(`event-provider-failure-${index}`),
          kind: "step_failed",
        },
      }, new AbortController().signal);
      assert.equal(appended.ok, true);
      if (!appended.ok) continue;
      assert.notEqual(appended.value.progress.status, "blocked");
    }
  } finally {
    await lease.cleanup();
  }
});

test("shared F9 consumer cases exhaust every factual terminal without remutation or errors", () => {
  assert.deepEqual(
    requiredFactualTerminalConsumerCases.map(({ name }) => name),
    [
      "page-unknown",
      "page-ambiguous",
      "profile-answer-missing",
      "unsupported-field",
      "option-no-match",
      "option-ambiguous",
      "verification-rejected-mismatch",
      "verification-rejected-stale",
      "verification-ambiguous",
      "verification-unavailable",
    ],
  );

  for (const scenario of requiredFactualTerminalConsumerCases) {
    assert.deepEqual(scenario.factualOutcome.result, scenario.providerResult);
    assert.deepEqual(
      parseTerminalResult(scenario.expectedTerminal),
      scenario.expectedTerminal,
    );
    assert.equal(scenario.expectedTerminal.status, "blocked");
    assert.equal(scenario.blindRemutationAllowed, false);
    assert.equal(scenario.stableErrorCode, null);
    assert.equal(scenario.failureReportCode, null);
    assert.equal(scenario.terminalEvent.kind, "journey_terminal");
    assert.equal(scenario.terminalEvent.providerAttributed, true);
    assert.equal(scenario.terminalEvent.count, 1);
    assert.equal(scenario.terminalEvent.progressStatus, "blocked");
    assert.deepEqual(scenario.durableTransition, {
      status: "blocked",
      order: "before_terminal_publication",
    });
  }

  const rejected = requiredFactualTerminalConsumerCases.filter(
    ({ providerResult }) => providerResult.kind === "rejected",
  );
  assert.equal(rejected.length, 2);
  assert.equal(
    rejected.every(
      ({ terminalize }) =>
        terminalize === "after_bounded_verification_retry_exhausted",
    ),
    true,
  );
  assert.equal(
    requiredFactualTerminalConsumerCases
      .filter(({ providerResult }) =>
        providerResult.kind === "ambiguous" ||
        providerResult.kind === "unavailable"
      )
      .every(({ terminalize }) => terminalize === "immediately"),
    true,
  );
});
