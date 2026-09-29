import assert from "node:assert/strict";
import { test } from "node:test";

import { createC1TerminalPublisher, publishC1Outcome } from "../../src/observability/c1-outcomes.ts";
import { journeyId } from "../../src/contracts/index.ts";

test("C3 publishes only compact factual outcomes to C1", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  await publishC1Outcome(
    "http://127.0.0.1:8001",
    "service-token",
    { jobId: 42, outcome: "blocked", reason: "profile_answer_missing" },
    (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  );
  assert.equal(calls[0]?.url, "http://127.0.0.1:8001/jobs/42/c3-outcome");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer service-token");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    outcome: "blocked", reason: "profile_answer_missing",
  });
});

test("C3 rejects prose and unknown outcome widening", async () => {
  await assert.rejects(() => publishC1Outcome(
    "http://127.0.0.1:8001", undefined,
    { jobId: 1, outcome: "blocked", reason: "contains personal prose" },
  ));
  await assert.rejects(() => publishC1Outcome(
    "http://127.0.0.1:8001", undefined,
    { jobId: 1, outcome: "submitted" as "blocked" },
  ));
});

test("terminal reporting requires an explicit matching C1 row binding", async () => {
  const environment = {
    HUNT_C1_OUTCOME_BASE_URL: "http://127.0.0.1:8001",
    HUNT_C1_OUTCOME_JOB_ID: "42",
    HUNT_C1_OUTCOME_TARGET_HANDLE_ID: "target_test",
    HUNT_C1_OUTCOME_TOKEN: "service-token",
  };
  assert.equal(createC1TerminalPublisher("target_test", {}), undefined);
  assert.throws(() => createC1TerminalPublisher("other_target", environment));
  assert.throws(() => createC1TerminalPublisher("target_test", { HUNT_C1_OUTCOME_JOB_ID: "42" }));
  const bodies: unknown[] = [];
  const publish = createC1TerminalPublisher("target_test", environment, (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 200 });
  }) as typeof fetch)!;
  for (const status of ["review_reached", "cancelled"] as const) {
    await publish({ schemaVersion: 4, journeyId: journeyId("journey_0123456789abcdef"), completedPages: 0, status });
  }
  assert.deepEqual(bodies, [
    { outcome: "ready_for_review", reason: "review_reached" },
    { outcome: "cancelled", reason: "cancelled" },
  ]);
});
