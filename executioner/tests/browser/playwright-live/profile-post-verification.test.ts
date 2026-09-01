import assert from "node:assert/strict";
import test from "node:test";

import {
  completeProfilePostVerification,
  profilePostVerificationPhases,
  type ProfilePostVerificationPhase,
  type ProfilePostVerificationTrace,
} from "../../../src/browser/playwright-live/private/profile-post-verification.ts";

test("Profile post-verification records the exact successful phase order", async () => {
  const actions: string[] = [];
  const traces: ProfilePostVerificationTrace[] = [];
  await completeProfilePostVerification({
    recordAcceptance: () => { actions.push("acceptance"); },
    recordPendingOwnerLearning: () => { actions.push("pending_owner_learning"); },
    recordReviewExpectations: () => { actions.push("review_expectations"); },
    verifyStablePage: async () => { actions.push("stable_page"); return true; },
    assertAuthorized: () => { actions.push("authorization"); },
    trace: (_event, details) => traces.push(details),
  });
  assert.deepEqual(actions, profilePostVerificationPhases);
  assert.deepEqual(
    traces.filter(({ status }) => status === "completed").map(({ phase }) => phase),
    profilePostVerificationPhases,
  );
});

for (const failedPhase of profilePostVerificationPhases) {
  test(`Profile post-verification preserves the earliest ${failedPhase} failure`, async () => {
    const earliest = new Error(`failure-${failedPhase}`);
    const actions: ProfilePostVerificationPhase[] = [];
    const traces: ProfilePostVerificationTrace[] = [];
    const run = (phase: ProfilePostVerificationPhase) => {
      actions.push(phase);
      if (phase === failedPhase) throw earliest;
    };
    await assert.rejects(completeProfilePostVerification({
      recordAcceptance: () => run("acceptance"),
      recordPendingOwnerLearning: () => run("pending_owner_learning"),
      recordReviewExpectations: () => run("review_expectations"),
      verifyStablePage: async () => { run("stable_page"); return true; },
      assertAuthorized: () => run("authorization"),
      trace: (_event, details) => traces.push(details),
    }), (error) => error === earliest);
    const failedIndex = profilePostVerificationPhases.indexOf(failedPhase);
    assert.deepEqual(actions, profilePostVerificationPhases.slice(0, failedIndex + 1));
    assert.deepEqual(traces.at(-1), {
      phase: failedPhase,
      status: "failed",
      failureName: "Error",
    });
  });
}

test("Profile post-verification treats a changed active page as the stable-page root", async () => {
  await assert.rejects(completeProfilePostVerification({
    recordAcceptance() {},
    recordPendingOwnerLearning() {},
    recordReviewExpectations() {},
    verifyStablePage: async () => false,
    assertAuthorized() { throw new Error("must not run"); },
  }), /profile reconciliation page drift denied/u);
});
