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

test("known Workday structure produces a classified account observation", async () => {
  const verifier = createLiveEntryVerifier(source([
    inspection({ kind: "matched" }, snapshot([
      LIVE_ENTRY_TRAITS.ats.workday,
      LIVE_ENTRY_TRAITS.pages.account_entry,
      LIVE_ENTRY_TRAITS.account.create,
    ])),
  ]));
  const result = await verifier.inspectFresh({ schemaVersion: 1, sessionId, target }, signal);
  assert.equal(result.ok && result.value.kind, "classified_account");
  if (!result.ok || result.value.kind !== "classified_account") return;
  assert.equal(result.value.pageType, "account_entry");
  assert.equal(result.value.state.kind, "create_account");
  assert.equal(result.value.snapshotId, "snapshot_0123456789abcdef");
  assert.equal(result.value.documentGenerationId, "document_generation_0123456789abcdef");
  assert.equal(result.value.sourceRevisionId, LIVE_ENTRY_CLASSIFICATION_REVISION_ID);
  assert.match(result.value.classificationId, /^classification_/u);
});

test("standalone email provider choice composes through page and account classification", async () => {
  const verifier = createLiveEntryVerifier(source([
    inspection({ kind: "matched" }, snapshot([
      LIVE_ENTRY_TRAITS.ats.workday,
      LIVE_ENTRY_TRAITS.pages.account_entry,
      "structural_trait_navigation_email_sign_in_choice_v1",
    ])),
  ]));
  const result = await verifier.inspectFresh({ schemaVersion: 1, sessionId, target }, signal);

  assert.equal(result.ok && result.value.kind, "classified_account");
  if (!result.ok || result.value.kind !== "classified_account") return;
  assert.equal(result.value.pageType, "account_entry");
  assert.equal(result.value.state.kind, "existing_account");
});

test("page unknown keeps exact revision and ATS lineage in sanitized evidence", async () => {
  const verifier = createLiveEntryVerifier(source([
    inspection({ kind: "matched" }, snapshot([
      LIVE_ENTRY_TRAITS.ats.workday,
      LIVE_ENTRY_TRAITS.neutral,
    ], { rawText: "must not survive", href: "https://forbidden.invalid" })),
  ]));
  const result = await verifier.inspectFresh({ schemaVersion: 1, sessionId, target }, signal);
  assert.equal(result.ok && result.value.kind, "workday_page_unknown");
  if (!result.ok || result.value.kind !== "workday_page_unknown") return;
  assert.equal(result.value.observation.sourceRevisionId, LIVE_ENTRY_CLASSIFICATION_REVISION_ID);
  assert.equal(result.value.observation.parentLineage.length, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("must not survive"), false);
  assert.equal(serialized.includes("forbidden.invalid"), false);
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

test("T5-facing classified-account seam is value-free and exposes no structural traits", async () => {
  const verifier = createLiveEntryVerifier(source([
    inspection({ kind: "matched" }, snapshot([
      LIVE_ENTRY_TRAITS.ats.workday,
      LIVE_ENTRY_TRAITS.pages.profile,
    ])),
  ]));
  const accountSource = createClassifiedAccountObservationSource(verifier);
  const result = await accountSource.inspectClassifiedAccount(
    { schemaVersion: 1, sessionId, target },
    signal,
  );
  assert.equal(result.ok && result.value.kind, "classified_account");
  if (!result.ok || result.value.kind !== "classified_account") return;
  assert.equal(result.value.state.kind, "application_ready");
  assert.deepEqual(Object.keys(result.value).sort(), [
    "classificationId",
    "documentGenerationId",
    "kind",
    "snapshotId",
    "sourceRevisionId",
    "state",
  ]);
  assert.equal(JSON.stringify(result).includes("trait"), false);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.state), true);
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
    classificationId: null,
    sourceRevisionId: LIVE_ENTRY_CLASSIFICATION_REVISION_ID,
    snapshotId: "snapshot_0123456789abcdef",
    documentGenerationId: "document_generation_0123456789abcdef",
  });
  assert.equal(JSON.stringify(result).includes("trait"), false);
});

test("cancellation stops before classification and retains no structural result", async () => {
  let calls = 0;
  const structural: LiveEntryStructuralSource = {
    async inspectFresh() {
      calls += 1;
      return inspection({ kind: "matched" }, snapshot([LIVE_ENTRY_TRAITS.ats.workday]));
    },
  };
  const controller = new AbortController();
  controller.abort();
  const result = await createLiveEntryVerifier(structural).inspectFresh(
    { schemaVersion: 1, sessionId, target },
    controller.signal,
  );
  assert.equal(calls, 0);
  assert.deepEqual(result, {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.equal(JSON.stringify(result).includes("structural_trait"), false);
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
