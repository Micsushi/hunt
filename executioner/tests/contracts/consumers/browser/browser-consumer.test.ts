import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contractFixtures,
  createBrowserSessionFake,
} from "../../../../src/testing/contracts/index.ts";

test("a browser consumer can exercise every shared fake operation", async () => {
  const harness = createBrowserSessionFake({
    start: (request) => ({
      ok: true,
      value: {
        sessionId: `session:${request.journeyId}`,
        pageId: "page:account",
      },
    }),
    observe: (request) => ({
      ok: true,
      value: {
        ...contractFixtures.browserObservation,
        sessionId: request.sessionId,
        pageId: request.pageId,
      },
    }),
    mutate: (request) => ({
      ok: true,
      value: {
        operationId: request.operationId,
        pageId: request.pageId,
        attempted: true,
      },
    }),
    navigate: (request) => ({
      ok: true,
      value: {
        operationId: request.operationId,
        fromPageId: request.pageId,
        pageId: "page:profile",
      },
    }),
    close: () => ({ ok: true, value: undefined }),
  });
  const signal = new AbortController().signal;
  const started = await harness.port.start(
    { journeyId: "journey-1", target: "https://fixture.invalid/account" },
    signal,
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const coordinates = started.value;

  await harness.port.observe(coordinates, signal);
  await harness.port.mutate(
    {
      ...coordinates,
      operationId: "operation-1",
      mutation: {
        kind: "type",
        target: contractFixtures.field.target,
        text: "Synthetic",
      },
    },
    signal,
  );
  await harness.port.navigate(
    { ...coordinates, operationId: "operation-2", action: "next" },
    signal,
  );
  await harness.port.close({ sessionId: coordinates.sessionId }, signal);

  assert.deepEqual(
    harness.calls.map(({ operation }) => operation),
    ["start", "observe", "mutate", "navigate", "close"],
  );
  assert.deepEqual(
    await harness.port.observe(coordinates, AbortSignal.abort()),
    {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    },
  );
});
