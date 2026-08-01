import assert from "node:assert/strict";
import test from "node:test";

import {
  eventId,
  generatedEvidenceId,
  generatedOperationId,
  generatedReportId,
  guardRevision,
  serializedSchemas,
  providerError,
  type DurableJourneyState,
  type JourneyStateTransitionCommand,
} from "../../../../src/contracts/index.ts";
import {
  assertProviderConformance,
  contractFixtures,
  createAnswerResolverFake,
  createBrowserSessionFake,
  createCompletionNavigationFake,
  createEvidenceStoreFake,
  createEventSinkFake,
  createFailureReporterFake,
  createFieldDriverFake,
  createFieldVerifierFake,
  createJourneyControlFake,
  createJourneyIntakeFake,
  createJourneyStateStoreFake,
  createPageUnderstandingFake,
  createPrivacyGuardFake,
  createProgressReaderFake,
  createSafetyGuardFake,
} from "../../../../src/testing/contracts/index.ts";
import { createMcpFacade } from "../../../../src/control/mcp/index.ts";
import { createJourneyOrchestrator } from "../../../../src/control/orchestrator/terminal/index.ts";
import {
  dependencyViolations,
  sourceFiles,
} from "../../../architecture/dependency-rule.ts";

function sequence(prefix: "operation" | "evidence" | "report" | "event") {
  let next = 0;
  return () => `${prefix}_${(++next).toString(16).padStart(16, "0")}`;
}

function createControlFixture(
  options: {
    readonly blockVerification?: boolean;
    readonly failAnswers?: boolean;
    readonly navigateOnce?: boolean;
  } = {},
) {
  const ready = {
    schemaVersion: 3,
    journeyId: contractFixtures.journeyState.journeyId,
    status: "ready",
    pageId: null,
    revision: 0,
  } as const satisfies DurableJourneyState;
  let state: DurableJourneyState = ready;
  const rawOperation = sequence("operation");
  const rawEvidence = sequence("evidence");
  const rawReport = sequence("report");
  const rawEvent = sequence("event");

  const intake = createJourneyIntakeFake();
  const stateStore = createJourneyStateStoreFake({
    transition: async (input, signal) => {
      const request = input as JourneyStateTransitionCommand;
      if (signal.aborted) {
        return { ok: false, error: providerError("operation_cancelled") };
      }
      if (request.status === "cancelled") {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      state = {
        ...state,
        status: request.status,
        pageId: request.pageId,
        revision: state.revision + 1,
      };
      return { ok: true, value: { state, applied: true } };
    },
  });
  const browser = createBrowserSessionFake();
  const understanding = createPageUnderstandingFake();
  const answers = createAnswerResolverFake(
    options.failAnswers === true
      ? {
          resolve: {
            ok: false,
            error: providerError("profile_revision_mismatch"),
          },
        }
      : {},
  );
  const driver = createFieldDriverFake();
  const verifier = createFieldVerifierFake(
    options.blockVerification === true
      ? {
          verify: async (_request, signal) => {
            if (!signal.aborted) {
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
            }
            return {
              ok: false,
              error: providerError("operation_cancelled"),
            };
          },
        }
      : {},
  );
  const completion = createCompletionNavigationFake(
    options.navigateOnce === true
      ? {
          complete: async (_request, _signal, callIndex) => ({
            ok: true,
            value: {
              kind: "complete",
              decision:
                callIndex === 0
                  ? { kind: "next", expectedPage: "questionnaire" }
                  : { kind: "stop_review" },
            },
          }),
        }
      : {
          complete: {
            ok: true,
            value: { kind: "complete", decision: { kind: "stop_review" } },
          },
        },
  );
  const safety = createSafetyGuardFake();
  const events = createEventSinkFake();
  const failures = createFailureReporterFake();
  const privacy = createPrivacyGuardFake();
  const evidence = createEvidenceStoreFake();

  const control = createJourneyOrchestrator({
    intake: intake.port,
    state: stateStore.port,
    browser: browser.port,
    understanding: understanding.port,
    answers: answers.port,
    driver: driver.port,
    verifier: verifier.port,
    completion: completion.port,
    safety: safety.port,
    events: events.port,
    failures: failures.port,
    privacy: privacy.port,
    evidence: evidence.port,
    nextOperationId: () => ({
      ok: true,
      value: generatedOperationId(rawOperation()),
    }),
    nextEventId: () => eventId(rawEvent().replace("_", "-")),
    nextReportId: () => ({
      ok: true,
      value: generatedReportId(rawReport()),
    }),
    nextEvidenceId: () => generatedEvidenceId(rawEvidence()),
    guardRevision: guardRevision("policy-s1"),
    clock: () => "2026-07-31T12:00:00.000Z",
  });
  return {
    control,
    collaborators: {
      intake,
      stateStore,
      browser,
      understanding,
      answers,
      driver,
      verifier,
      completion,
      safety,
      events,
      failures,
      privacy,
      evidence,
    },
  };
}

async function readTerminal(
  control: ReturnType<typeof createControlFixture>["control"],
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await control.result(
      { journeyId: contractFixtures.journeyState.journeyId },
      new AbortController().signal,
    );
    if (result.ok) return result.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("F9 did not commit a terminal result");
}

test("JourneyControl satisfies the shared lifecycle contract", async () => {
  await assertProviderConformance(
    "JourneyControl",
    createControlFixture({ blockVerification: true }).control,
  );
});

test("McpJourneyApi satisfies the shared result contract without rewriting requestId", async () => {
  const rawOperation = sequence("operation");
  const facade = createMcpFacade({
    control: createJourneyControlFake().port,
    progress: createProgressReaderFake().port,
    privacy: createPrivacyGuardFake().port,
    nextOperationId: () => ({
      ok: true,
      value: generatedOperationId(rawOperation()),
    }),
    guardRevision: guardRevision("policy-s1"),
    startJourneyId: contractFixtures.journeyState.journeyId,
  });
  await assertProviderConformance("McpJourneyApi", facade);
});

test("the shared-fake matrix reaches every F9 collaborator", async () => {
  const successful = createControlFixture({ navigateOnce: true });
  const started = await successful.control.start(
    {
      operationId: generatedOperationId("operation_a11ce00000000000"),
      jobId: contractFixtures.job.jobId,
      resumeId: contractFixtures.resume.resumeId,
      profileId: contractFixtures.profile.profileId,
    },
    new AbortController().signal,
  );
  assert.equal(started.ok, true);
  assert.equal((await readTerminal(successful.control)).status, "review_reached");

  for (const name of [
    "intake",
    "stateStore",
    "browser",
    "understanding",
    "answers",
    "driver",
    "verifier",
    "completion",
    "safety",
    "events",
    "privacy",
    "evidence",
  ] as const) {
    assert.ok(
      successful.collaborators[name].calls.length > 0,
      `${name} was not reached`,
    );
  }

  const failed = createControlFixture({ failAnswers: true });
  await failed.control.start(
    {
      operationId: generatedOperationId("operation_fa11ed0000000000"),
      jobId: contractFixtures.job.jobId,
      resumeId: contractFixtures.resume.resumeId,
      profileId: contractFixtures.profile.profileId,
    },
    new AbortController().signal,
  );
  assert.equal((await readTerminal(failed.control)).status, "failed");
  assert.equal(failed.collaborators.failures.calls.length, 1);
});

test("F9 imports only contracts, Node, and its own implementation", () => {
  assert.deepEqual(
    dependencyViolations([
      ...sourceFiles("src/control/orchestrator"),
      ...sourceFiles("src/control/mcp"),
    ]),
    [],
  );
});

test("F9 production modules remain below the accepted split boundary", () => {
  const oversized = [
    ...sourceFiles("src/control/orchestrator"),
    ...sourceFiles("src/control/mcp"),
  ]
    .filter(({ source }) => source.split(/\r?\n/u).length >= 500)
    .map(({ path }) => path);
  assert.deepEqual(oversized, []);
});

test("the frozen MCP schema exposes only semantic journey operations", () => {
  const schema = JSON.stringify(serializedSchemas.mcpRequest);
  assert.match(schema, /start_journey/u);
  assert.match(schema, /cancel_journey/u);
  assert.match(schema, /journey_status/u);
  assert.match(schema, /journey_result/u);
  assert.doesNotMatch(
    schema,
    /submit_application|raw_browser|raw_selector|policy_override|ModelController/u,
  );
});
