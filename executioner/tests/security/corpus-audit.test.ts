import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { runCorpusAudit } from "../../src/corpus/audit/index.ts";

test("corpus audit preserves privacy, MCP capability, and module-size gates", async () => {
  const report = await runCorpusAudit(resolve("."));

  assert.equal(report.status, "passed");
  assert.deepEqual(report.privacyViolations, []);
  assert.deepEqual(report.exposedCapabilities, [
    "cancel_journey",
    "journey_result",
    "journey_status",
    "start_journey",
  ]);
  assert.equal(report.blockingIssues.length, 0);
  assert.ok(report.largeModules.length > 0);
  assert.ok(report.largeModules.every((module) => module.disposition.length > 0));
  assert.doesNotMatch(JSON.stringify(report), /password|access_token|@/iu);
});
