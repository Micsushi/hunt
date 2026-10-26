import assert from "node:assert/strict";
import { test } from "node:test";

import {
  eventId,
  generatedOperationId,
  generatedReportId,
  journeyId,
  type FailureReportRequest,
} from "../../../src/contracts/index.ts";
import { FactualFailureReporter } from "../../../src/observability/errors/reporter.ts";

function request(
  overrides: Partial<FailureReportRequest> = {},
): FailureReportRequest {
  return {
    reportId: generatedReportId("report_0123456789abcdef"),
    context: {
      journeyId: journeyId("journey_0123456789abcdef"),
      component: "F3",
      phase: "browser",
      step: "observe",
      code: "browser_timeout",
      retryable: true,
      source: {
        kind: "operation",
        id: generatedOperationId("operation_0123456789abcdef"),
      },
    },
    ...overrides,
  };
}

test("reports exact factual observations and delivers one value-free notification", async () => {
  const notifications: unknown[] = [];
  const reporter = new FactualFailureReporter(async (report) => {
    notifications.push(report);
  });
  const expected = request();

  const first = await reporter.report(expected, new AbortController().signal);
  const duplicate = await reporter.report(expected, new AbortController().signal);

  assert.deepEqual(first, {
    ok: true,
    value: {
      report: expected,
      notification: { reportId: expected.reportId, delivered: true },
    },
  });
  assert.deepEqual(duplicate, first);
  assert.deepEqual(notifications, [expected]);
  assert.equal(JSON.stringify(notifications).includes("applicant"), false);
  assert.notEqual(first.ok && first.value.report, expected);
});

test("keeps an explicitly verified cause separate from the observation", async () => {
  const reporter = new FactualFailureReporter();
  const caused = request({
    context: {
      ...request().context,
      cause: {
        verification: "verified",
        code: "fixture_timeout",
        source: { kind: "event", id: eventId("event-fixture-timeout") },
      },
    },
  });
  const result = await reporter.report(caused, new AbortController().signal);

  assert.equal(
    result.ok ? result.value.report.context.cause?.code : undefined,
    "fixture_timeout",
  );
});

test("derives exact owner and retryability and rejects factual outcomes as failures", async () => {
  const reporter = new FactualFailureReporter();
  const invalidContexts = [
    { ...request().context, component: "F9" },
    { ...request().context, retryable: false },
    { ...request().context, code: "profile_answer_missing" },
    { ...request().context, rawText: "private applicant text" },
    {
      ...request().context,
      journeyId: "applicant@example.invalid",
    },
    {
      ...request().context,
      source: { kind: "operation", id: "C:\\private\\resume.pdf" },
    },
  ];

  for (const context of invalidContexts) {
    assert.deepEqual(
      await reporter.report(
        request({ context: context as FailureReportRequest["context"] }),
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "failure_context_invalid", retryable: false },
      },
    );
  }
});

test("rejects a versioned live failure context without notification or retained state", async () => {
  let notifications = 0;
  const reporter = new FactualFailureReporter(async () => {
    notifications += 1;
  });
  const versioned = {
    ...request(),
    context: { ...request().context, schemaVersion: 2 },
  } as unknown as FailureReportRequest;

  assert.deepEqual(
    await reporter.report(versioned, new AbortController().signal),
    {
      ok: false,
      error: { code: "failure_context_invalid", retryable: false },
    },
  );
  assert.equal(notifications, 0);
  assert.equal(
    (await reporter.report(request(), new AbortController().signal)).ok,
    true,
  );
  assert.equal(notifications, 1);
});

test("report rejects accessors and proxies without executing traps or retaining state", async () => {
  let traps = 0;
  let notifications = 0;
  const reporter = new FactualFailureReporter(async () => {
    notifications += 1;
  });
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "reportId", {
    enumerable: true,
    value: generatedReportId("report_0123456789abcdef"),
  });
  Object.defineProperty(accessor, "context", {
    enumerable: true,
    get() {
      traps += 1;
      return request().context;
    },
  });
  const proxy = new Proxy(request(), {
    get(target, key, receiver) {
      traps += 1;
      return Reflect.get(target, key, receiver);
    },
    ownKeys(target) {
      traps += 1;
      return Reflect.ownKeys(target);
    },
  });

  for (const hostile of [accessor, proxy]) {
    assert.deepEqual(
      await reporter.report(
        hostile as unknown as FailureReportRequest,
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "failure_context_invalid", retryable: false },
      },
    );
  }
  assert.equal(traps, 0);
  assert.equal(notifications, 0);
  assert.equal(
    (await reporter.report(request(), new AbortController().signal)).ok,
    true,
  );
  assert.equal(notifications, 1);
});

test("uses exact report identity errors for malformed and conflicting IDs", async () => {
  const reporter = new FactualFailureReporter();
  assert.deepEqual(
    await reporter.report(
      { ...request(), reportId: "resume@example.invalid" } as FailureReportRequest,
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "report_identity_source_invalid", retryable: false },
    },
  );
  assert.equal(
    (await reporter.report(request(), new AbortController().signal)).ok,
    true,
  );
  assert.deepEqual(
    await reporter.report(
      request({ context: { ...request().context, step: "start" } }),
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "report_identity_collision", retryable: false },
    },
  );
});

test("bounds notification attempts across calls and returns policy retryability", async () => {
  let attempts = 0;
  const reporter = new FactualFailureReporter(async () => {
    attempts += 1;
    throw new Error("unavailable");
  });
  const expected = {
    ok: false,
    error: { code: "notification_unavailable", retryable: true },
  } as const;

  assert.deepEqual(
    await reporter.report(request(), new AbortController().signal),
    expected,
  );
  assert.deepEqual(
    await reporter.report(request(), new AbortController().signal),
    expected,
  );
  assert.equal(attempts, 2);
});

test("cancellation preserves a projected report without fabricating delivery", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const reporter = new FactualFailureReporter(async () => {
    attempts += 1;
    if (attempts === 1) {
      controller.abort();
      throw new Error("cancelled");
    }
  });

  assert.deepEqual(await reporter.report(request(), controller.signal), {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  const retried = await reporter.report(request(), new AbortController().signal);
  assert.equal(retried.ok && retried.value.notification.delivered, true);
  assert.equal(attempts, 2);
});

test("an acknowledged notification remains delivered when cancellation races its return", async () => {
  const controller = new AbortController();
  let notifications = 0;
  const reporter = new FactualFailureReporter(async () => {
    notifications += 1;
    controller.abort();
  });

  const acknowledged = await reporter.report(request(), controller.signal);
  assert.equal(acknowledged.ok && acknowledged.value.notification.delivered, true);
  assert.equal(
    (await reporter.report(request(), new AbortController().signal)).ok,
    true,
  );
  assert.equal(notifications, 1);
});

test("pre-cancellation has no report or notification side effect", async () => {
  let notifications = 0;
  const reporter = new FactualFailureReporter(async () => {
    notifications += 1;
  });

  assert.deepEqual(await reporter.report(request(), AbortSignal.abort()), {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.equal(notifications, 0);
  assert.equal(
    (await reporter.report(request(), new AbortController().signal)).ok,
    true,
  );
  assert.equal(notifications, 1);
});

test("serializes concurrent duplicate reports to one delivered notification", async () => {
  let notifications = 0;
  const reporter = new FactualFailureReporter(async () => {
    notifications += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  const results = await Promise.all([
    reporter.report(request(), new AbortController().signal),
    reporter.report(request(), new AbortController().signal),
  ]);

  assert.equal(results.every(({ ok }) => ok), true);
  assert.equal(notifications, 1);
});
