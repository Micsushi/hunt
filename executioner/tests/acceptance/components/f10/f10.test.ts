import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  eventId,
  generatedOperationId,
  generatedReportId,
  journeyId,
  type EventEnvelope,
  type FailureReportRequest,
} from "../../../../src/contracts/index.ts";
import { FactualFailureReporter } from "../../../../src/observability/errors/reporter.ts";
import { JsonlEventStore } from "../../../../src/observability/events/store.ts";
import {
  assertProviderConformance,
  contractConformanceRegistry,
} from "../../../../src/testing/contracts/index.ts";
import {
  dependencyViolations,
  sourceFiles,
} from "../../../architecture/dependency-rule.ts";

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function eventPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hunt-f10-acceptance-"));
  temporaryDirectories.push(directory);
  return join(directory, "events.jsonl");
}

const producerCases = [
  ["F2", "fixture", "start"],
  ["F3", "browser", "observe"],
  ["F4", "journey_state", "persist"],
  ["F5", "page_understanding", "classify"],
  ["F6", "answer_resolution", "resolve"],
  ["F7", "field_interaction", "mutate"],
  ["F8", "verification", "verify"],
  ["F9", "orchestration", "start"],
  ["F11", "evidence", "admit"],
] as const satisfies readonly [
  EventEnvelope["component"],
  EventEnvelope["phase"],
  EventEnvelope["step"],
][];

function event(
  index: number,
  producer = producerCases[index % producerCases.length]!,
): EventEnvelope {
  const [component, phase, step] = producer;
  return {
    schemaVersion: 2,
    eventId: eventId(`event-producer-${index}`),
    journeyId: journeyId("journey_0123456789abcdef"),
    component,
    phase,
    step,
    kind: "step_started",
    at: "2026-07-31T00:00:00.000Z",
    source: {
      kind: "operation",
      id: generatedOperationId("operation_0123456789abcdef"),
    },
  };
}

test("all F10 providers pass the frozen conformance kit with no skipped port", async () => {
  const store = new JsonlEventStore(await eventPath());
  await assertProviderConformance("EventSink", store);
  await assertProviderConformance("ProgressReader", store);
  await assertProviderConformance("FailureReporter", new FactualFailureReporter());

  assert.deepEqual(
    contractConformanceRegistry
      .filter(({ name }) => ["EventSink", "ProgressReader", "FailureReporter"].includes(name))
      .map(({ name, operations, skip }) => ({ name, operations, skip })),
    [
      { name: "EventSink", operations: ["append"], skip: false },
      { name: "ProgressReader", operations: ["read"], skip: false },
      { name: "FailureReporter", operations: ["report"], skip: false },
    ],
  );
});

test("one exact value-free envelope table accepts every frozen producer", async () => {
  const store = new JsonlEventStore(await eventPath());
  for (const [index, producer] of producerCases.entries()) {
    assert.equal(
      (await store.append({ event: event(index, producer) }, new AbortController().signal)).ok,
      true,
    );
  }
});

test("factual terminal producers project blocked and never enter failure reporting", async () => {
  const cases = [
    ["F5", "page_understanding", "classify"],
    ["F6", "answer_resolution", "resolve"],
    ["F8", "verification", "verify"],
  ] as const satisfies readonly [
    EventEnvelope["component"],
    EventEnvelope["phase"],
    EventEnvelope["step"],
  ][];
  let notifications = 0;
  const reporter = new FactualFailureReporter(async () => {
    notifications += 1;
  });

  for (const [index, coordinates] of cases.entries()) {
    const store = new JsonlEventStore(await eventPath());
    const result = await store.append(
      {
        event: {
          ...event(index, coordinates),
          kind: "journey_terminal",
        },
      },
      new AbortController().signal,
    );
    assert.equal(result.ok && result.value.progress.status, "blocked");
    assert.equal(result.ok && "factualOutcome" in result.value.progress, false);
  }

  const factualAsFailure = {
    reportId: generatedReportId("report_0123456789abcdef"),
    context: {
      journeyId: journeyId("journey_0123456789abcdef"),
      component: "F6",
      phase: "answer_resolution",
      step: "resolve",
      code: "option_no_match",
      retryable: false,
      source: {
        kind: "operation",
        id: generatedOperationId("operation_0123456789abcdef"),
      },
    },
  } as unknown as FailureReportRequest;
  assert.deepEqual(
    await reporter.report(factualAsFailure, new AbortController().signal),
    {
      ok: false,
      error: { code: "failure_context_invalid", retryable: false },
    },
  );
  assert.equal(notifications, 0);
});

test("F10 source has no peer implementation imports, private payload surfaces, or Submit", () => {
  const files = sourceFiles("src/observability");
  assert.deepEqual(dependencyViolations(files), []);
  assert.deepEqual(
    files.filter(({ source }) =>
      /\b(?:rawText|selector|credential|email|resumePath|profileValue|submit)\b/iu.test(source),
    ),
    [],
  );
});
