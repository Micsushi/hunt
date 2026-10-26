import assert from "node:assert/strict";
import test from "node:test";

import {
  createGeneratedIdAllocator,
  eventId,
  generatedEvidenceId,
  fieldId,
  fixtureRunId,
  generatedOperationId,
  generatedReportId,
  generatedJourneyId,
  generatedSessionId,
  mcpRequestId,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
  type NonSensitiveIdSource,
} from "../../src/contracts/index.ts";

test("upstream handles and MCP idempotency keys are bounded opaque values", () => {
  assert.equal(upstreamJobId("job-123"), "job-123");
  assert.equal(upstreamResumeId("resume-123"), "resume-123");
  assert.equal(upstreamProfileId("profile-123"), "profile-123");
  assert.equal(mcpRequestId("request-123"), "request-123");

  for (const invalid of [
    "",
    " contains-space",
    "has:delimiter",
    "has/slash",
    "has\nnewline",
    "nonascii-é",
    "x".repeat(129),
  ]) {
    assert.throws(() => upstreamJobId(invalid), /identifier/u);
    assert.throws(() => mcpRequestId(invalid), /identifier/u);
  }
});

test("internal field, event, evidence, and fixture coordinates are bounded", () => {
  assert.equal(fieldId("field-1"), "field-1");
  assert.equal(eventId("event-1"), "event-1");
  assert.equal(generatedEvidenceId("evidence_0123456789abcdef"), "evidence_0123456789abcdef");
  assert.equal(fixtureRunId("fixture-run-1"), "fixture-run-1");
  for (const parse of [fieldId, eventId, generatedEvidenceId, fixtureRunId]) {
    assert.throws(() => parse("has:delimiter"), /identifier/u);
  }
});

test("journey and browser session identifiers come from an injected non-sensitive source", () => {
  const issued: string[] = [];
  const source: NonSensitiveIdSource = {
    next(scope) {
      issued.push(scope);
      return "0123456789abcdef";
    },
  };
  const allocator = createGeneratedIdAllocator(source);

  assert.deepEqual(generatedJourneyId(allocator), {
    ok: true,
    value: "journey_0123456789abcdef",
  });
  assert.deepEqual(generatedSessionId(allocator), {
    ok: true,
    value: "browser_session_0123456789abcdef",
  });
  assert.deepEqual(issued, ["journey", "browser_session"]);

  assert.deepEqual(
    generatedJourneyId(
      createGeneratedIdAllocator({ next: () => "private applicant text" }),
    ),
    {
      ok: false,
      error: { code: "journey_identity_source_invalid", retryable: false },
    },
  );
});

test("generated identifier allocation retries collisions within a fixed bound", () => {
  const values = [
    "0123456789abcdef",
    "0123456789abcdef",
    "fedcba9876543210",
  ];
  const allocator = createGeneratedIdAllocator({
    next: () => values.shift() ?? "journey-2",
  });

  assert.deepEqual(allocator.journeyId(), { ok: true, value: "journey_0123456789abcdef" });
  assert.deepEqual(allocator.journeyId(), { ok: true, value: "journey_fedcba9876543210" });
  const exhausted = createGeneratedIdAllocator({
    next: () => "aaaaaaaaaaaaaaaa",
  });
  assert.equal(exhausted.journeyId().ok, true);
  assert.deepEqual(exhausted.journeyId(), {
    ok: false,
    error: { code: "journey_identity_collision", retryable: false },
  });
});

test("operation IDs use the full generated grammar and allocator sources fail closed", () => {
  assert.equal(
    generatedOperationId("operation_0123456789abcdef"),
    "operation_0123456789abcdef",
  );
  assert.throws(() => generatedOperationId("operation-1"), RangeError);
  const nonString = createGeneratedIdAllocator({ next: () => 42 } as unknown as NonSensitiveIdSource);
  assert.deepEqual(nonString.operationId(), {
    ok: false,
    error: { code: "operation_identity_source_invalid", retryable: false },
  });
  const throwing = createGeneratedIdAllocator({ next: () => { throw new Error("source failed"); } });
  assert.deepEqual(throwing.sessionId(), {
    ok: false,
    error: { code: "session_identity_source_invalid", retryable: false },
  });
});

test("failure report IDs use generated bounded allocation", () => {
  assert.equal(generatedReportId("report_0123456789abcdef"), "report_0123456789abcdef");
  assert.throws(() => generatedReportId("report-short"), RangeError);
  const allocator = createGeneratedIdAllocator({ next: () => "0123456789abcdef" });
  assert.deepEqual(allocator.reportId(), {
    ok: true,
    value: "report_0123456789abcdef",
  });
});
