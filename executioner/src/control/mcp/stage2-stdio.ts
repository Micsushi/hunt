import { once } from "node:events";

import {
  mcpRequestId,
  parseMcpResponseV4,
  s2StableErrorPolicy,
  type ErrorEnvelopeV3,
  type McpRequestId,
  type McpResponseV4,
  type OperationId,
  type OperationIdentityError,
  type PortResult,
  type S2StableErrorCode,
} from "../../contracts/index.ts";
import type { Stage2McpControl } from "./stage2-control.ts";

export interface Stage2McpStdioOptions {
  readonly nextOperationId: () => PortResult<
    OperationId,
    OperationIdentityError
  >;
}

export async function serveStage2McpStdio(
  api: Stage2McpControl,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  signal: AbortSignal,
  options: Stage2McpStdioOptions,
): Promise<void> {
  try {
    for await (const line of boundedLines(input, signal)) {
      if (signal.aborted) break;
      let value: unknown = null;
      let requestId = fallbackRequestId;
      try {
        value = JSON.parse(line) as unknown;
        requestId = readRequestId(value) ?? fallbackRequestId;
      } catch {
        // The control returns the closed invalid-request transport error.
      }
      const result = await api.handle(value, signal);
      let response: McpResponseV4;
      if (result.ok) {
        response = result.value;
      } else {
        const operation = options.nextOperationId();
        if (!operation.ok) throw new Error(operation.error.code);
        response = transportError(
          requestId,
          result.error.code,
          operation.value,
        );
      }
      if (!output.write(`${JSON.stringify(response)}\n`)) {
        await once(output, "drain");
      }
    }
  } finally {
    await api.close();
  }
}

async function* boundedLines(
  input: NodeJS.ReadableStream,
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (signal.aborted) return;
  const iterator = input[Symbol.asyncIterator]();
  const stopped = Symbol("stopped");
  let stop!: () => void;
  const aborted = new Promise<typeof stopped>((resolve) => {
    stop = () => resolve(stopped);
  });
  signal.addEventListener("abort", stop, { once: true });
  let pending = Buffer.alloc(0);
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next === stopped || next.done) break;
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(String(next.value), "utf8");
      let start = 0;
      while (start < chunk.byteLength) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 ? chunk.byteLength : newline;
        const length = end - start;
        if (pending.byteLength + length > MAX_LINE_BYTES) {
          throw new TypeError("Stage 2 MCP line too large");
        }
        if (length > 0) {
          const segment = chunk.subarray(start, end);
          pending = pending.byteLength === 0
            ? Buffer.from(segment)
            : Buffer.concat([pending, segment], pending.byteLength + length);
        }
        if (newline === -1) break;
        const line = pending.at(-1) === 0x0d
          ? pending.subarray(0, pending.byteLength - 1)
          : pending;
        yield line.toString("utf8");
        pending = Buffer.alloc(0);
        start = newline + 1;
      }
    }
    if (pending.byteLength > 0) yield pending.toString("utf8");
  } finally {
    signal.removeEventListener("abort", stop);
    await iterator.return?.();
  }
}

const MAX_LINE_BYTES = 16 * 1024;

function transportError(
  requestId: McpRequestId,
  code: S2StableErrorCode,
  operationId: OperationId,
): McpResponseV4 {
  const policy = s2StableErrorPolicy[code];
  return parseMcpResponseV4({
    schemaVersion: 4,
    requestId,
    ok: false,
    error: {
      schemaVersion: 3,
      code,
      component: policy.owner,
      phase: "mcp",
      step: "validate",
      retryable: policy.retryable,
      source: { kind: "operation", id: operationId },
    } as ErrorEnvelopeV3,
  });
}

function readRequestId(value: unknown): McpRequestId | null {
  if (
    value === null || typeof value !== "object" ||
    !("requestId" in value) || typeof value.requestId !== "string"
  ) return null;
  try {
    return mcpRequestId(value.requestId);
  } catch {
    return null;
  }
}

const fallbackRequestId = mcpRequestId("request-invalid");
