import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  generatedOperationId,
  journeyId,
  mcpRequestId,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
} from "../../../src/contracts/index.ts";
import {
  createStage2McpControl,
  serveStage2McpStdio,
} from "../../../src/control/mcp/index.ts";

test("Stage 2 stdio emits v4 only and closes a running journey on EOF", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  let cleaned = false;
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => void (text += chunk));
  const bound = {
    journeyId: journeyId("journey_abcdefghijklmnop"),
    targetHandleId: upstreamJobId("target_ref_abcdefghijklmnop"),
    resumeRef: upstreamResumeId("resume_ref_abcdefghijklmnop"),
    profileRef: upstreamProfileId("profile_ref_abcdefghijklmnop"),
  };
  const api = createStage2McpControl({
    bound,
    nextOperationId: operationIds(),
    async run(signal) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      cleaned = true;
      return {
        schemaVersion: 4,
        journeyId: bound.journeyId,
        status: "cancelled",
        completedPages: 0,
      } as const;
    },
  });
  const serving = serveStage2McpStdio(
    api,
    input,
    output,
    new AbortController().signal,
    { nextOperationId: operationIds() },
  );
  input.end(`${JSON.stringify({
    schemaVersion: 2,
    requestId: mcpRequestId("request-start"),
    method: "start_journey",
    params: {
      jobId: bound.targetHandleId,
      resumeId: bound.resumeRef,
      profileId: bound.profileRef,
    },
  })}\n`);
  await serving;

  const response = JSON.parse(text.trim()) as Record<string, unknown>;
  assert.equal(response.schemaVersion, 4);
  assert.equal(response.ok, true);
  assert.equal(cleaned, true);
});

test("Stage 2 stdio returns from a pre-aborted signal and still closes", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  controller.abort();
  let closed = 0;
  await Promise.race([
    serveStage2McpStdio({
      handle: async () => { throw new Error("not called"); },
      close: async () => void (closed += 1),
    }, input, output, controller.signal, { nextOperationId: operationIds() }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("pre-aborted stdio hung")), 100)
    ),
  ]);
  assert.equal(closed, 1);
});

test("Stage 2 stdio rejects an oversized line and still closes owned cleanup", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let closed = 0;
  const serving = serveStage2McpStdio({
    handle: async () => { throw new Error("oversized line dispatched"); },
    close: async () => void (closed += 1),
  }, input, output, new AbortController().signal, {
    nextOperationId: operationIds(),
  });
  input.end(`${"x".repeat(16 * 1024 + 1)}\n`);
  await assert.rejects(serving, /line too large/u);
  assert.equal(closed, 1);
});

function operationIds() {
  let value = 0;
  return () => ({
    ok: true as const,
    value: generatedOperationId(
      `operation_${(++value).toString(16).padStart(16, "0")}`,
    ),
  });
}
