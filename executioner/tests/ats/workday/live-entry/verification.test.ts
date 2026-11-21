import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  LiveSessionId,
  PersistentBrowserReconcileResult,
  TargetIdentityV1,
} from "../../../../src/contracts/live/index.ts";
import {
  LIVE_ENTRY_CLASSIFICATION_REVISION_ID,
  LIVE_ENTRY_TRAITS,
  createClassifiedAccountObservationSource,
  createLiveEntryVerifier,
} from "../../../../src/ats/workday/live/index.ts";
import type {
  LiveEntryStructuralInspection,
  LiveEntryStructuralSource,
  LiveEntryStructuralSnapshot,
} from "../../../../src/ats/workday/live/private/structural-source.ts";

const sessionId = "live_session_0123456789abcdef" as LiveSessionId;
const target = {
  schemaVersion: 1,
  atsFamily: "workday",
  hostId: "host_0123456789abcdef",
  tenantId: "tenant_0123456789abcdef",
  postingId: "posting_0123456789abcdef",
} as TargetIdentityV1;
const signal = new AbortController().signal;

test("exact target mismatch, ambiguity, and unavailable facts pass through unchanged", async () => {
  const facts = [
    { kind: "target_mismatch", dimension: "tenant" },
    { kind: "target_ambiguous" },
    { kind: "posting_unavailable", reason: "closed" },
  ] as const;
  for (const fact of facts) {
    const verifier = createLiveEntryVerifier(source([inspection(fact)]));
    const result = await verifier.inspectFresh({ schemaVersion: 1, sessionId, target }, signal);
    assert.deepEqual(result, { ok: true, value: fact });
  }
});

test("approved target ATS family is not classifier evidence", async () => {
  const verifier = createLiveEntryVerifier(source([
    inspection({ kind: "matched" }, snapshot([LIVE_ENTRY_TRAITS.neutral])),
  ]));
  const result = await verifier.inspectFresh({ schemaVersion: 1, sessionId, target }, signal);
  assert.equal(result.ok && result.value.kind, "ats_unknown");
  if (!result.ok || result.value.kind !== "ats_unknown") return;
  assert.equal(result.value.observation.sourceRevisionId, LIVE_ENTRY_CLASSIFICATION_REVISION_ID);
  assert.deepEqual(result.value.observation.parentLineage, []);
  assert.deepEqual(result.value.observation.traitIds, [LIVE_ENTRY_TRAITS.neutral]);
});

test("redirect reconciliation always performs a fresh structural inspection", async () => {
  const structural = source([
    inspection({ kind: "matched" }, snapshot([
      LIVE_ENTRY_TRAITS.ats.workday,
      LIVE_ENTRY_TRAITS.pages.account_entry,
      LIVE_ENTRY_TRAITS.account.signIn,
    ])),
    inspection({ kind: "matched" }, {
      ...snapshot([
        LIVE_ENTRY_TRAITS.ats.workday,
        LIVE_ENTRY_TRAITS.pages.email_verification,
      ]),
      snapshotId: "snapshot_fedcba9876543210" as never,
      documentGenerationId: "document_generation_fedcba9876543210" as never,
    }),
  ]);
  const verifier = createLiveEntryVerifier(structural);
  const first = await verifier.inspectFresh({ schemaVersion: 1, sessionId, target }, signal);
  const redirected = await verifier.inspectFresh({ schemaVersion: 1, sessionId, target }, signal);
  assert.equal(first.ok && first.value.kind === "classified_account" && first.value.state.kind, "existing_account");
  assert.equal(redirected.ok && redirected.value.kind === "classified_account" && redirected.value.state.kind, "verification_required");
  assert.equal(structural.calls(), 2);
});

test("T5-facing classification stops preserve facts without exposing candidate traits", async () => {
  const accountSource = createClassifiedAccountObservationSource(
    createLiveEntryVerifier(source([
      inspection({ kind: "matched" }, snapshot([
        LIVE_ENTRY_TRAITS.ats.workday,
        LIVE_ENTRY_TRAITS.neutral,
      ])),
    ])),
  );
  const result = await accountSource.inspectClassifiedAccount(
    { schemaVersion: 1, sessionId, target },
    signal,
  );
  assert.deepEqual(result.ok ? result.value : result, {
    kind: "classification_stopped",
    outcome: "workday_page_unknown",
    pageType: null,
    classificationId: null,
    sourceRevisionId: LIVE_ENTRY_CLASSIFICATION_REVISION_ID,
    snapshotId: "snapshot_0123456789abcdef",
    documentGenerationId: "document_generation_0123456789abcdef",
  });
  assert.equal(JSON.stringify(result).includes("trait"), false);
});

test("a classified posting preserves its page type for state-driven routing", async () => {
  const accountSource = createClassifiedAccountObservationSource(
    createLiveEntryVerifier(source([
      inspection({ kind: "matched" }, snapshot([
        LIVE_ENTRY_TRAITS.ats.workday,
        LIVE_ENTRY_TRAITS.pages.job_posting,
      ])),
    ])),
  );
  const result = await accountSource.inspectClassifiedAccount(
    { schemaVersion: 1, sessionId, target },
    signal,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.kind, "classification_stopped");
  if (result.value.kind !== "classification_stopped") return;
  assert.equal(result.value.outcome, "account_state_unknown");
  assert.equal(result.value.pageType, "job_posting");
  assert.equal(JSON.stringify(result).includes("trait"), false);
});

function snapshot(
  traitIds: readonly string[],
  extra: Record<string, unknown> = {},
): LiveEntryStructuralSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: "snapshot_0123456789abcdef" as never,
    documentGenerationId: "document_generation_0123456789abcdef" as never,
    traitIds: traitIds as never,
    controlCount: 2,
    requiredControlCount: 1,
    optionCount: 0,
    ...extra,
  } as LiveEntryStructuralSnapshot;
}

function inspection(
  targetFact: Exclude<PersistentBrowserReconcileResult, { kind: "matched" }> | { readonly kind: "matched" },
  structuralSnapshot = snapshot([LIVE_ENTRY_TRAITS.neutral]),
): { readonly ok: true; readonly value: LiveEntryStructuralInspection } {
  return targetFact.kind === "matched"
    ? { ok: true, value: { target: targetFact, snapshot: structuralSnapshot } }
    : { ok: true, value: { target: targetFact } };
}

function source(results: readonly ReturnType<typeof inspection>[]) {
  let index = 0;
  const structural: LiveEntryStructuralSource & { calls(): number } = {
    async inspectFresh() {
      const result = results[index++];
      if (result === undefined) throw new Error("unexpected inspection");
      return result;
    },
    calls: () => index,
  };
  return structural;
}
