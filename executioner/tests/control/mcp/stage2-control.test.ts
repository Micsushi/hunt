import assert from "node:assert/strict";
import test from "node:test";

import {
  generatedOperationId,
  journeyId,
  mcpRequestId,
  parseMcpResponseV4,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
  type McpRequest,
  type TerminalResultV4,
} from "../../../src/contracts/index.ts";
import { createStage2McpControl } from "../../../src/control/mcp/index.ts";

const bound = Object.freeze({
  journeyId: journeyId("journey_abcdefghijklmnop"),
  targetHandleId: upstreamJobId("target_ref_abcdefghijklmnop"),
  resumeRef: upstreamResumeId("resume_ref_abcdefghijklmnop"),
  profileRef: upstreamProfileId("profile_ref_abcdefghijklmnop"),
});

function request(
  requestId: string,
  method: McpRequest["method"],
): McpRequest {
  return method === "start_journey"
    ? {
        schemaVersion: 2,
        requestId: mcpRequestId(requestId),
        method,
        params: {
          jobId: bound.targetHandleId,
          resumeId: bound.resumeRef,
          profileId: bound.profileRef,
        },
      }
    : {
        schemaVersion: 2,
        requestId: mcpRequestId(requestId),
        method,
        params: { journeyId: bound.journeyId },
      };
}

function operations() {
  let value = 0;
  return () => ({
    ok: true as const,
    value: generatedOperationId(
      `operation_${(++value).toString(16).padStart(16, "0")}`,
    ),
  });
}

test("Stage 2 MCP starts in background and cancellation waits for journey cleanup", async () => {
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let started = 0;
  const api = createStage2McpControl({
    bound,
    nextOperationId: operations(),
    async run(signal): Promise<TerminalResultV4> {
      started += 1;
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await cleanup;
      return {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "cancelled",
        completedPages: 0,
      };
    },
  });

  const startRequest = request("request-start", "start_journey");
  const startPending = api.handle(startRequest, new AbortController().signal);
  const startReplayPending = api.handle(
    structuredClone(startRequest),
    new AbortController().signal,
  );
  const start = await startPending;
  assert.deepEqual(await startReplayPending, start);
  assert.equal(start.ok, true);
  if (!start.ok) return;
  assert.deepEqual(parseMcpResponseV4(start.value), {
    schemaVersion: 4,
    requestId: "request-start",
    ok: true,
    result: {
      kind: "accepted",
      operationId: "operation_0000000000000001",
      journeyId: bound.journeyId,
    },
  });
  assert.equal(started, 1);

  const status = await api.handle(
    request("request-status", "journey_status"),
    new AbortController().signal,
  );
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.deepEqual(parseMcpResponseV4(status.value), {
    schemaVersion: 4,
    requestId: "request-status",
    ok: true,
    result: {
      kind: "status",
      progress: {
        journeyId: bound.journeyId,
        status: "running",
        completedSteps: 0,
      },
    },
  });

  const pendingResult = await api.handle(
    request("request-result-pending", "journey_result"),
    new AbortController().signal,
  );
  assert.equal(pendingResult.ok, true);
  if (!pendingResult.ok || pendingResult.value.ok) return;
  assert.equal(pendingResult.value.error.code, "journey_busy");

  let cancelled = false;
  const cancelRequest = request("request-cancel", "cancel_journey");
  const cancel = api.handle(
    cancelRequest,
    new AbortController().signal,
  ).then((value) => {
    cancelled = true;
    return value;
  });
  const cancelReplay = api.handle(
    structuredClone(cancelRequest),
    new AbortController().signal,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, false);
  releaseCleanup();
  const cancelledResponse = await cancel;
  assert.deepEqual(await cancelReplay, cancelledResponse);
  assert.equal(cancelledResponse.ok, true);
  if (!cancelledResponse.ok) return;
  assert.equal(cancelledResponse.value.ok, true);
  if (!cancelledResponse.value.ok) return;
  assert.equal(cancelledResponse.value.result.kind, "accepted");

  const result = await api.handle(
    request("request-result", "journey_result"),
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(parseMcpResponseV4(result.value), {
    schemaVersion: 4,
    requestId: "request-result",
    ok: true,
    result: {
      kind: "terminal",
      terminal: {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "cancelled",
        completedPages: 0,
      },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(result.value),
    /evidenceRoot|configPath|selector|submit|password|https?:/iu,
  );
});

test("Stage 2 MCP denies binding mismatch before effects and records one busy journey", async () => {
  let effects = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = createStage2McpControl({
    bound,
    nextOperationId: operations(),
    async run(): Promise<TerminalResultV4> {
      effects += 1;
      await blocked;
      return {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "review_reached",
        completedPages: 3,
      };
    },
  });

  for (const [key, value] of [
    ["jobId", upstreamJobId("target_ref_wrongwrongwrong1")],
    ["resumeId", upstreamResumeId("resume_ref_wrongwrongwrong1")],
    ["profileId", upstreamProfileId("profile_ref_wrongwrongwrong")],
  ] as const) {
    const input = request(`request-mismatch-${key}`, "start_journey");
    if (input.method !== "start_journey") throw new Error("start required");
    const denied = await api.handle({
      ...input,
      params: { ...input.params, [key]: value },
    }, new AbortController().signal);
    assert.equal(denied.ok, true);
    if (!denied.ok || denied.value.ok) continue;
    assert.equal(denied.value.error.code, "journey_input_invalid");
  }
  assert.equal(effects, 0);

  const active = request("request-active", "start_journey");
  await api.handle(active, new AbortController().signal);
  assert.equal(effects, 1);
  const replay = await api.handle(
    structuredClone(active),
    new AbortController().signal,
  );
  assert.equal(replay.ok, true);
  const busy = await api.handle(
    request("request-busy", "start_journey"),
    new AbortController().signal,
  );
  assert.equal(busy.ok, true);
  if (!busy.ok || busy.value.ok) return;
  assert.equal(busy.value.error.code, "journey_busy");
  assert.equal(effects, 1);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("Stage 2 MCP replays exactly, conflicts changed input, and rejects hostile input", async () => {
  const api = createStage2McpControl({
    bound,
    nextOperationId: operations(),
    async run(): Promise<TerminalResultV4> {
      return {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "review_reached",
        completedPages: 3,
      };
    },
  });
  const status = request("request-replay", "journey_status");
  const first = await api.handle(status, new AbortController().signal);
  assert.deepEqual(
    await api.handle(structuredClone(status), new AbortController().signal),
    first,
  );
  const conflict = await api.handle(
    { ...status, method: "journey_result" },
    new AbortController().signal,
  );
  assert.equal(conflict.ok, true);
  if (!conflict.ok || conflict.value.ok) return;
  assert.equal(conflict.value.error.code, "journey_request_conflict");

  let getterCalls = 0;
  const hostile = Object.defineProperty({}, "schemaVersion", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 2;
    },
  });
  const invalid = await api.handle(hostile, new AbortController().signal);
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;
  assert.equal(invalid.error.code, "mcp_request_invalid");
  assert.equal(getterCalls, 0);
});

test("Stage 2 MCP snapshots its out-of-band opaque binding", async () => {
  const mutable = { ...bound };
  let effects = 0;
  const api = createStage2McpControl({
    bound: mutable,
    nextOperationId: operations(),
    async run(): Promise<TerminalResultV4> {
      effects += 1;
      return {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "review_reached",
        completedPages: 3,
      };
    },
  });
  mutable.targetHandleId = upstreamJobId("target_ref_changedchanged12");
  const result = await api.handle(
    request("request-snapshot", "start_journey"),
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.ok, true);
  assert.equal(effects, 1);
});

test("Stage 2 MCP close aborts a running journey and awaits owned cleanup", async () => {
  let cleaned = false;
  const api = createStage2McpControl({
    bound,
    nextOperationId: operations(),
    async run(signal): Promise<TerminalResultV4> {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      cleaned = true;
      return {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "cancelled",
        completedPages: 0,
      };
    },
  });
  await api.handle(
    request("request-close-start", "start_journey"),
    new AbortController().signal,
  );
  await api.close();
  assert.equal(cleaned, true);
});

test("accepted cancellation cannot later project Review when the runner ignores abort", async () => {
  let release!: () => void;
  const finishing = new Promise<void>((resolve) => void (release = resolve));
  const api = createStage2McpControl({
    bound,
    nextOperationId: operations(),
    async run(): Promise<TerminalResultV4> {
      await finishing;
      return {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "review_reached",
        completedPages: 3,
      };
    },
  });
  await api.handle(request("request-ignore-start", "start_journey"), new AbortController().signal);
  const cancelling = api.handle(
    request("request-ignore-cancel", "cancel_journey"),
    new AbortController().signal,
  );
  release();
  const cancel = await cancelling;
  assert.equal(cancel.ok && cancel.value.ok, true);
  const result = await api.handle(
    request("request-ignore-result", "journey_result"),
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (!result.ok || !result.value.ok || result.value.result.kind !== "terminal") return;
  assert.deepEqual(result.value.result.terminal, {
    schemaVersion: 4,
    journeyId: bound.journeyId,
    status: "cancelled",
    completedPages: 3,
  });
});

test("accepted cancellation preserves an exact post-abort cleanup failure", async () => {
  const api = createStage2McpControl({
    bound,
    nextOperationId: operations(),
    async run(signal): Promise<TerminalResultV4> {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      return {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "failed",
        completedPages: 2,
        errorCode: "browser_profile_cleanup_failed",
      };
    },
  });
  await api.handle(request("request-cleanup-start", "start_journey"), new AbortController().signal);
  const cancel = await api.handle(
    request("request-cleanup-cancel", "cancel_journey"),
    new AbortController().signal,
  );
  assert.equal(cancel.ok && cancel.value.ok, true);
  const result = await api.handle(
    request("request-cleanup-result", "journey_result"),
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (!result.ok || !result.value.ok || result.value.result.kind !== "terminal") return;
  assert.deepEqual(result.value.result.terminal, {
    schemaVersion: 4,
    journeyId: bound.journeyId,
    status: "failed",
    completedPages: 2,
    errorCode: "browser_profile_cleanup_failed",
  });
});

test("Stage 2 MCP bounds replay memory while preserving cancellation cleanup", async () => {
  let cleaned = false;
  const api = createStage2McpControl({
    bound,
    nextOperationId: operations(),
    async run(signal): Promise<TerminalResultV4> {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      cleaned = true;
      return {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "cancelled",
        completedPages: 0,
      };
    },
  });
  await api.handle(request("request-bounded-start", "start_journey"), new AbortController().signal);
  let overflows = 0;
  for (let index = 0; index < 300; index += 1) {
    const response = await api.handle({
      schemaVersion: 2,
      requestId: mcpRequestId(`request-bounded-status-${index}`),
      method: "journey_status",
      params: { journeyId: bound.journeyId },
    }, new AbortController().signal);
    if (!response.ok && response.error.code === "mcp_internal_error") {
      overflows += 1;
    }
  }
  assert.equal(overflows > 0, true);
  await api.handle(request("request-bounded-cancel", "cancel_journey"), new AbortController().signal);
  assert.equal(cleaned, true);
  const result = await api.handle(
    request("request-bounded-result", "journey_result"),
    new AbortController().signal,
  );
  assert.equal(result.ok && result.value.ok, true);
});

test("ordinary request flood cannot starve natural terminal status and result", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => void (release = resolve));
  const api = createStage2McpControl({
    bound,
    nextOperationId: operations(),
    async run(): Promise<TerminalResultV4> {
      await blocked;
      return {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "review_reached",
        completedPages: 3,
      };
    },
  });
  await api.handle(request("request-natural-start", "start_journey"), new AbortController().signal);
  for (let index = 0; index < 300; index += 1) {
    await api.handle({
      schemaVersion: 2,
      requestId: mcpRequestId(`request-natural-flood-${index}`),
      method: "journey_status",
      params: { journeyId: bound.journeyId },
    }, new AbortController().signal);
  }
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const method of ["journey_status", "journey_result"] as const) {
    const response = await api.handle(
      request(`request-natural-${method}`, method),
      new AbortController().signal,
    );
    assert.equal(response.ok && response.value.ok, true);
  }
});

test("wrong-journey cancel flood cannot starve exact active cancellation", async () => {
  let cleaned = false;
  const api = createStage2McpControl({
    bound,
    nextOperationId: operations(),
    async run(signal): Promise<TerminalResultV4> {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      cleaned = true;
      return {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "cancelled",
        completedPages: 0,
      };
    },
  });
  await api.handle(request("request-hostile-start", "start_journey"), new AbortController().signal);
  const wrongJourney = journeyId("journey_wrongwrongwrong1");
  for (let index = 0; index < 300; index += 1) {
    await api.handle({
      schemaVersion: 2,
      requestId: mcpRequestId(`request-hostile-cancel-${index}`),
      method: "cancel_journey",
      params: { journeyId: wrongJourney },
    }, new AbortController().signal);
  }
  const exact = await api.handle(
    request("request-hostile-exact-cancel", "cancel_journey"),
    new AbortController().signal,
  );
  assert.equal(exact.ok && exact.value.ok, true);
  assert.equal(cleaned, true);
});
