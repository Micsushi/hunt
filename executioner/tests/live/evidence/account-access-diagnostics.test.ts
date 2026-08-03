import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AccountAccessDiagnostics } from "../../../src/live/runner/account-access.ts";
import {
  readAccountAccessDiagnostics,
  writeAccountAccessDiagnostics,
} from "../../../src/live/evidence/account-access-diagnostics.ts";

function blocked(): AccountAccessDiagnostics {
  return {
    schemaVersion: 1,
    evidenceRevision: "s2-account-access-diagnostics-v1",
    checkpoint: "account_access",
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    revisionId: "revision_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop" as never,
    status: "blocked",
    completedSteps: 1,
    events: [{
      schemaVersion: 3,
      eventId: "event_account_access_1" as never,
      journeyId: "journey_abcdefghijklmnop" as never,
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
      journeyId: "journey_abcdefghijklmnop" as never,
      status: "blocked",
      completedPages: 0,
      factualOutcome: {
        source: "target_identity",
        result: { kind: "posting_unavailable", reason: "unavailable" },
      },
    },
    submitActivated: false,
    privacyScan: "pass",
    cleanup: "pass",
  };
}

test("account-access diagnostics seal structured events and the terminal fact", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-diagnostics-"));
  try {
    await writeAccountAccessDiagnostics({
      root,
      diagnostics: blocked(),
      sensitiveValues: ["tenant.wd5.myworkdayjobs.com", "R12345"],
    });

    const value = JSON.parse(readFileSync(join(root, "diagnostics.json"), "utf8"));
    assert.deepEqual(value, blocked());
    assert.deepEqual(readAccountAccessDiagnostics(root), value);
    assert.deepEqual(readdirSync(root), ["diagnostics.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account-access diagnostics reject value-bearing structured fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-diagnostics-"));
  try {
    await assert.rejects(
      writeAccountAccessDiagnostics({
        root,
        diagnostics: blocked(),
        sensitiveValues: ["revision_abcdefghijklmnop"],
      }),
      /account-access-diagnostics evidence denied/u,
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
