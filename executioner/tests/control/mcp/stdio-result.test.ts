import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  generatedOperationId,
  mcpRequestId,
} from "../../../src/contracts/index.ts";
import {
  contractFixtures,
  createMcpJourneyApiFake,
} from "../../../src/testing/contracts/index.ts";
import { serveMcpStdio } from "../../../src/control/mcp/index.ts";

test("stdio emits one exact result per line and cleans up once", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  let cleanups = 0;
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    text += chunk;
  });
  const api = createMcpJourneyApiFake({
    handle: async (request) => ({
      ok: true,
      value: {
        schemaVersion: 3,
        requestId: (request as { requestId: ReturnType<typeof mcpRequestId> }).requestId,
        ok: true,
        result: { kind: "terminal", terminal: contractFixtures.terminalResult },
      },
    }),
  });
  const serving = serveMcpStdio(
    api.port,
    input,
    output,
    new AbortController().signal,
    {
      nextOperationId: () => ({
        ok: true,
        value: generatedOperationId("operation_stdio00000000000"),
      }),
      cleanup: () => {
        cleanups += 1;
      },
    },
  );
  input.end(
    `${JSON.stringify({
      schemaVersion: 2,
      requestId: mcpRequestId("request-result"),
      method: "journey_result",
      params: { journeyId: contractFixtures.journeyState.journeyId },
    })}\n`,
  );
  await serving;

  assert.deepEqual(JSON.parse(text.trim()), {
    schemaVersion: 3,
    requestId: "request-result",
    ok: true,
    result: { kind: "terminal", terminal: contractFixtures.terminalResult },
  });
  assert.equal(cleanups, 1);
});

test("stdio shutdown performs cleanup without dispatching another request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const api = createMcpJourneyApiFake();
  let cleanups = 0;
  const serving = serveMcpStdio(
    api.port,
    input,
    output,
    controller.signal,
    {
      nextOperationId: () => ({
        ok: true,
        value: generatedOperationId("operation_stdio00000000000"),
      }),
      cleanup: () => void (cleanups += 1),
    },
  );
  controller.abort();
  input.end();
  await serving;

  assert.equal(api.calls.length, 0);
  assert.equal(cleanups, 1);
});

test("idle stdin abort wakes readline and cleans up exactly once", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  let cleanups = 0;
  const serving = serveMcpStdio(
    createMcpJourneyApiFake().port,
    input,
    output,
    controller.signal,
    {
      nextOperationId: () => ({
        ok: true,
        value: generatedOperationId("operation_stdio00000000000"),
      }),
      cleanup: () => void (cleanups += 1),
    },
  );

  controller.abort();
  await Promise.race([
    serving,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("idle stdio did not stop")), 100),
    ),
  ]);

  assert.equal(cleanups, 1);
  assert.equal(input.destroyed, false);
});

test("transport serialization fails closed when no source can be allocated", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  let cleanups = 0;
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => void (text += chunk));
  const api = createMcpJourneyApiFake({
    handle: {
      ok: false,
      error: {
        code: "mcp_request_invalid",
        retryable: false,
      },
    },
  });
  const serving = serveMcpStdio(
    api.port,
    input,
    output,
    new AbortController().signal,
    {
      nextOperationId: () => ({
        ok: false,
        error: {
          code: "operation_identity_source_invalid",
          retryable: false,
        },
      }),
      cleanup: () => void (cleanups += 1),
    },
  );
  input.end("{}\n");

  await assert.rejects(serving, /operation_identity_source_invalid/u);
  assert.equal(text, "");
  assert.equal(cleanups, 1);
});
