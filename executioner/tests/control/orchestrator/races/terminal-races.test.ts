import assert from "node:assert/strict";
import test from "node:test";

import {
  eventId,
  generatedEvidenceId,
  generatedOperationId,
  generatedReportId,
  guardRevision,
  providerError,
  type AnswerResolutionResult,
  type DurableJourneyState,
  type EventEnvelope,
  type FailureReportRequest,
  type JourneyStateStore,
  type PageUnderstandingResult,
  type VerificationResult,
} from "../../../../src/contracts/index.ts";
import {
  contractFixtures,
  createAnswerResolverFake,
  createBrowserSessionFake,
  createCompletionNavigationFake,
  createFieldDriverFake,
  createFieldVerifierFake,
  createEvidenceStoreFake,
  createPageUnderstandingFake,
  createPrivacyGuardFake,
  createSafetyGuardFake,
  requiredFactualTerminalConsumerCases,
  type FactualTerminalConsumerCase,
} from "../../../../src/testing/contracts/index.ts";
import { createJourneyOrchestrator } from "../../../../src/control/orchestrator/terminal/index.ts";

const startCommand = {
  operationId: generatedOperationId("operation_start00000000001"),
  jobId: contractFixtures.job.jobId,
  resumeId: contractFixtures.resume.resumeId,
  profileId: contractFixtures.profile.profileId,
} as const;

function operationSequence() {
  let next = 0;
  return () => ({
    ok: true as const,
    value: generatedOperationId(
      `operation_${(++next).toString(16).padStart(16, "0")}`,
    ),
  });
}

function eventSequence() {
  let next = 0;
  return () => {
    next += 1;
    return eventId(`event-${next.toString(16).padStart(16, "0")}`);
  };
}

function reportSequence() {
  let next = 0;
  return () => ({
    ok: true as const,
    value: generatedReportId(
      `report_${(++next).toString(16).padStart(16, "0")}`,
    ),
  });
}

function stateStore(
  initial: DurableJourneyState,
  terminalTransitionFailure = false,
  onTransition: (status: DurableJourneyState["status"]) => void = () => {},
) {
  let state = initial;
  const transitions: DurableJourneyState["status"][] = [];
  const port: JourneyStateStore = {
    async load(request, signal) {
      if (signal.aborted) return { ok: false, error: providerError("operation_cancelled") };
      return {
        ok: true,
        value: { state: request.journeyId === state.journeyId ? state : null },
      };
    },
    async transition(request, signal) {
      if (signal.aborted) return { ok: false, error: providerError("operation_cancelled") };
      transitions.push(request.status);
      onTransition(request.status);
      if (
        terminalTransitionFailure &&
        ["review_reached", "blocked", "cancelled", "failed"].includes(
          request.status,
        )
      ) {
        return {
          ok: false,
          error: providerError("journey_state_unavailable"),
        };
      }
      if (request.expectedRevision !== state.revision) {
        return { ok: false, error: providerError("journey_revision_conflict") };
      }
      state = {
        ...state,
        status: request.status,
        pageId: request.pageId,
        revision: state.revision + 1,
      };
      return { ok: true, value: { state, applied: true } };
    },
  };
  return { port, transitions };
}

interface SetupOptions {
  readonly answerFailure?: "profile_revision_mismatch";
  readonly blockVerification?: boolean;
  readonly factualCase?: FactualTerminalConsumerCase;
  readonly terminalTransitionFailure?: boolean;
  readonly terminalEventFailure?: boolean;
  readonly closeFailure?: boolean;
}

function setup(options: SetupOptions = {}) {
  const events: EventEnvelope[] = [];
  const failures: FailureReportRequest[] = [];
  const closed: string[] = [];
  const order: string[] = [];
  const browser = createBrowserSessionFake({
    ...(options.factualCase?.contextPageId === null ||
    options.factualCase?.contextPageId === undefined
      ? {}
      : {
          start: {
            ok: true as const,
            value: {
              sessionId: contractFixtures.browserObservation.sessionId,
              pageId: options.factualCase.contextPageId,
            },
          },
          observe: {
            ok: true as const,
            value: {
              ...contractFixtures.browserObservation,
              pageId: options.factualCase.contextPageId,
            },
          },
        }),
    close: async (request) => {
      closed.push((request as { sessionId: string }).sessionId);
      return options.closeFailure === true
        ? {
            ok: false as const,
            error: providerError("browser_session_invalidated"),
          }
        : { ok: true as const, value: undefined };
    },
  });
  const verifier = createFieldVerifierFake(
    options.blockVerification === true
      ? {
          verify: async (_request, signal) => {
            if (!signal.aborted) {
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
              );
            }
            return { ok: false, error: providerError("operation_cancelled") };
          },
        }
      : options.factualCase?.provider === "FieldVerifier"
        ? {
            verify: {
              ok: true,
              value: options.factualCase.providerResult as VerificationResult,
            },
          }
        : {},
  );
  const ready = {
    schemaVersion: 3,
    journeyId: contractFixtures.journeyState.journeyId,
    status: "ready",
    pageId: null,
    revision: 0,
  } as const satisfies DurableJourneyState;
  const stored = stateStore(
    ready,
    options.terminalTransitionFailure,
    (status) => order.push(`state:${status}`),
  );
  const driver = createFieldDriverFake();
  const control = createJourneyOrchestrator({
    intake: {
      async bootstrap(_request, signal) {
        if (signal.aborted) return { ok: false, error: providerError("operation_cancelled") };
        return {
          ok: true,
          value: {
            journeyId: ready.journeyId,
            inputs: contractFixtures.journeyInputs,
            state: ready,
          },
        };
      },
    },
    state: stored.port,
    browser: browser.port,
    understanding: createPageUnderstandingFake(
      options.factualCase?.provider === "PageUnderstanding"
        ? {
            understand: {
              ok: true,
              value: options.factualCase
                .providerResult as PageUnderstandingResult,
            },
          }
        : {},
    ).port,
    answers: createAnswerResolverFake(
      options.factualCase?.provider === "AnswerResolver"
        ? {
            resolve: {
              ok: true,
              value: options.factualCase
                .providerResult as AnswerResolutionResult,
            },
          }
        : options.answerFailure === undefined
          ? {}
        : {
            resolve: {
              ok: false,
              error: providerError(options.answerFailure),
            },
          },
    ).port,
    driver: driver.port,
    verifier: verifier.port,
    completion: createCompletionNavigationFake({
      complete: {
        ok: true,
        value: { kind: "complete", decision: { kind: "stop_review" } },
      },
    }).port,
    safety: createSafetyGuardFake().port,
    events: {
      async append(request, signal) {
        if (signal.aborted) return { ok: false, error: providerError("operation_cancelled") };
        order.push(`event:${request.event.kind}`);
        if (
          options.terminalEventFailure === true &&
          request.event.kind === "journey_terminal"
        ) {
          return {
            ok: false,
            error: providerError("event_store_unavailable"),
          };
        }
        events.push(request.event);
        return {
          ok: true,
          value: {
            appended: true,
            progress: {
              journeyId: request.event.journeyId,
              status:
                request.event.kind === "journey_terminal"
                  ? request.event.component === "F5" ||
                    request.event.component === "F6" ||
                    request.event.component === "F8"
                    ? "blocked"
                    : request.event.step === "cancel"
                    ? "cancelled"
                    : request.event.step === "stop_review"
                      ? "review_reached"
                      : "failed"
                  : "running",
              completedSteps: events.length,
            },
          },
        };
      },
    },
    failures: {
      async report(request, signal) {
        if (signal.aborted) return { ok: false, error: providerError("operation_cancelled") };
        failures.push(request);
        return {
          ok: true,
          value: {
            report: request,
            notification: { reportId: request.reportId, delivered: true },
          },
        };
      },
    },
    privacy: createPrivacyGuardFake().port,
    evidence: createEvidenceStoreFake().port,
    nextOperationId: operationSequence(),
    nextEventId: eventSequence(),
    nextReportId: reportSequence(),
    nextEvidenceId: (() => {
      let next = 0;
      return () =>
        generatedEvidenceId(
          `evidence_${(++next).toString(16).padStart(16, "0")}`,
        );
    })(),
    guardRevision: guardRevision("policy-s1"),
    clock: () => "2026-07-31T12:00:00.000Z",
  }, { mutationRetryLimit: 1 });
  return {
    control,
    events,
    failures,
    closed,
    browserCalls: browser.calls,
    driverCalls: driver.calls,
    verifierCalls: verifier.calls,
    transitions: stored.transitions,
    order,
  };
}

async function terminal(control: ReturnType<typeof setup>["control"]) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await control.result(
      { journeyId: contractFixtures.journeyState.journeyId },
      new AbortController().signal,
    );
    if (result.ok) return result.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("terminal result was not committed");
}

test("accepted cancellation serializes one cancelled terminal and closes the session", async () => {
  const fixture = setup({ blockVerification: true });
  const started = await fixture.control.start(startCommand, new AbortController().signal);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  while (fixture.verifierCalls.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const cancelled = await fixture.control.cancel(
    {
      operationId: generatedOperationId("operation_cafebabecafebabe"),
      journeyId: started.value.journeyId,
    },
    new AbortController().signal,
  );
  assert.equal(cancelled.ok, true);

  assert.equal((await terminal(fixture.control)).status, "cancelled");
  assert.equal(fixture.events.filter(({ kind }) => kind === "journey_terminal").length, 1);
  assert.equal(fixture.closed.length, 2);
  assert.equal(
    fixture.browserCalls.filter(({ operation }) => operation === "start").length,
    2,
  );
  assert.equal(
    fixture.browserCalls.filter(({ operation }) => operation === "observe").length,
    2,
  );
  assert.equal(fixture.driverCalls.length, 1);
  assert.equal(
    fixture.browserCalls.filter(
      ({ operation }) => operation === "mutate" || operation === "navigate",
    ).length,
    0,
  );
});

test("a committed Review terminal wins over a later cancel", async () => {
  const fixture = setup();
  const started = await fixture.control.start(startCommand, new AbortController().signal);
  assert.equal(started.ok, true);
  const completed = await terminal(fixture.control);
  assert.equal(completed.status, "review_reached");

  const cancel = await fixture.control.cancel(
    {
      operationId: generatedOperationId("operation_cafebabecafebabe"),
      journeyId: contractFixtures.journeyState.journeyId,
    },
    new AbortController().signal,
  );
  assert.deepEqual(cancel, {
    ok: false,
    error: providerError("journey_already_terminal"),
  });
  assert.deepEqual(await terminal(fixture.control), completed);
});

test("provider failure ownership reaches terminal reporting unchanged", async () => {
  const fixture = setup({ answerFailure: "profile_revision_mismatch" });
  await fixture.control.start(startCommand, new AbortController().signal);

  const result = await terminal(fixture.control);
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errorCode, "profile_revision_mismatch");
  assert.equal(fixture.failures[0]?.context.component, "F4");
  assert.equal(fixture.failures[0]?.context.code, "profile_revision_mismatch");
});

test("three injected-clock runs produce identical semantic events", async () => {
  const runs = [];
  for (let run = 0; run < 3; run += 1) {
    const fixture = setup();
    await fixture.control.start(startCommand, new AbortController().signal);
    await terminal(fixture.control);
    runs.push(fixture.events);
  }
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(runs[2], runs[0]);
});

test("all ten factual provider results commit one exact blocked terminal", async () => {
  for (const consumerCase of requiredFactualTerminalConsumerCases) {
    const fixture = setup({ factualCase: consumerCase });
    const started = await fixture.control.start(
      startCommand,
      new AbortController().signal,
    );
    assert.equal(started.ok, true, consumerCase.name);
    const result = await terminal(fixture.control);

    assert.deepEqual(result, consumerCase.expectedTerminal, consumerCase.name);
    assert.deepEqual(
      fixture.transitions.filter((status) => status === "blocked"),
      ["blocked"],
      consumerCase.name,
    );
    const terminalEvents = fixture.events.filter(
      ({ kind }) => kind === "journey_terminal",
    );
    assert.equal(terminalEvents.length, 1, consumerCase.name);
    assert.equal(
      terminalEvents[0]?.component,
      consumerCase.terminalEvent.component,
      consumerCase.name,
    );
    assert.equal(
      terminalEvents[0]?.phase,
      consumerCase.terminalEvent.phase,
      consumerCase.name,
    );
    assert.equal(
      terminalEvents[0]?.step,
      consumerCase.terminalEvent.step,
      consumerCase.name,
    );
    assert.equal(fixture.failures.length, 0, consumerCase.name);
    assert.equal(fixture.closed.length, 1, consumerCase.name);
    assert.ok(
      fixture.order.lastIndexOf("state:blocked") <
        fixture.order.lastIndexOf("event:journey_terminal"),
      consumerCase.name,
    );
    const expectedVerifications =
      consumerCase.provider !== "FieldVerifier"
        ? 0
        : consumerCase.terminalize ===
            "after_bounded_verification_retry_exhausted"
          ? 2
          : 1;
    assert.equal(
      fixture.verifierCalls.length,
      expectedVerifications,
      consumerCase.name,
    );
  }
});

test("a failed durable terminal transition publishes neither event nor result", async () => {
  const fixture = setup({ terminalTransitionFailure: true });
  await fixture.control.start(startCommand, new AbortController().signal);
  await settle();

  const result = await fixture.control.result(
    { journeyId: contractFixtures.journeyState.journeyId },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "journey_busy");
  assert.equal(result.error.cause?.code, "journey_state_unavailable");
  assert.equal(
    fixture.events.filter(({ kind }) => kind === "journey_terminal").length,
    0,
  );
});

test("a failed terminal event append keeps the committed result unpublished", async () => {
  const fixture = setup({ terminalEventFailure: true });
  await fixture.control.start(startCommand, new AbortController().signal);
  await settle();

  const result = await fixture.control.result(
    { journeyId: contractFixtures.journeyState.journeyId },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "journey_busy");
  assert.equal(result.error.cause?.code, "event_store_unavailable");
  assert.equal(
    fixture.events.filter(({ kind }) => kind === "journey_terminal").length,
    0,
  );
});

test("failed journey preserves an exact browser close failure", async () => {
  const fixture = setup({
    answerFailure: "profile_revision_mismatch",
    closeFailure: true,
  });
  await fixture.control.start(startCommand, new AbortController().signal);

  const result = await terminal(fixture.control);
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errorCode, "browser_session_invalidated");
  assert.equal(fixture.failures.length, 1);
  assert.equal(
    fixture.failures[0]?.context.code,
    "browser_session_invalidated",
  );
});

test("cancelled journey preserves an exact browser close failure", async () => {
  const fixture = setup({ blockVerification: true, closeFailure: true });
  const started = await fixture.control.start(
    startCommand,
    new AbortController().signal,
  );
  assert.equal(started.ok, true);
  if (!started.ok) return;
  while (fixture.verifierCalls.length === 0) await settle();
  await fixture.control.cancel(
    {
      operationId: generatedOperationId("operation_c105efai1ed00000"),
      journeyId: started.value.journeyId,
    },
    new AbortController().signal,
  );

  const result = await terminal(fixture.control);
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.errorCode, "browser_session_invalidated");
});

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
