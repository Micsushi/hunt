import assert from "node:assert/strict";
import { test } from "node:test";

import {
  upstreamProfileId,
} from "../../src/contracts/index.ts";
import {
  applicationProfileFactIds,
  parseApplicationProfile,
  type ApplicationProfile,
} from "../../src/profile/application-profile.ts";
import { migrateLegacyV2ProfileFixture } from
  "../../src/testing/contracts/legacy-profile.ts";
import { retainedDiscoveredIntakeFields } from
  "../../src/form/questions/catalog.ts";

type ProfileFactId = ApplicationProfile["facts"][number]["factId"];

test("ApplicantProfile has a closed credential-free fact catalog", () => {
  const profile = {
    profileId: upstreamProfileId("profile-1"),
    revision: 1,
    facts: [
      {
        factId: "work_authorization",
        value: true,
        provenance: "owner_provided",
        lane: "live_owner_fact",
      },
      {
        factId: "years_experience",
        value: 5,
        provenance: "resume_verified",
        lane: "live_owner_fact",
      },
      {
        factId: "email_address",
        value: "applicant@example.invalid",
        provenance: "owner_provided",
        lane: "live_owner_fact",
      },
    ],
    unsetFactIds: applicationProfileFactIds.filter((factId) =>
      !new Set(["work_authorization", "years_experience", "email_address"])
        .has(factId)
    ),
    discoveredFields: [],
  } as const satisfies ApplicationProfile;

  assert.deepEqual(parseApplicationProfile(profile), profile);
  assert.ok(applicationProfileFactIds.includes("work_authorization"));

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
        parseApplicationProfile({
          profileId: "profile-1",
          revision: 1,
          facts: [
            {
              factId,
              value: "forbidden",
              provenance: "owner_provided",
              lane: "live_owner_fact",
            },
          ],
          unsetFactIds: applicationProfileFactIds,
          discoveredFields: [],
        }),
      TypeError,
    );
  }
});

test("legacy V2 profile facts are test-only synthetic knowledge, never live applicant facts", () => {
  const legacy = {
    profileId: "profile-legacy-v2",
    revision: 2,
    facts: [{
      factId: "previously_worked_for_organization",
      value: false,
      provenance: "owner_provided",
    }],
  } as const;
  assert.throws(() => parseApplicationProfile(legacy), TypeError);

  const migrated = migrateLegacyV2ProfileFixture(legacy);
  assert.equal(migrated.mode, "synthetic_test_non_submittable");
  assert.equal(migrated.submittable, false);
  assert.deepEqual(migrated.facts.map(({ lane }) => lane), ["synthetic_test_default"]);
  assert.equal(migrated.unsetFactIds.includes("previously_worked_for_organization"), false);
  assert.equal(migrated.discoveredFields.length, 0);
  assert.throws(() => parseApplicationProfile(migrated));
});

test("discovered intake controls round-trip as explicit unset with editable options", () => {
  const discoveredFields = [
    discovered("voluntary-veteran", "select", "single_select", true, []),
    discovered("voluntary-consent", "checkbox", "boolean", true, ["Yes", "No"]),
    discovered("self-disability", "radio", "single_select", true, [
      "Yes, disability/history", "No disability/history", "Decline",
    ]),
    discovered("self-unknown-adjacent", "text", "text", null, []),
    discovered("resume-skills", "search_select", "multi_select", false, []),
    discovered("resume-file", "file_upload", "file", false, []),
    discovered("resume-experience", "repeatable", "repeatable", false, []),
  ] as const;
  const profile = {
    profileId: upstreamProfileId("profile-discovered-controls"),
    revision: 1,
    facts: [],
    unsetFactIds: applicationProfileFactIds,
    discoveredFields,
  } as const satisfies ApplicationProfile;
  assert.deepEqual(parseApplicationProfile(profile), profile);

  const invalid = structuredClone(profile) as Record<string, any>;
  invalid.discoveredFields[0].answer = { kind: "answered" };
  assert.throws(() => parseApplicationProfile(invalid));
  delete invalid.discoveredFields[0].allowedOptions;
  assert.throws(() => parseApplicationProfile(invalid));
});

test("retained Profile, Questionnaire, disclosure, Self Identify, and Resume controls are current profile data", () => {
  const discoveredFields = retainedDiscoveredIntakeFields();
  const profile = {
    profileId: upstreamProfileId("profile-retained-controls"),
    revision: 1,
    facts: [],
    unsetFactIds: applicationProfileFactIds,
    discoveredFields,
  } as const satisfies ApplicationProfile;
  assert.deepEqual(parseApplicationProfile(profile), profile);
  assert.equal(discoveredFields.some(({ identity }) => identity === "identity.middle_name"), true);
  assert.equal(discoveredFields.some(({ identity }) => identity === "phone.extension"), true);
  assert.equal(discoveredFields.some(({ sanitizedLabel }) =>
    sanitizedLabel === "Upload a file (5MB max)"
  ), true);
  assert.equal(discoveredFields.filter(({ identity }) => identity === "unresolved").length, 1);
});

function discovered(
  discoveredFieldId: string,
  behavior: ApplicationProfile["discoveredFields"][number]["behavior"],
  answerType: ApplicationProfile["discoveredFields"][number]["answerType"],
  required: boolean | null,
  allowedOptions: readonly string[],
) {
  return {
    discoveredFieldId,
    page: "self_identify" as const,
    identity: "unresolved" as const,
    sanitizedLabel: null,
    normalizedQuestionType: "unknown" as const,
    behavior,
    answerType,
    uiVariant: behavior === "file_upload"
      ? "workday_resume_file_upload_v1"
      : behavior === "repeatable"
        ? "workday_repeatable_v1"
        : "workday_unknown_v1",
    required,
    allowedOptions,
    allowsCustomValue: answerType === "text" || answerType === "date",
    constraints: { maxBytes: null, displayFormat: null },
    answer: { kind: "profile_answer_missing" as const },
  };
}
