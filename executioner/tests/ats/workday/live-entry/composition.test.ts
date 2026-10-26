import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  LiveSessionId,
  TargetIdentityV1,
} from "../../../../src/contracts/live/index.ts";
import type { PlaywrightPersistentBrowserSession } from "../../../../src/browser/playwright-live/session.ts";
import { createPlaywrightLiveEntryStructuralSource } from "../../../../src/composition/s2-live-entry-source.ts";
import type { LiveEntryStructuralInspection } from "../../../../src/ats/workday/live/private/structural-source.ts";

const sessionId = "live_session_0123456789abcdef" as LiveSessionId;
const target = {
  schemaVersion: 1,
  atsFamily: "workday",
  hostId: "host_0123456789abcdef",
  tenantId: "tenant_0123456789abcdef",
  postingId: "posting_0123456789abcdef",
} as TargetIdentityV1;

test("composition structurally injects T2 owned inspection into the T3 source", async () => {
  const calls: unknown[][] = [];
  const browser = {
    async inspectOwnedTarget(...args: unknown[]) {
      calls.push(args);
      return {
        ok: true as const,
        value: {
          target: { kind: "matched" as const },
          snapshot: {
            schemaVersion: 1 as const,
            traitIds: ["structural_trait_ats_workday_family_v1"],
            controlCount: 1,
            requiredControlCount: 0,
            optionCount: 0,
            rawDocument: "must not cross composition",
          },
        },
      };
    },
  };
  const structural = createPlaywrightLiveEntryStructuralSource(browser);
  const signal = new AbortController().signal;
  const inspected = await structural.inspectFresh(
    { schemaVersion: 1, sessionId, target },
    signal,
  );
  assert.equal(inspected.ok, true);
  if (!inspected.ok) return;
  assert.equal(inspected.value.target.kind, "matched");
  if (inspected.value.target.kind !== "matched") return;
  if (!("snapshot" in inspected.value)) return;
  assert.deepEqual(calls[0], [sessionId, target, signal]);
  assert.match(inspected.value.snapshot.snapshotId, /^snapshot_[a-f0-9]{16}$/u);
  assert.match(inspected.value.snapshot.documentGenerationId, /^document_generation_[a-f0-9]{16}$/u);
  assert.deepEqual(inspected.value.snapshot.traitIds, ["structural_trait_ats_workday_family_v1"]);
  assert.equal(JSON.stringify(inspected).includes("must not cross composition"), false);
});

test("nonmatched target facts pass through without requiring structural evidence", async () => {
  const browser = {
    async inspectOwnedTarget() {
      return {
        ok: true as const,
        value: {
          target: { kind: "posting_unavailable" as const, reason: "removed" as const },
          snapshot: {
            schemaVersion: 1 as const,
            traitIds: ["structural_trait_neutral_entry_v1"],
            controlCount: 0,
            requiredControlCount: 0,
            optionCount: 0,
          },
        },
      };
    },
  };
  const structural = createPlaywrightLiveEntryStructuralSource(browser);
  const request = { schemaVersion: 1 as const, sessionId, target };
  const first = await structural.inspectFresh(request, new AbortController().signal);
  const second = await structural.inspectFresh(request, new AbortController().signal);
  assert.equal(first.ok && first.value.target.kind, "posting_unavailable");
  assert.equal(second.ok && second.value.target.kind, "posting_unavailable");
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.value, {
    target: { kind: "posting_unavailable", reason: "removed" },
  });
  assert.deepEqual(second.value, first.value);
});

test("the real T2 class capability is structurally assignable without importing its private types", () => {
  const compose = (browser: PlaywrightPersistentBrowserSession) =>
    createPlaywrightLiveEntryStructuralSource(browser);
  assert.equal(typeof compose, "function");
});

test("malformed T2 structural snapshots fail closed before T3 classification", async () => {
  const browser = {
    async inspectOwnedTarget() {
      return {
        ok: true as const,
        value: {
          target: { kind: "matched" as const },
          snapshot: {
            schemaVersion: 1 as const,
            traitIds: ["not-a-structural-trait"],
            controlCount: 65,
            requiredControlCount: 0,
            optionCount: 0,
          },
        },
      };
    },
  };
  const result = await createPlaywrightLiveEntryStructuralSource(browser).inspectFresh(
    { schemaVersion: 1, sessionId, target },
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_target_stale", retryable: false },
  });
});
