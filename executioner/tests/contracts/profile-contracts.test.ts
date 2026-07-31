import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ApplicantProfile,
  ContractParseError,
  parseApplicantProfile,
  profileFactIds,
  upstreamProfileId,
} from "../../src/contracts/index.ts";

type ProfileFactId = ApplicantProfile["facts"][number]["factId"];

test("ApplicantProfile has a closed credential-free fact catalog", () => {
  const profile = {
    profileId: upstreamProfileId("profile-1"),
    revision: 1,
    facts: [
      {
        factId: "work_authorization",
        value: true,
        provenance: "owner_provided",
      },
      {
        factId: "years_experience",
        value: 5,
        provenance: "resume_verified",
      },
      {
        factId: "email_address",
        value: "applicant@example.invalid",
        provenance: "owner_provided",
      },
    ],
  } as const satisfies ApplicantProfile;

  assert.deepEqual(parseApplicantProfile(profile), profile);
  assert.ok(profileFactIds.includes("work_authorization"));

  // @ts-expect-error credentials are not representable profile fact IDs
  const credentialFact: ProfileFactId = "password";
  assert.equal(credentialFact, "password");
});

test("credential aliases receive one stable denial code", () => {
  for (const factId of [
    "password",
    "privateKey",
    "apiKey",
    "accessToken",
    "refreshToken",
    "bearerToken",
    "authToken",
    "sessionCookie",
    "authorizationHeader",
    "clientSecret",
  ]) {
    assert.throws(
      () =>
        parseApplicantProfile({
          profileId: "profile-1",
          revision: 1,
          facts: [
            {
              factId,
              value: "forbidden",
              provenance: "owner_provided",
            },
          ],
        }),
      (error: unknown) =>
        error instanceof ContractParseError &&
        error.code === "credential_forbidden",
    );
  }
});
