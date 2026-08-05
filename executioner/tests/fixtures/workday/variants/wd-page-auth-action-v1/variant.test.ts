import assert from "node:assert/strict";
import test from "node:test";

import { classifyLiveAccountState } from "../../../../../src/ats/workday/live/account-state.ts";
import { LIVE_ENTRY_TRAITS } from "../../../../../src/ats/workday/live/traits.ts";
import {
  inspectWorkdayStructure,
  type WorkdaySemanticAccountInspector,
} from "../../../../../src/browser/playwright-live/private/workday-structural-catalog.ts";
import { frozenVariantFixture } from "../private.ts";

const fixture = frozenVariantFixture("wd-page-auth-action-v1");
const exact = { cardinality: 1, actionable: true } as const;
const absent = { cardinality: 0, actionable: false } as const;

test("WD-PAGE-AUTH-ACTION-V1 preserves exact auth action and transition classification", async () => {
  assert.equal(fixture.semanticHash, "sha256.6b0479cb7eea3a5d0429e1368f8c7527bbb2256ec099056576f00d6eed09145c");
  assert.equal(fixture.provingSlots.length, 38);
  assert.equal(fixture.provingSlots.includes("WD40-009"), false);
  assert.equal(fixture.provingSlots.includes("WD40-021"), false);

  const account: WorkdaySemanticAccountInspector = {
    inspect: async (control) => new Set(["email", "password", "submit_sign_in", "show_create_account"]).has(control)
      ? exact
      : absent,
  };
  const page = {
    locator: (selector: string) => ({
      count: async () => selector === '[data-automation-id="noCaptchaWrapper"]' ? 1 : 0,
      isVisible: async () => true,
    }),
  };
  const inspected = await inspectWorkdayStructure(page, false, account);
  assert.equal(inspected.kind, "snapshot");
  if (inspected.kind !== "snapshot") throw new Error("auth fixture did not produce a snapshot");
  assert.equal(inspected.snapshot.traitIds.includes(LIVE_ENTRY_TRAITS.challenge.captcha), false);
  assert.equal(classifyLiveAccountState("account_entry", inspected.snapshot.traitIds).kind, "existing_account");
  assert.equal(classifyLiveAccountState("email_verification", []).kind, "verification_required");
  assert.equal(classifyLiveAccountState("profile", []).kind, "application_ready");
});
