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

test("an exact email-provider choice is existing-account evidence only on account entry", () => {
  const emailChoice = "structural_trait_navigation_email_sign_in_choice_v1";

  assert.equal(
    classifyLiveAccountState("account_entry", [emailChoice]).kind,
    "existing_account",
  );
  assert.equal(
    classifyLiveAccountState("account_entry", [emailChoice, LIVE_ENTRY_TRAITS.account.create]).kind,
    "account_state_ambiguous",
  );
  assert.equal(
    classifyLiveAccountState("job_posting", [emailChoice]).kind,
    "account_state_unknown",
  );
  assert.equal(
    classifyLiveAccountState("email_verification", [emailChoice]).kind,
    "verification_required",
  );
  const challenge = classifyLiveAccountState("account_entry", [
    emailChoice,
    LIVE_ENTRY_TRAITS.challenge.captcha,
  ]);
  assert.deepEqual(
    challenge.kind === "manual_intervention"
      ? { kind: challenge.kind, reason: challenge.reason }
      : challenge,
    { kind: "manual_intervention", reason: "captcha" },
  );
});

test("exact account facts are retained without treating the page default as evidence", () => {
  const absent = classifyLiveAccountState("account_entry", [
    LIVE_ENTRY_TRAITS.account.signIn,
    LIVE_ENTRY_TRAITS.accountFact.absent,
  ]);
  const exists = classifyLiveAccountState("account_entry", [
    LIVE_ENTRY_TRAITS.account.create,
    LIVE_ENTRY_TRAITS.accountFact.exists,
  ]);
  const defaultCreate = classifyLiveAccountState("account_entry", [
    LIVE_ENTRY_TRAITS.account.create,
  ]);

  assert.equal(absent.kind, "existing_account");
  assert.equal(absent.kind === "existing_account" && absent.accountFact, "absent");
  assert.equal(exists.kind, "create_account");
  assert.equal(exists.kind === "create_account" && exists.accountFact, "exists");
  assert.equal(defaultCreate.kind === "create_account" && defaultCreate.accountFact, undefined);
});

test("password recovery traits map to exact lifecycle states", () => {
  const required = classifyLiveAccountState("account_entry", [
    LIVE_ENTRY_TRAITS.account.signIn,
    "structural_trait_account_password_reset_required_v1",
  ]);
  assert.equal(required.kind, "existing_account");
  assert.equal(required.kind === "existing_account" && required.accountFact,
    "password_reset_required");
  for (const [trait, expected] of [
    ["structural_trait_account_password_reset_request_v1", "password_reset_request"],
    ["structural_trait_account_password_reset_email_sent_v1", "password_reset_email_sent"],
    ["structural_trait_account_password_reset_set_v1", "password_reset_set"],
  ] as const) {
    assert.equal(classifyLiveAccountState("account_entry", [trait]).kind, expected);
  }
});

test("misplaced or conflicting account facts are ambiguity", () => {
  assert.equal(classifyLiveAccountState("account_entry", [
    LIVE_ENTRY_TRAITS.account.create,
    LIVE_ENTRY_TRAITS.accountFact.absent,
  ]).kind, "account_state_ambiguous");
  assert.equal(classifyLiveAccountState("account_entry", [
    LIVE_ENTRY_TRAITS.account.signIn,
    LIVE_ENTRY_TRAITS.accountFact.absent,
    LIVE_ENTRY_TRAITS.accountFact.exists,
  ]).kind, "account_state_ambiguous");
});
