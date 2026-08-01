import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkdayPageType } from "../../../../src/contracts/live/index.ts";
import {
  LIVE_ENTRY_CLASSIFICATION_REVISION_ID,
  LIVE_ENTRY_TRAITS,
  classifyLiveAccountState,
} from "../../../../src/ats/workday/live/index.ts";

test("account entry, verification, and application pages map to exact read-only states", () => {
  const cases: ReadonlyArray<readonly [WorkdayPageType, readonly string[], string]> = [
    ["account_entry", [LIVE_ENTRY_TRAITS.account.signIn], "existing_account"],
    ["account_entry", [LIVE_ENTRY_TRAITS.account.create], "create_account"],
    ["email_verification", [LIVE_ENTRY_TRAITS.neutral], "verification_required"],
    ["candidate_home", [LIVE_ENTRY_TRAITS.neutral], "application_ready"],
    ["profile", [LIVE_ENTRY_TRAITS.neutral], "application_ready"],
    ["questionnaire", [LIVE_ENTRY_TRAITS.neutral], "application_ready"],
    ["review", [LIVE_ENTRY_TRAITS.neutral], "application_ready"],
    ["job_posting", [LIVE_ENTRY_TRAITS.neutral], "account_state_unknown"],
  ];
  for (const [pageType, traitIds, expected] of cases) {
    const state = classifyLiveAccountState(pageType, traitIds);
    assert.equal(state.kind, expected, pageType);
    assert.equal(state.sourceRevisionId, LIVE_ENTRY_CLASSIFICATION_REVISION_ID);
    assert.match(state.classificationId, /^classification_[A-Za-z0-9_-]{16,64}$/u);
  }
});

test("challenge facts override account-page inference and preserve exact reasons", () => {
  for (const [reason, traitId] of Object.entries(LIVE_ENTRY_TRAITS.challenge)) {
    const state = classifyLiveAccountState("account_entry", [
      LIVE_ENTRY_TRAITS.account.signIn,
      traitId,
    ]);
    assert.deepEqual(state.kind === "manual_intervention"
      ? { kind: state.kind, reason: state.reason }
      : state, {
      kind: "manual_intervention",
      reason: reason === "accessControl" ? "access_control" : reason,
    });
    assert.match(state.classificationId, /^classification_[A-Za-z0-9_-]{16,64}$/u);
  }
});

test("conflicting account or challenge structures are factual ambiguity", () => {
  assert.equal(classifyLiveAccountState("account_entry", [
    LIVE_ENTRY_TRAITS.account.signIn,
    LIVE_ENTRY_TRAITS.account.create,
  ]).kind, "account_state_ambiguous");
  assert.equal(classifyLiveAccountState("profile", [
    LIVE_ENTRY_TRAITS.challenge.captcha,
    LIVE_ENTRY_TRAITS.challenge.mfa,
  ]).kind, "account_state_ambiguous");
});
