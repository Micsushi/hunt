import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseMcpResponseV4 } from "../../../src/contracts/index.ts";
import { createStage2DiagnosticsMcpFromEvidenceRoot } from "../../../src/composition/s2-diagnostics-mcp.ts";
import { writeAccountAccessDiagnostics } from "../../../src/live/evidence/account-access-diagnostics.ts";
import type { AccountAccessDiagnostics } from "../../../src/live/runner/account-access.ts";

const journeyId = "journey_abcdefghijklmnop" as never;

function blocked(): AccountAccessDiagnostics {
  return {
    schemaVersion: 1,
    evidenceRevision: "s2-account-access-diagnostics-v1",
    checkpoint: "account_access",
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    revisionId: "revision_abcdefghijklmnop",
    journeyId,
    status: "blocked",
    completedSteps: 1,
    events: [{
      schemaVersion: 3,
      eventId: "event_account_access_1" as never,
      journeyId,
      component: "F3",
      phase: "account_access",
      step: "navigate",
      kind: "step_completed",
      at: "2026-08-01T12:00:00.000Z",
      source: {
        kind: "operation",
        id: "operation_abcdefghijklmnop1" as never,
      },
    }],
    terminal: {
      schemaVersion: 4,
      journeyId,
      status: "blocked",
      completedPages: 0,
      factualOutcome: {
        source: "target_identity",
        result: { kind: "posting_unavailable", reason: "not_found" },
      },
    },
    submitActivated: false,
    privacyScan: "pass",
    cleanup: "pass",
  };
}

test("Stage 2 MCP status and result read the same sealed diagnostic truth", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-diagnostics-mcp-"));
  try {
    await writeAccountAccessDiagnostics({
      root,
      diagnostics: blocked(),
      sensitiveValues: [],
    });
    const api = createStage2DiagnosticsMcpFromEvidenceRoot({
      evidenceRoot: root,
      nextOperationId: operationIds(),
    });

    const status = await api.handle({
      schemaVersion: 2,
      requestId: "request-status",
      method: "journey_status",
      params: { journeyId },
    }, new AbortController().signal);
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.deepEqual(parseMcpResponseV4(status.value), {
      schemaVersion: 4,
      requestId: "request-status",
      ok: true,
      result: {
        kind: "status",
        progress: { journeyId, status: "blocked", completedSteps: 1 },
      },
    });

    const result = await api.handle({
      schemaVersion: 2,
      requestId: "request-result",
      method: "journey_result",
      params: { journeyId },
    }, new AbortController().signal);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(parseMcpResponseV4(result.value), {
      schemaVersion: 4,
      requestId: "request-result",
      ok: true,
      result: { kind: "terminal", terminal: blocked().terminal },
    });
    assert.equal(JSON.stringify(result.value).includes("posting_apply"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stage 2 MCP replay is stable and changed-input reuse fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-diagnostics-mcp-"));
  try {
    await writeAccountAccessDiagnostics({
      root,
      diagnostics: blocked(),
      sensitiveValues: [],
    });
    const api = createStage2DiagnosticsMcpFromEvidenceRoot({
      evidenceRoot: root,
      nextOperationId: operationIds(),
    });
    const request = {
      schemaVersion: 2 as const,
      requestId: "request-replay",
      method: "journey_result" as const,
      params: { journeyId },
    };
    const first = await api.handle(request, new AbortController().signal);
    rmSync(root, { recursive: true, force: true });
    const replay = await api.handle(request, new AbortController().signal);
    assert.deepEqual(replay, first);

    const conflict = await api.handle({
      ...request,
      method: "journey_status",
    }, new AbortController().signal);
    assert.equal(conflict.ok, true);
    if (!conflict.ok) return;
    assert.equal(conflict.value.ok, false);
    if (conflict.value.ok) return;
    assert.equal(conflict.value.error.code, "journey_request_conflict");
    const conflictReplay = await api.handle({
      ...request,
      method: "journey_status",
    }, new AbortController().signal);
    assert.deepEqual(conflictReplay, conflict);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function operationIds() {
  let value = 0;
  return () => ({
    ok: true as const,
    value: `operation_abcdefghijklmnop${value += 1}` as never,
  });
}
