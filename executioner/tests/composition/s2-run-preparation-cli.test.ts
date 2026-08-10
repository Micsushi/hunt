import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  parseStage2RunPreparationArgs,
  runStage2RunPreparationCli,
} from "../../src/composition/s2-run-preparation-cli.ts";

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
    assert.equal(createHash("sha256").update(resume).digest("hex").length, 64);
  } finally {
    resume.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
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
