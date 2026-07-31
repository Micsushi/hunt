import assert from "node:assert/strict";
import test from "node:test";

import {
  providerError,
  stableErrorPolicy,
  upstreamProfileId,
  type ProfileQueryRequest,
} from "../../src/contracts/index.ts";
import { contractFixtures } from "../../src/testing/contracts/fixtures.ts";

if (false) {
  const invalidState: import("../../src/contracts/index.ts").DurableJourneyState = {
    schemaVersion: 3,
    journeyId: contractFixtures.journeyState.journeyId,
    status: "running",
    // @ts-expect-error durable pages retain a branded browser page ID
    pageId: "raw-page",
    revision: 1,
  };
  void invalidState;
  const invalidSafety: import("../../src/contracts/index.ts").SafetyAdmissionRequest = {
    binding: {
      journeyId: contractFixtures.safetyAdmission.journeyId,
      attemptId: contractFixtures.safetyAdmission.attemptId,
      guardRevision: contractFixtures.safetyAdmission.guardRevision,
    },
    // @ts-expect-error safety policy revisions retain the guard revision brand
    policyRevision: "raw-revision",
    capability: "field_mutation",
    input: contractFixtures.safetyAdmission.snapshot,
  };
  void invalidSafety;
}

test("malformed profile queries and unavailable bootstrap persistence are distinct", () => {
  const request: ProfileQueryRequest = {
    profileId: upstreamProfileId("profile-1"),
    profileRevision: 1,
    factId: "given_name",
  };
  assert.equal(request.profileId, "profile-1");
  assert.deepEqual(providerError("profile_query_invalid"), {
    code: "profile_query_invalid",
    retryable: false,
  });
  assert.deepEqual(providerError("journey_persistence_unavailable"), {
    code: "journey_persistence_unavailable",
    retryable: true,
  });
  assert.deepEqual(stableErrorPolicy.journey_persistence_unavailable, {
    owner: "F4",
    retryable: true,
  });
});
