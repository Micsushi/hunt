import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  sealPageLocalTerminal,
  writePageLocalPendingTerminal,
} from "../../src/composition/private/s2-page-local-terminal.ts";

test("page-local failure seals causal result only after exact process cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-c3-page-terminal-"));
  try {
    const evidenceRoot = join(root, "retained", "run_20260901_abcdefghijklmnop", "evidence");
    const transientRoot = join(root, "transient", "run_20260901_abcdefghijklmnop");
    await mkdir(evidenceRoot, { recursive: true });
    await mkdir(transientRoot, { recursive: true });
    const configPath = join(transientRoot, "owner-input.json");
    await writeFile(configPath, `${JSON.stringify({
      revisionId: "revision_abcdefghijklmnop",
      journeyId: "journey_abcdefghijklmnop",
      target: { handleId: "target_ref_abcdefghijklmnop" },
    })}\n`);
    const args = {
      checkpoint: "profile_verified" as const,
      configPath,
      evidenceRoot,
    };
    writePageLocalPendingTerminal(args, "a".repeat(40), {
      ok: false,
      code: "browser_effect_uncertain",
      failure: {
        code: "browser_effect_uncertain",
        retryable: false,
        owner: "browser_truth",
        classifier: "workday_page",
        primitive: "page_observation",
        unknownLayer: "none",
        page: "profile",
        attempt: 1,
      },
    });
    const pending = JSON.parse(await readFile(
      join(evidenceRoot, "page-local-terminal-pending.json"),
      "utf8",
    ));
    await writeFile(join(evidenceRoot, "process-audit.json"), `${JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: "s2-windows-process-audit-v2",
      status: "pass",
      runKey: "run_20260901_abcdefghijklmnop",
      journeyId: pending.journeyId,
      targetHandleId: pending.targetHandleId,
      configSha256: pending.configSha256,
      processLiveNonceSha256: "b".repeat(64),
      processIssuedAt: "2026-09-01T00:00:00.000Z",
      processOwnerPid: 42,
      processOwnerStartedAt: "2026-09-01T00:00:01.000Z",
      processExitObservedAt: "2026-09-01T00:00:02.000Z",
      jobCloseApplied: true,
      membersObservedBeforeClose: 3,
      membersAliveAfterClose: 0,
      monitorFileCount: 2,
      monitorChainSha256: "c".repeat(64),
      checkedAt: "2026-09-01T00:00:03.000Z",
    })}\n`);
    sealPageLocalTerminal(args, 1);
    const terminal = JSON.parse(await readFile(
      join(evidenceRoot, "page-local-terminal.json"),
      "utf8",
    ));
    assert.deepEqual({
      revision: terminal.evidenceRevision,
      status: terminal.status,
      code: terminal.resultCode,
      cleanup: terminal.processCleanup,
      privacy: terminal.privacyScan,
      submit: terminal.submitActivated,
    }, {
      revision: "s2-page-local-terminal-v1",
      status: "blocked",
      code: "browser_effect_uncertain",
      cleanup: "pass",
      privacy: "pass",
      submit: false,
    });
    assert.match(terminal.pendingTerminalSha256, /^[0-9a-f]{64}$/u);
    assert.match(terminal.processAuditSha256, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
