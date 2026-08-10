import { randomBytes } from "node:crypto";

import { parseStage2RealAcceptanceArgs } from "../src/acceptance/s2-gate.ts";
import { createStage2McpFromPreparedRun } from "../src/composition/s2-mcp-control.ts";
import { createGeneratedIdAllocator } from "../src/contracts/index.ts";
import { serveStage2McpStdio } from "../src/control/mcp/index.ts";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  const args = parseStage2RealAcceptanceArgs(process.argv.slice(2));
  const api = createStage2McpFromPreparedRun(args);
  const ids = createGeneratedIdAllocator({
    next: () => randomBytes(16).toString("hex"),
  });
  await serveStage2McpStdio(
    api,
    process.stdin,
    process.stdout,
    controller.signal,
    { nextOperationId: ids.operationId },
  );
  process.exitCode = 0;
} catch {
  process.stderr.write('{"status":"failed","code":"mcp_admission_failed"}\n');
  process.exitCode = 2;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
