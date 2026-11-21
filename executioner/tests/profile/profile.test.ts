import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ContractParseError,
  upstreamProfileId,
  type ProfileQueryRequest,
} from "../../src/contracts/index.ts";
import {
  createProfileQuery,
  immutableApplicantProfile,
} from "../../src/profile/profile.ts";

const profile = {
  profileId: "profile-1",
  revision: 3,
  facts: [{
    factId: "given_name",
    value: "Ada",
    provenance: "owner_provided",
  }],
} as const;

test("profile admission copies, freezes, and rejects duplicates and credentials", () => {
  const mutable = structuredClone(profile);
  const admitted = immutableApplicantProfile(mutable);
  (mutable.facts[0] as { value: string }).value = "changed";

  assert.equal(admitted.facts[0]?.value, "Ada");
  assert.ok(Object.isFrozen(admitted));
  assert.ok(Object.isFrozen(admitted.facts));
  assert.ok(Object.isFrozen(admitted.facts[0]));
  assert.throws(
    () => immutableApplicantProfile({
      ...profile,
      facts: [profile.facts[0], profile.facts[0]],
    }),
    (error: unknown) =>
      error instanceof ContractParseError && error.code === "invalid_value",
  );
  assert.throws(
    () => immutableApplicantProfile({
      ...profile,
      facts: [{
        factId: "password",
        value: "never-store-this",
        provenance: "owner_provided",
      }],
    }),
    (error: unknown) =>
      error instanceof ContractParseError && error.code === "credential_forbidden",
  );
});

test("profile queries distinguish saved facts, missing facts, stale identity and cancellation", async () => {
  const query = createProfileQuery(profile);
  const signal = new AbortController().signal;
  const request = {
    profileId: upstreamProfileId("profile-1"),
    profileRevision: 3,
    factId: "given_name",
  } as const;

  assert.deepEqual(await query.query(request, signal), {
    ok: true,
    value: { kind: "answered", value: "Ada", provenance: "owner_provided" },
  });
  assert.deepEqual(await query.query({
    ...request, factId: "desired_salary",
  }, signal), {
    ok: true,
    value: { kind: "profile_answer_missing" },
  });

  assert.deepEqual(await query.query({
    ...request,
    profileId: upstreamProfileId("profile-missing"),
  }, signal), {
    ok: false,
    error: { code: "profile_missing", retryable: false },
  });
  assert.deepEqual(await query.query({
    ...request,
    profileRevision: 2,
  }, signal), {
    ok: false,
    error: { code: "profile_revision_mismatch", retryable: false },
  });
  assert.deepEqual(await query.query(request, AbortSignal.abort()), {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
});
