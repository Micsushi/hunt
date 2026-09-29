import assert from "node:assert/strict";
import { test } from "node:test";

import { importJobFillBackup } from "../../src/profile/job-fill-import.ts";

const backup = {
  version: 2,
  format: "job_app_filler_db",
  records: [
    { id: 1, section: "", fieldType: "TextInput", fieldName: "First Name", answer: "Ada", matchRule: "exact" },
    { id: 2, section: "", fieldType: "TextInput", fieldName: "Email Address", answer: "synthetic@example.invalid" },
    { id: 3, section: "", fieldType: "SimpleDropdown", fieldName: "Work Authorization", answer: ["Yes"] },
    { id: 4, section: "", fieldType: "TextInput", fieldName: "Years of Experience", answer: "2 years" },
    { id: 5, section: "", fieldType: "TextInput", fieldName: "First Name", answer: "Ada" },
    { id: 6, section: "education 1", fieldType: "TextInput", fieldName: "School", answer: "Example U", matchRule: "keywords", keywords: ["school", "university"] },
  ],
  documents: {
    resume: {
      name: "resume.pdf", size: 3, type: "application/pdf",
      body: "data:application/pdf;base64,YWJj", lastModified: 1,
    },
  },
};

test("Job Fill v2 imports strict facts, documents, rules, and confirmation state", () => {
  const result = importJobFillBackup(backup, {
    profileId: "owner-profile",
    revision: 4,
    confirmedDefaultFactIds: ["age_requirement_met", "sponsorship_required"],
  });

  assert.deepEqual(result.profile.facts.map(({ factId, value, provenance, lane }) => ({ factId, value, provenance, lane })), [
    { factId: "given_name", value: "Ada", provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "email_address", value: "synthetic@example.invalid", provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "work_authorization", value: true, provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "sponsorship_required", value: false, provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "age_requirement_met", value: true, provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "years_experience", value: 2, provenance: "owner_provided", lane: "live_owner_fact" },
  ]);
  assert.equal(result.documents[0]?.name, "resume.pdf");
  assert.equal(Buffer.from(result.documents[0]!.bytes).toString("utf8"), "abc");
  assert.equal(result.unresolved[0]?.fieldName, "School");
  assert.deepEqual(result.unresolved[0]?.matching, { matchRule: "keywords", keywords: ["school", "university"] });
  assert.equal(result.defaultsAwaitingConfirmation.includes("current_associate"), true);
  assert.equal(result.defaultsAwaitingConfirmation.includes("age_requirement_met"), false);
  assert.equal(result.replacementLedger.some(({ action }) => action === "duplicate_same"), true);
});

test("conflicting saved answers stay unresolved and never overwrite the first fact", () => {
  const result = importJobFillBackup({
    version: 1,
    raw: { store: [
      [1, { id: 1, section: "", fieldType: "TextInput", fieldName: "City", answer: "Calgary" }],
      [2, { id: 2, section: "", fieldType: "TextInput", fieldName: "City", answer: "Edmonton" }],
    ] },
  }, { profileId: "owner-profile", revision: 1 });

  assert.equal(result.profile.facts.find(({ factId }) => factId === "city")?.value, "Calgary");
  assert.equal(result.unresolved[0]?.reason, "conflicting_values");
  assert.equal(result.replacementLedger.at(-1)?.action, "conflict_review");
});

test("scoped saved answers cannot become global applicant facts", () => {
  const result = importJobFillBackup({ records: [
    { id: 1, fieldName: "City", section: "education 1", answer: "Toronto" },
    { id: 2, fieldName: "Work Authorization", questionCountry: "United States", answer: "Yes" },
    { id: 3, fieldName: "City", section: "", answer: "Calgary" },
  ] }, { profileId: "owner-profile", revision: 1 });
  assert.equal(result.profile.facts.find(({ factId }) => factId === "city")?.value, "Calgary");
  assert.equal(result.profile.facts.some(({ factId }) => factId === "work_authorization"), false);
  assert.deepEqual(result.unresolved.map(({ reason }) => reason), ["scoped_record", "scoped_record"]);
  assert.equal(result.unresolved[1]?.matching.questionCountry, "United States");
});
