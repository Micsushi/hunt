import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  eventId,
  generatedOperationId,
  type EventEnvelope,
} from "../../../src/contracts/index.ts";
import { createJourneyIntake } from "../../../src/intake/intake.ts";
import { FileJourneyStateStore } from "../../../src/journey/state-store.ts";
import { JsonlEventStore } from "../../../src/observability/events/store.ts";
import { contractFixtures } from "../../../src/testing/contracts/index.ts";

const signal = new AbortController().signal;
const resumeBytes = new TextEncoder().encode("synthetic resume");
const journeyId = contractFixtures.journeyState.journeyId;

function event(
  suffix: string,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    schemaVersion: 2,
    eventId: eventId(`event-t5-${suffix}`),
    journeyId,
    component: "F9",
    phase: "orchestration",
    step: "start",
    kind: "step_started",
    at: "2026-07-31T20:00:00.000Z",
    source: {
      kind: "operation",
      id: generatedOperationId("operation_0000000000000001"),
    },
    ...overrides,
  };
}

test("real F4 state and intake reload the same terminal result without private inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hunt-t5-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = {
    job: contractFixtures.job,
    resume: contractFixtures.resume,
    profile: contractFixtures.profile,
  };
  const request = {
    jobId: source.job.jobId,
    resumeId: source.resume.resumeId,
    profileId: source.profile.profileId,
  } as const;
  const store = new FileJourneyStateStore(directory);
  const firstIntake = createJourneyIntake(
    source,
    resumeBytes,
    journeyId,
    store.initialize.bind(store),
  );

  const first = await firstIntake.bootstrap(request, signal);
  assert.equal(first.ok, true);
  const running = await store.transition({
    journeyId,
    operationId: generatedOperationId("operation_0000000000000002"),
    expectedRevision: 0,
    status: "running",
    pageId: contractFixtures.journeyState.pageId,
  }, signal);
  assert.equal(running.ok, true);
  if (!running.ok) assert.fail("real state store rejected running transition");

  const terminalCommand = {
    journeyId,
    operationId: generatedOperationId("operation_0000000000000003"),
    expectedRevision: running.value.state.revision,
    status: "blocked",
    pageId: running.value.state.pageId,
  } as const;
  const terminal = await store.transition(terminalCommand, signal);
  const replay = await store.transition(terminalCommand, signal);
  assert.equal(terminal.ok, true);
  assert.deepEqual(replay, terminal.ok
    ? { ok: true, value: { state: terminal.value.state, applied: false } }
    : terminal);

  const reopenedStore = new FileJourneyStateStore(directory);
  const reopenedIntake = createJourneyIntake(
    source,
    resumeBytes,
    journeyId,
    reopenedStore.initialize.bind(reopenedStore),
  );
  const reopened = await reopenedIntake.bootstrap(request, signal);
  assert.deepEqual(
    reopened.ok ? reopened.value.state : reopened,
    terminal.ok ? terminal.value.state : terminal,
  );

  const [filename] = await readdir(directory);
  assert.ok(filename);
  const durable = await readFile(join(directory, filename), "utf8");
  for (const privateValue of [
    source.job.title,
    source.job.company,
    source.job.applyUrl,
    source.resume.resumeId,
    source.resume.sha256,
    source.profile.profileId,
    source.profile.facts[0]?.value,
    "synthetic resume",
    "password",
    "selector",
    "Submit",
  ]) {
    assert.equal(
      privateValue === undefined || durable.includes(String(privateValue)),
      false,
      `persisted private input: ${String(privateValue)}`,
    );
  }
});

test("real F10 JSONL reload keeps progress monotonic and one terminal event final", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hunt-t5-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "events.jsonl");
  const store = new JsonlEventStore(path);
  const started = event("started");
  const completed = event("completed", {
    kind: "step_completed",
    at: "2026-07-31T20:00:01.000Z",
  });
  const terminal = event("terminal", {
    component: "F6",
    phase: "answer_resolution",
    step: "resolve",
    kind: "journey_terminal",
    at: "2026-07-31T20:00:02.000Z",
  });
  const late = event("late", {
    kind: "step_completed",
    at: "2026-07-31T20:00:03.000Z",
  });

  assert.equal((await store.append({ event: started }, signal)).ok, true);
  const beforeTerminal = await store.append({ event: completed }, signal);
  assert.deepEqual(beforeTerminal.ok ? beforeTerminal.value.progress : beforeTerminal, {
    journeyId,
    status: "running",
    completedSteps: 1,
  });
  const terminalResult = await store.append({ event: terminal }, signal);
  assert.deepEqual(terminalResult.ok ? terminalResult.value.progress : terminalResult, {
    journeyId,
    status: "blocked",
    completedSteps: 1,
  });
  assert.deepEqual(await store.append({ event: terminal }, signal),
    terminalResult.ok
      ? { ok: true, value: { appended: false, progress: terminalResult.value.progress } }
      : terminalResult);
  const lateResult = await store.append({ event: late }, signal);
  assert.deepEqual(lateResult.ok ? lateResult.value.progress : lateResult, {
    journeyId,
    status: "blocked",
    completedSteps: 1,
  });

  assert.deepEqual(await new JsonlEventStore(path).read({ journeyId }, signal), {
    ok: true,
    value: { journeyId, status: "blocked", completedSteps: 1 },
  });
  const lines = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as EventEnvelope);
  assert.equal(lines.filter(({ kind }) => kind === "journey_terminal").length, 1);
  const durable = JSON.stringify(lines);
  assert.doesNotMatch(durable, /password|private|selector|Submit/iu);
});
