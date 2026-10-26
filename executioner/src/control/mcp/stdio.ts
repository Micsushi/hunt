import { once } from "node:events";
import { createInterface } from "node:readline";

import {
  mcpRequestId,
  type McpJourneyApi,
  type McpRequestId,
  type OperationId,
  type OperationIdentityError,
  type PortResult,
} from "../../contracts/index.ts";
import { errorResponse } from "./facade.ts";

export interface McpStdioOptions {
  readonly nextOperationId: () => PortResult<
    OperationId,
    OperationIdentityError
  >;
  readonly cleanup?: () => void | Promise<void>;
}

export async function serveMcpStdio(
  api: McpJourneyApi,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  signal: AbortSignal,
  options: McpStdioOptions,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const stop = () => lines.close();
  signal.addEventListener("abort", stop, { once: true });
  try {
    for await (const line of lines) {
      if (signal.aborted) break;
      let value: unknown = null;
      let requestId = fallbackRequestId;
      try {
        value = JSON.parse(line) as unknown;
        requestId = readRequestId(value) ?? fallbackRequestId;
      } catch {
        // The facade returns the closed invalid-request transport error.
      }
      const result = await api.handle(value as never, signal);
      let response;
      if (result.ok) {
        response = result.value;
      } else {
        const operationId = options.nextOperationId();
        if (!operationId.ok) throw new Error(operationId.error.code);
        response = errorResponse(
          requestId,
          result.error,
          operationId.value,
          "mcp",
          "validate",
        );
      }
      if (!output.write(`${JSON.stringify(response)}\n`)) {
        await once(output, "drain");
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
    lines.close();
    await options.cleanup?.();
  }
}

function readRequestId(value: unknown): McpRequestId | null {
  if (
    value === null ||
    typeof value !== "object" ||
    !("requestId" in value) ||
    typeof value.requestId !== "string"
  ) {
    return null;
  }
  try {
    return mcpRequestId(value.requestId);
  } catch {
    return null;
  }
}

const fallbackRequestId = mcpRequestId("request-invalid");
