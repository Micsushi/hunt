import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  parseStage2RunPreparationArgs,
  runStage2RunPreparationCli,
} from "../../src/composition/s2-run-preparation-cli.ts";
import { withDerivedProfileCountry } from
  "../../src/composition/private/s2-derived-profile-country.ts";

const storageRoot = resolve("C:\\protected\\hunt-c3-storage");
const targetUrl = "https://blackrock.wd1.myworkdayjobs.com/en-US/Careers/job/Test_R265422";

test("run preparation CLI accepts only the storage root, exact target, and account mode", () => {
  assert.deepEqual(parseStage2RunPreparationArgs([
    "--storage-root", storageRoot,
    "--target-url", targetUrl,
    "--account-mode", "sign_in",
  ]), { storageRoot, targetUrl, accountMode: "sign_in" });
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
          { factId: "given_name", value: "Synthetic", provenance: "owner_provided" },
          { factId: "email_address", value: "synthetic@example.invalid", provenance: "owner_provided" },
          { factId: "city", value: "Calgary", provenance: "resume_verified" },
          { factId: "region", value: "Alberta", provenance: "owner_provided" },
          { factId: "configured_narrative", value: "Synthetic narrative.", provenance: "configured_template" },
        ],
      },
      profilePlan: {
        pageType: "profile",
        fields: [{
          fieldId: "identity.given_name",
          questionType: "identity",
          answerType: "text",
          answer: { kind: "answered", value: "Synthetic", provenance: "owner_provided" },
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
    assert.deepEqual(captured.profilePlan.fields[1], {
      fieldId: "address.country",
      questionType: "address",
      answerType: "option",
      answer: { kind: "answered", value: "CA", provenance: "journey_derived" },
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
        answer: {
          kind: "answered",
          value: "synthetic@example.invalid",
          provenance: "owner_provided",
        },
      },
      {
        fieldId: "address.city",
        questionType: "address",
        answerType: "text",
        answer: {
          kind: "answered",
          value: "Calgary",
          provenance: "resume_verified",
        },
      },
      {
        fieldId: "address.region",
        questionType: "address",
        answerType: "option",
        answer: {
          kind: "answered",
          value: "Alberta",
          provenance: "owner_provided",
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
    pageType: "profile",
    fields: [{
      fieldId: "contact.email",
      questionType: "identity",
      answerType: "text",
      answer: { kind: "answered", value: "planned@example.invalid", provenance: "owner_provided" },
    }],
    repeatables: [],
  };

  const projected = withDerivedProfileCountry({
    facts: [
      { factId: "email_address", value: "fact@example.invalid", provenance: "owner_provided" },
      { factId: "city", value: "Edmonton", provenance: "configured_template" },
    ],
  }, plan) as typeof plan;

  assert.deepEqual(projected.fields, [
    plan.fields[0],
    {
      fieldId: "address.city",
      questionType: "address",
      answerType: "text",
      answer: {
        kind: "answered",
        value: "Edmonton",
        provenance: "configured_template",
      },
    },
  ]);
  assert.equal(projected.fields.some(({ fieldId }) => fieldId === "address.region"), false);
});

test("profile fact projection maps a Canadian region code to its exact visible option", () => {
  const projected = withDerivedProfileCountry({
    facts: [{ factId: "region", value: "AB", provenance: "resume_verified" }],
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
  ]) {
    assert.throws(() => parseStage2RunPreparationArgs(values), /invalid Stage 2 run preparation arguments/u);
  }
});
