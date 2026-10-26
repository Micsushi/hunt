import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  eventId,
  generatedOperationId,
  journeyId,
  type EventAppendRequest,
  type EventEnvelope,
} from "../../../src/contracts/index.ts";
import { JsonlEventStore } from "../../../src/observability/events/store.ts";

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function eventPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hunt-f10-events-"));
  temporaryDirectories.push(directory);
  return join(directory, "events.jsonl");
}

function event(
  suffix = "0000000000000001",
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    schemaVersion: 2,
    eventId: eventId(`event-${suffix}`),
    journeyId: journeyId("journey_0123456789abcdef"),
    component: "F9",
    phase: "orchestration",
    step: "start",
    kind: "step_started",
    at: "2026-07-31T00:00:00.000Z",
    source: {
      kind: "operation",
      id: generatedOperationId("operation_0123456789abcdef"),
    },
    ...overrides,
  };
}

test("appends schema-v2 events durably and reloads deterministic progress", async () => {
  const path = await eventPath();
  const store = new JsonlEventStore(path);
  const expected = {
    journeyId: journeyId("journey_0123456789abcdef"),
    status: "running",
    completedSteps: 0,
  } as const;

  assert.deepEqual(
    await store.append({ event: event() }, new AbortController().signal),
    { ok: true, value: { appended: true, progress: expected } },
  );
  assert.deepEqual(
    await new JsonlEventStore(path).read(
      { journeyId: expected.journeyId },
      new AbortController().signal,
    ),
    { ok: true, value: expected },
  );
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 1);
});

test("deduplicates equal events and rejects conflicting IDs across concurrent stores", async () => {
  const path = await eventPath();
  const stores = [new JsonlEventStore(path), new JsonlEventStore(path)];
  const completed = event("0000000000000002", { kind: "step_completed" });
  const concurrent = await Promise.all(
    stores.map((store) =>
      store.append({ event: completed }, new AbortController().signal),
    ),
  );

  assert.deepEqual(
    concurrent.map((result) => result.ok && result.value.appended).sort(),
    [false, true],
  );
  assert.deepEqual(
    await stores[0]!.append(
      { event: { ...completed, kind: "step_failed" } },
      new AbortController().signal,
    ),
    { ok: false, error: { code: "event_invalid", retryable: false } },
  );
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 1);
});

test("projects exact F9 terminal vocabulary and keeps every terminal final", async () => {
  const cases = [
    {
      coordinates: {
        component: "F9",
        phase: "orchestration",
        step: "stop_review",
      },
      status: "review_reached",
    },
    {
      coordinates: { component: "F9", phase: "orchestration", step: "cancel" },
      status: "cancelled",
    },
    {
      coordinates: { component: "F3", phase: "terminal", step: "observe" },
      status: "failed",
    },
    {
      coordinates: {
        component: "F5",
        phase: "page_understanding",
        step: "classify",
      },
      status: "blocked",
    },
    {
      coordinates: {
        component: "F6",
        phase: "answer_resolution",
        step: "resolve",
      },
      status: "blocked",
    },
    {
      coordinates: { component: "F8", phase: "verification", step: "verify" },
      status: "blocked",
    },
  ] as const;

  for (const [index, item] of cases.entries()) {
    const id = journeyId(`journey_${index.toString().padStart(16, "0")}`);
    const store = new JsonlEventStore(await eventPath());
    assert.equal(
      (
        await store.append(
          {
            event: event(`terminal-${index}`, {
              ...item.coordinates,
              journeyId: id,
              kind: "journey_terminal",
            }),
          },
          new AbortController().signal,
        )
      ).ok,
      true,
    );
    const afterTerminal = await store.append(
      {
        event: event(`late-${index}`, {
          journeyId: id,
          kind: "step_completed",
        }),
      },
      new AbortController().signal,
    );
    assert.deepEqual(
      afterTerminal.ok
        ? {
            status: afterTerminal.value.progress.status,
            completedSteps: afterTerminal.value.progress.completedSteps,
          }
        : afterTerminal,
      { status: item.status, completedSteps: 0 },
    );
  }
});

test("does not classify provider failures as factual blocked outcomes", async () => {
  for (const [index, coordinates] of [
    { component: "F5", phase: "page_understanding", step: "classify" },
    { component: "F6", phase: "answer_resolution", step: "resolve" },
    { component: "F8", phase: "verification", step: "verify" },
  ].entries()) {
    const store = new JsonlEventStore(await eventPath());
    const result = await store.append(
      {
        event: event(`failure-${index}`, {
          ...coordinates,
          kind: "step_failed",
        } as Partial<EventEnvelope>),
      },
      new AbortController().signal,
    );
    assert.equal(result.ok && result.value.progress.status, "failed");
  }
});

test("rejects stale terminal shapes, v1, and PII-shaped identifiers before persistence", async () => {
  const path = await eventPath();
  const store = new JsonlEventStore(path);
  const invalid = [
    { event: { ...event(), schemaVersion: 1 } },
    {
      event: event("bad-terminal", {
        kind: "journey_terminal",
        component: "F5",
        phase: "page_understanding",
        step: "start",
      }),
    },
    { event: { ...event(), eventId: "applicant@example.invalid" } },
    { event: { ...event(), journeyId: "https://private.invalid/job/1" } },
    {
      event: {
        ...event(),
        source: { kind: "operation", id: "C:\\private\\resume.pdf" },
      },
    },
    { event: { ...event(), at: "applicant@example.invalid" } },
    { event: { ...event(), at: "2026-07-31T00:00:00Z" } },
    { event: { ...event(), at: "2026-02-30T00:00:00.000Z" } },
    { event: { ...event(), rawText: "private applicant text" } },
  ] as unknown as EventAppendRequest[];

  for (const request of invalid) {
    assert.deepEqual(
      await store.append(request, new AbortController().signal),
      { ok: false, error: { code: "event_invalid", retryable: false } },
    );
  }
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("append and read reject accessors and proxies without executing traps or effects", async () => {
  const path = await eventPath();
  const store = new JsonlEventStore(path);
  let traps = 0;
  const accessorAppend = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessorAppend, "event", {
    enumerable: true,
    get() {
      traps += 1;
      return event();
    },
  });
  const proxyAppend = new Proxy(
    { event: event() },
    {
      get(target, key, receiver) {
        traps += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        traps += 1;
        return Reflect.ownKeys(target);
      },
    },
  );
  const accessorRead = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessorRead, "journeyId", {
    enumerable: true,
    get() {
      traps += 1;
      return journeyId("journey_0123456789abcdef");
    },
  });
  const proxyRead = new Proxy(
    { journeyId: journeyId("journey_0123456789abcdef") },
    {
      get(target, key, receiver) {
        traps += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        traps += 1;
        return Reflect.ownKeys(target);
      },
    },
  );

  for (const hostile of [accessorAppend, proxyAppend]) {
    assert.deepEqual(
      await store.append(
        hostile as unknown as EventAppendRequest,
        new AbortController().signal,
      ),
      { ok: false, error: { code: "event_invalid", retryable: false } },
    );
  }
  for (const hostile of [accessorRead, proxyRead]) {
    assert.deepEqual(
      await store.read(
        hostile as unknown as Parameters<JsonlEventStore["read"]>[0],
        new AbortController().signal,
      ),
      { ok: false, error: { code: "event_invalid", retryable: false } },
    );
  }
  assert.equal(traps, 0);
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("cancellation and malformed storage return exact stable errors", async () => {
  const path = await eventPath();
  const store = new JsonlEventStore(path);
  assert.deepEqual(
    await store.append({ event: event() }, AbortSignal.abort()),
    { ok: false, error: { code: "operation_cancelled", retryable: false } },
  );
  assert.deepEqual(
    await store.read(
      { journeyId: journeyId("journey_1111111111111111") },
      new AbortController().signal,
    ),
    { ok: false, error: { code: "progress_not_found", retryable: false } },
  );
  await writeFile(path, "not-json\n", "utf8");
  assert.deepEqual(
    await store.read(
      { journeyId: journeyId("journey_0123456789abcdef") },
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "event_store_unavailable", retryable: true },
    },
  );
});
