import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseApplicantProfile } from "../../src/contracts/index.ts";
import {
  migrateTrustedLegacyApplicationProfile,
  parseStage2RunPreparationArgs,
  runStage2RunPreparationCli,
} from "../../src/composition/s2-run-preparation-cli.ts";
import { withDerivedProfileCountry } from
  "../../src/composition/private/s2-derived-profile-country.ts";
import {
  applicationProfileFactIds as profileFactIds,
  parseApplicationProfile,
} from "../../src/profile/application-profile.ts";

const storageRoot = resolve("C:\\protected\\hunt-c3-storage");
const targetUrl = "https://blackrock.wd1.myworkdayjobs.com/en-US/Careers/job/Test_R265422";

test("run preparation CLI accepts only the storage root, exact target, and account mode", () => {
  assert.deepEqual(parseStage2RunPreparationArgs([
    "--storage-root", storageRoot,
    "--target-url", targetUrl,
    "--account-mode", "sign_in",
  ]), { storageRoot, targetUrl, accountMode: "sign_in" });
});

test("trusted legacy preparation preserves only owner-bound resume facts and makes every other control unset", () => {
  const legacy = {
    schemaVersion: 1,
    sourceRevision: "s2-application-owner-profile-input-v1",
    resumeId: "resume-trusted-legacy",
    profile: {
      profileId: "profile-trusted-legacy",
      revision: 99,
      facts: [
        ...["given_name", "family_name", "email_address", "city", "region"].map(
          (factId) => ({ factId, value: `synthetic-${factId}`, provenance: "resume_verified" }),
        ),
        { factId: "address_line_1", value: "generated address", provenance: "generated_default" },
        { factId: "phone_number", value: "generated phone", provenance: "generated_default" },
        { factId: "source", value: "generated source", provenance: "generated_default" },
        { factId: "previously_worked_for_organization", value: "No", provenance: "generated_default" },
      ],
    },
    profilePlan: {
      pageType: "profile",
      fields: [{
        fieldId: "employment.previously_worked_for_organization",
        answer: { value: "No", provenance: "generated_default" },
      }],
    },
    narrative: { revision: "legacy-generated-plan" },
  };

  assert.throws(() => parseApplicantProfile(legacy.profile));
  const current = migrateTrustedLegacyApplicationProfile(legacy);
  assert.doesNotThrow(() => parseApplicationProfile(current.profile));
  assert.deepEqual(current.profile.facts.map(({ factId, lane }) => ({ factId, lane })),
    ["given_name", "family_name", "email_address", "city", "region"].map((factId) => ({
      factId,
      lane: "live_owner_fact",
    })));
  assert.equal(current.profile.unsetFactIds.length, profileFactIds.length - 5);
  assert.equal(current.profile.discoveredFields.length, 46);
  assert.equal(current.profile.discoveredFields.every(({ answer }) =>
    answer.kind === "profile_answer_missing"
  ), true);
  assert.equal(JSON.stringify(current).includes("generated_default"), false);
  assert.equal(JSON.stringify(current).includes("previously_worked_for_organization"), true);
  assert.deepEqual(current.executionPolicy, {
    browserTransport: "live_browser",
    answerFallbackPolicy: "deterministic_site_valid_editable",
    submissionPolicy: "forbidden",
    liveProofEligibility: "eligible",
  });
  assert.equal(
    (current.profilePlan as { mode: string }).mode,
    "synthetic_test_non_submittable",
  );
  assert.equal((current.profilePlan as { fields: Array<{ fieldId: string }> }).fields.some(
    ({ fieldId }) => fieldId === "employment.previously_worked_for_organization"
  ), false);
  assert.deepEqual(current.narrative, { revision: "trusted-legacy-owner-facts-only-v1" });

  const legacyPath = resolve("C:\\protected\\trusted-legacy.json");
  const resumePath = resolve("C:\\protected\\trusted-resume.pdf");
  assert.deepEqual(parseStage2RunPreparationArgs([
    "--storage-root", storageRoot,
    "--target-url", targetUrl,
    "--account-mode", "sign_in",
    "--trusted-legacy-application-profile", legacyPath,
    "--application-resume", resumePath,
  ]), {
    storageRoot,
    targetUrl,
    accountMode: "sign_in",
    trustedLegacyApplicationProfilePath: legacyPath,
    applicationResumePath: resumePath,
  });
});

test("run preparation CLI captures protected source paths without raw values on argv", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-prepare-cli-"));
  const storageRoot = join(root, "storage");
  const profilePath = join(root, "owner-profile.json");
  const resumePath = join(root, "owner-resume.pdf");
  const resume = Buffer.from("%PDF-1.7\nsynthetic owner resume\n");
  try {
    writeFileSync(profilePath, JSON.stringify({
      schemaVersion: 1,
      sourceRevision: "s2-application-owner-profile-input-v1",
      resumeId: "resume-owner-approved",
      profile: {
        profileId: "profile-owner-approved",
        revision: 1,
        facts: [
          { factId: "given_name", value: "Synthetic", provenance: "owner_provided", lane: "live_owner_fact" },
          { factId: "email_address", value: "synthetic@example.invalid", provenance: "owner_provided", lane: "live_owner_fact" },
          { factId: "city", value: "Calgary", provenance: "resume_verified", lane: "live_owner_fact" },
          { factId: "region", value: "Alberta", provenance: "owner_provided", lane: "live_owner_fact" },
          { factId: "configured_narrative", value: "Synthetic narrative.", provenance: "configured_template", lane: "live_owner_fact" },
        ],
        unsetFactIds: profileFactIds.filter((factId) =>
          !new Set(["given_name", "email_address", "city", "region", "configured_narrative"])
            .has(factId)
        ),
        discoveredFields: [],
      },
      profilePlan: {
        mode: "live",
        pageType: "profile",
fields: [{
          fieldId: "identity.given_name",
          questionType: "identity",
          answerType: "text",
          answer: { kind: "answered", value: "Synthetic", provenance: "owner_provided", lane: "live_owner_fact" },
        }],
        repeatables: [],
      },
      narrative: { revision: "narrative-owner-approved" },
    }));
    writeFileSync(resumePath, resume);
    const prepared = await runStage2RunPreparationCli([
      "--storage-root", storageRoot,
      "--target-url", targetUrl,
      "--account-mode", "sign_in",
      "--application-profile", profilePath,
      "--application-resume", resumePath,
    ], { protect: async () => undefined });

    assert.equal(existsSync(join(prepared.runtimeRoot, "application-profile.json")), true);
    assert.equal(existsSync(join(prepared.runtimeRoot, "application-resume.pdf")), true);
    const captured = JSON.parse(readFileSync(
      join(prepared.runtimeRoot, "application-profile.json"),
      "utf8",
    ));
    assert.deepEqual(captured.profilePlan.fields[0].allowedOptions, []);
    assert.deepEqual(captured.profilePlan.fields[1], {
      fieldId: "address.country",
      questionType: "address",
      answerType: "option",
      allowedOptions: ["Canada"],
      answer: { kind: "answered", value: "CA", provenance: "journey_derived", lane: "live_owner_fact" },
      optionMapping: {
        canonicalValue: "CA",
        visibleOption: "Canada",
        provenance: "visible_option",
      },
    });
    assert.deepEqual(captured.profilePlan.fields.slice(2, 5), [
      {
        fieldId: "contact.email",
        questionType: "identity",
        answerType: "text",
        allowedOptions: [],
        answer: {
          kind: "answered",
          value: "synthetic@example.invalid",
          provenance: "owner_provided",
          lane: "live_owner_fact",
        },
      },
      {
        fieldId: "address.city",
        questionType: "address",
        answerType: "text",
        allowedOptions: [],
        answer: {
          kind: "answered",
          value: "Calgary",
          provenance: "resume_verified",
          lane: "live_owner_fact",
        },
      },
      {
        fieldId: "address.region",
        questionType: "address",
        answerType: "option",
        allowedOptions: ["Alberta"],
        answer: {
          kind: "answered",
          value: "Alberta",
          provenance: "owner_provided",
          lane: "live_owner_fact",
        },
        optionMapping: {
          canonicalValue: "Alberta",
          visibleOption: "Alberta",
          provenance: "visible_option",
        },
      },
    ]);
    const generated = captured.profilePlan.fields.filter(
      (field: { answer: { provenance?: string } }) =>
        field.answer.provenance === "generated_default",
    );
    assert.deepEqual(generated, []);
    assert.equal(createHash("sha256").update(resume).digest("hex").length, 64);
  } finally {
    resume.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile fact projection preserves planned fields and leaves missing facts unresolved", () => {
  const plan = {
    mode: "live",
    pageType: "profile",
fields: [{
      fieldId: "contact.email",
      questionType: "identity",
      answerType: "text",
      allowedOptions: [],
      answer: { kind: "answered", value: "planned@example.invalid", provenance: "owner_provided", lane: "live_owner_fact" },
    }],
    repeatables: [],
  };

  const projected = withDerivedProfileCountry({
    facts: [
      { factId: "email_address", value: "fact@example.invalid", provenance: "owner_provided", lane: "live_owner_fact" },
      { factId: "city", value: "Edmonton", provenance: "configured_template", lane: "live_owner_fact" },
    ],
  }, plan) as typeof plan;

  assert.deepEqual(projected.fields, [
    plan.fields[0],
    {
      fieldId: "address.city",
      questionType: "address",
      answerType: "text",
      allowedOptions: [],
      answer: {
        kind: "answered",
        value: "Edmonton",
        provenance: "configured_template",
        lane: "live_owner_fact",
      },
    },
  ]);
  assert.equal(projected.fields.some(({ fieldId }) => fieldId === "address.region"), false);
});

test("profile fact projection maps a Canadian region code to its exact visible option", () => {
  const projected = withDerivedProfileCountry({
    facts: [{ factId: "region", value: "AB", provenance: "resume_verified", lane: "live_owner_fact" }],
  }, { pageType: "profile", fields: [], repeatables: [] }) as {
    fields: Array<{ fieldId: string; answer: { value: string }; optionMapping: { visibleOption: string } }>;
  };

  const region = projected.fields.find(({ fieldId }) => fieldId === "address.region");
  assert.equal(region?.answer.value, "AB");
  assert.equal(region?.optionMapping.visibleOption, "Alberta");
});

test("run preparation CLI rejects caller-supplied IDs and malformed argument sets", () => {
  for (const values of [
    ["--storage-root", storageRoot, "--target-url", targetUrl, "--account-mode", "other"],
    ["--storage-root", "relative", "--target-url", targetUrl, "--account-mode", "sign_in"],
    ["--storage-root", storageRoot, "--target-url", targetUrl, "--run-key", "remember-me"],
    ["--storage-root", storageRoot, "--target-url", targetUrl],
    [
      "--storage-root", storageRoot,
      "--target-url", targetUrl,
      "--account-mode", "sign_in",
      "--application-profile", resolve("C:\\protected\\current.json"),
      "--trusted-legacy-application-profile", resolve("C:\\protected\\legacy.json"),
      "--application-resume", resolve("C:\\protected\\resume.pdf"),
    ],
  ]) {
    assert.throws(() => parseStage2RunPreparationArgs(values), /invalid Stage 2 run preparation arguments/u);
  }
});
