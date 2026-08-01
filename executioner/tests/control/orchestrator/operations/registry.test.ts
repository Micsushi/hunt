import assert from "node:assert/strict";
import test from "node:test";

import {
  generatedOperationId,
  journeyId,
  mcpRequestId,
  providerError,
  type McpRequest,
  type McpResponse,
  type OperationId,
} from "../../../../src/contracts/index.ts";
import { createOperationRegistry } from "../../../../src/control/orchestrator/operations/index.ts";

const start = (requestId: string, jobId = "job-synthetic") =>
  ({
    schemaVersion: 2,
    requestId: mcpRequestId(requestId),
    method: "start_journey",
    params: {
      jobId,
      resumeId: "resume-synthetic",
      profileId: "profile-synthetic",
    },
  }) as McpRequest;

const response = (request: McpRequest): McpResponse => ({
  schemaVersion: 3,
  requestId: request.requestId,
  ok: false,
  error: {
    schemaVersion: 2,
    code: "journey_not_found",
    component: "F9",
    phase: "orchestration",
    step: "start",
    retryable: false,
    source: {
      kind: "operation",
      id: generatedOperationId("operation_aaaaaaaaaaaaaaaa"),
    },
  },
});

function ids(...values: OperationId[]) {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    return value === undefined
      ? { ok: false as const, error: providerError("operation_identity_source_invalid") }
      : { ok: true as const, value };
  };
}

test("identical pending and completed requests replay one generated operation", () => {
  const operationId = generatedOperationId("operation_0123456789abcdef");
  const registry = createOperationRegistry(ids(operationId));
  const request = start("request-one");

  assert.deepEqual(registry.admit(request), { kind: "execute", operationId });
  assert.deepEqual(registry.admit(structuredClone(request)), {
    kind: "replay",
    state: { kind: "pending" },
  });

  const recorded = response(request);
  registry.complete(request.requestId, recorded);
  assert.deepEqual(registry.admit(structuredClone(request)), {
    kind: "replay",
    state: { kind: "final", response: recorded },
  });
});

test("replay and snapshot return immutable defensive copies", () => {
  const operationId = generatedOperationId("operation_0123456789abcdef");
  const registry = createOperationRegistry(ids(operationId));
  const request = start("request-one");
  registry.admit(request);
  registry.complete(request.requestId, response(request));

  const replay = registry.admit(request);
  assert.equal(replay.kind, "replay");
  if (replay.kind !== "replay" || replay.state.kind !== "final") return;
  const finalState = replay.state;
  assert.equal(Object.isFrozen(finalState), true);
  assert.equal(Object.isFrozen(finalState.response), true);
  assert.throws(() => {
    (finalState.response as { schemaVersion: number }).schemaVersion = 99;
  });

  const snapshot = registry.snapshot(request.requestId);
  assert.notEqual(snapshot, replay.state);
  assert.deepEqual(snapshot, replay.state);
  assert.deepEqual(registry.admit(request), replay);
});

test("a changed requestId payload conflicts without allocating or replacing state", () => {
  const operationId = generatedOperationId("operation_0123456789abcdef");
  const registry = createOperationRegistry(ids(operationId));
  const original = start("request-one");
  assert.equal(registry.admit(original).kind, "execute");

  assert.deepEqual(registry.admit(start("request-one", "job-changed")), {
    kind: "conflict",
    error: providerError("journey_request_conflict"),
  });
  assert.deepEqual(registry.admit(original), {
    kind: "replay",
    state: { kind: "pending" },
  });
});

test("a distinct request admitted while another is active records busy permanently", () => {
  const operationId = generatedOperationId("operation_0123456789abcdef");
  const registry = createOperationRegistry(ids(operationId));
  const active = start("request-active");
  const busy = start("request-busy", "job-other");

  assert.equal(registry.admit(active).kind, "execute");
  assert.deepEqual(registry.admit(busy), {
    kind: "record_busy",
    state: { kind: "failed", error: providerError("journey_busy") },
  });
  registry.fail(active.requestId, providerError("journey_retry_exhausted"));
  assert.deepEqual(registry.admit(structuredClone(busy)), {
    kind: "replay",
    state: { kind: "failed", error: providerError("journey_busy") },
  });
});

test("malformed delimiters cannot alias structural request identity", () => {
  const operationId = generatedOperationId("operation_0123456789abcdef");
  const registry = createOperationRegistry(ids(operationId));
  const request = start("request-one", "job-a");
  assert.equal(registry.admit(request).kind, "execute");

  const changed = structuredClone(request) as unknown as {
    params: { jobId: string; resumeId: string; profileId: string };
  };
  changed.params.jobId = "job-a\u0000resume-synthetic";
  changed.params.resumeId = "profile-synthetic";
  changed.params.profileId = "x";
  assert.equal(
    registry.admit(changed as unknown as McpRequest).kind,
    "conflict",
  );
});

test("identity allocation failures leave no pending record", () => {
  const registry = createOperationRegistry(ids());
  const request = start("request-one");

  assert.deepEqual(registry.admit(request), {
    kind: "failed",
    error: providerError("operation_identity_source_invalid"),
  });
  assert.deepEqual(registry.snapshot(request.requestId), null);
});

test("all four MCP methods share the same replay registry", () => {
  const operationIds = [
    generatedOperationId("operation_1111111111111111"),
    generatedOperationId("operation_2222222222222222"),
    generatedOperationId("operation_3333333333333333"),
    generatedOperationId("operation_4444444444444444"),
  ];
  const registry = createOperationRegistry(ids(...operationIds));
  const journey = journeyId("journey_0123456789abcdef");
  const requests: McpRequest[] = [
    start("request-start"),
    {
      schemaVersion: 2,
      requestId: mcpRequestId("request-status"),
      method: "journey_status",
      params: { journeyId: journey },
    },
    {
      schemaVersion: 2,
      requestId: mcpRequestId("request-cancel"),
      method: "cancel_journey",
      params: { journeyId: journey },
    },
    {
      schemaVersion: 2,
      requestId: mcpRequestId("request-result"),
      method: "journey_result",
      params: { journeyId: journey },
    },
  ];

  requests.forEach((request, index) => {
    assert.deepEqual(registry.admit(request), {
      kind: "execute",
      operationId: operationIds[index],
    });
    registry.complete(request.requestId, response(request));
    assert.equal(registry.admit(structuredClone(request)).kind, "replay");
  });
});
