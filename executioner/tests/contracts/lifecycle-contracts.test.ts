import assert from "node:assert/strict";
import test from "node:test";

import {
  decideMcpReplay,
  generatedJourneyId,
  createGeneratedIdAllocator,
  mcpRequestId,
  transitionOperationLifecycle,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
  type McpRequest,
} from "../../src/contracts/index.ts";

const ids = createGeneratedIdAllocator({
  next: () => "0123456789abcdef",
});
const generated = generatedJourneyId(ids);
if (!generated.ok) throw new Error("test journey allocation failed");
const journeyId = generated.value;

const statusRequest = (
  requestId: string,
): Extract<McpRequest, { readonly method: "journey_status" | "journey_result" }> => ({
  schemaVersion: 2,
  requestId: mcpRequestId(requestId),
  method: "journey_status",
  params: { journeyId },
});

test("MCP requestId is the sole caller idempotency key", () => {
  const start: McpRequest = {
    schemaVersion: 2,
    requestId: mcpRequestId("request-1"),
    method: "start_journey",
    params: {
      jobId: upstreamJobId("job-1"),
      resumeId: upstreamResumeId("resume-1"),
      profileId: upstreamProfileId("profile-1"),
    },
  };
  const cancel: McpRequest = {
    schemaVersion: 2,
    requestId: mcpRequestId("request-2"),
    method: "cancel_journey",
    params: { journeyId },
  };

  assert.equal("operationId" in start.params, false);
  assert.equal("operationId" in cancel.params, false);
});

test("same request replays while changed input conflicts and busy is record-once", () => {
  const request = statusRequest("request-1");
  const pending = { request, state: { kind: "pending" as const } };

  assert.deepEqual(decideMcpReplay(request, pending, null), {
    kind: "replay",
    state: { kind: "pending" },
  });
  assert.deepEqual(
    decideMcpReplay(statusRequest("request-1"), {
      request: {
        ...request,
        params: {
          journeyId: (() => {
            const result = generatedJourneyId(
              createGeneratedIdAllocator({ next: () => "fedcba9876543210" }),
            );
            if (!result.ok) throw new Error("test journey allocation failed");
            return result.value;
          })(),
        },
      },
      state: { kind: "pending" },
    }, null),
    { kind: "conflict", error: { code: "journey_request_conflict", retryable: false } },
  );
  assert.deepEqual(decideMcpReplay(statusRequest("request-2"), null, mcpRequestId("request-1")), {
    kind: "record_busy",
    state: {
      kind: "failed",
      error: { code: "journey_busy", retryable: false },
    },
  });
  assert.deepEqual(decideMcpReplay(request, null, request.requestId), {
    kind: "record_busy",
    state: {
      kind: "failed",
      error: { code: "journey_busy", retryable: false },
    },
  });
});

test("cancel and uncertain effects invalidate a session before another mutation", () => {
  assert.deepEqual(
    transitionOperationLifecycle(
      { journey: "running", session: "valid" },
      "cancel_requested",
    ),
    { journey: "cancelling", session: "invalidated" },
  );
  assert.deepEqual(
    transitionOperationLifecycle(
      { journey: "running", session: "valid" },
      "effect_uncertain",
    ),
    { journey: "running", session: "invalidated" },
  );
  assert.equal(
    transitionOperationLifecycle(
      { journey: "review_reached", session: "invalidated" },
      "start",
    ),
    null,
  );
});
