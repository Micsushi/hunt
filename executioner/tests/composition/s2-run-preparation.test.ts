import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareStage2LiveRun } from "../../src/composition/s2-run-preparation.ts";
import { FileBackedStage2ApplicationOwnerSourceResolver } from
  "../../src/composition/private/s2-application-owner-source.ts";
import { admitRealRunPreflight } from "../../src/live/preflight/admit.ts";
import { applicationProfileFactIds as profileFactIds } from
  "../../src/profile/application-profile.ts";

const noProtection = { protect: async () => undefined };
const liveOwnerPolicy = {
  browserTransport: "live_browser",
  answerFallbackPolicy: "owner_facts_only",
  submissionPolicy: "forbidden",
  liveProofEligibility: "eligible",
} as const;

test("live run preparation writes an admitted disposable owner config with the durable recipient binding", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-preparation-"));
  try {
    const prepared = await prepareStage2LiveRun({
      storageRoot,
      targetUrl: "https://blackrock.wd1.myworkdayjobs.com/en-US/BlackRock_Professional/job/New-York-NY/Senior-Data-Warehouse-Developer---PFS_R265422",
      accountMode: "sign_in",
      now: "2026-08-04T12:00:00.000Z",
    }, noProtection);
    const owner = JSON.parse(readFileSync(prepared.ownerConfigPath, "utf8"));

    assert.equal(owner.recipientBindingId, prepared.recipientBindingId);
    assert.deepEqual(owner.target, {
      handleId: owner.target.handleId,
      url: "https://blackrock.wd1.myworkdayjobs.com/en-US/BlackRock_Professional/job/New-York-NY/Senior-Data-Warehouse-Developer---PFS_R265422",
      host: "blackrock.wd1.myworkdayjobs.com",
      tenant: "blackrock",
      posting: "R265422",
    });
    assert.equal(owner.accountMode, "sign_in");
    assert.equal(owner.approval.approvedAt, "2026-08-04T12:00:00.000Z");
    assert.equal(owner.approval.expiresAt, "2026-08-04T12:30:00.000Z");
    assert.equal(owner.accountSecret.expiresAt, owner.approval.expiresAt);
    assert.equal(owner.gmailAuthorization.expiresAt, owner.approval.expiresAt);
    assert.equal(
      Date.parse(owner.gmailAuthorization.expiresAt) - Date.parse(owner.approval.approvedAt),
      30 * 60 * 1_000,
    );
    assert.equal(owner.roots.runtime.path, prepared.runtimeRoot);
    assert.equal(owner.roots.secrets.path, prepared.secretsRoot);
    assert.equal(owner.roots.evidence.path, prepared.evidenceRoot);
    assert.equal(admitRealRunPreflight(owner, {
      now: "2026-08-04T12:00:01.000Z",
      forbiddenRoots: [process.cwd()],
    }).ok, true);

    const bindingFile = readFileSync(
      join(storageRoot, "bindings", "recipient-binding.json"),
      "utf8",
    );
    assert.doesNotMatch(bindingFile, /blackrock|R265422|@/iu);
    assert.equal(prepared.ownerConfigPath.startsWith(prepared.transientRoot), true);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("live run preparation canonicalizes a lowercase Workday posting suffix", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-preparation-posting-case-"));
  try {
    const prepared = await prepareStage2LiveRun({
      storageRoot,
      targetUrl:
        "https://volarisgroup.wd3.myworkdayjobs.com/assetworks/job/example_r67871",
      accountMode: "sign_in",
      now: "2026-08-04T12:00:00.000Z",
    }, noProtection);
    const owner = JSON.parse(readFileSync(prepared.ownerConfigPath, "utf8"));

    assert.equal(owner.target.posting, "R67871");
    assert.equal(admitRealRunPreflight(owner, {
      now: "2026-08-04T12:00:01.000Z",
      forbiddenRoots: [process.cwd()],
    }).ok, true);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("sequential live runs keep recipient identity but rotate all run-scoped authority", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-preparation-"));
  try {
    const request = {
      storageRoot,
      targetUrl: "https://blackrock.wd1.myworkdayjobs.com/en-US/Careers/job/Test_R265422",
      accountMode: "sign_in" as const,
      now: "2026-08-04T12:00:00.000Z",
    };
    const first = await prepareStage2LiveRun(request, noProtection);
    const second = await prepareStage2LiveRun(request, noProtection);
    const firstOwner = JSON.parse(readFileSync(first.ownerConfigPath, "utf8"));
    const secondOwner = JSON.parse(readFileSync(second.ownerConfigPath, "utf8"));

    assert.equal(first.recipientBindingId, second.recipientBindingId);
    for (const field of ["revisionId", "journeyId", "profileRef", "resumeRef"] as const) {
      assert.notEqual(firstOwner[field], secondOwner[field]);
    }
    assert.notEqual(firstOwner.target.handleId, secondOwner.target.handleId);
    assert.notEqual(firstOwner.accountSecret.handleId, secondOwner.accountSecret.handleId);
    assert.notEqual(firstOwner.gmailAuthorization.handleId, secondOwner.gmailAuthorization.handleId);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("atomic preparation seals current protected application sources before approval", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-preparation-"));
  const resumeBytes = Buffer.from("%PDF-1.7\nowner-approved resume\n");
  const resumeSha256 = createHash("sha256").update(resumeBytes).digest("hex");
  try {
    const prepared = await prepareStage2LiveRun({
      storageRoot,
      targetUrl: "https://blackrock.wd1.myworkdayjobs.com/en-US/Careers/job/Test_R265422",
      accountMode: "sign_in",
      applicationSource: {
        resume: {
          resumeId: "resume-owner-approved",
          sha256: resumeSha256,
          sizeBytes: resumeBytes.byteLength,
          fileType: "pdf",
          bytes: resumeBytes,
        },
        profile: {
          profileId: "profile-owner-approved",
          revision: 1,
          facts: [
            { factId: "given_name", value: "Synthetic", provenance: "owner_provided", lane: "live_owner_fact" },
            { factId: "configured_narrative", value: "Synthetic narrative.", provenance: "configured_template", lane: "live_owner_fact" },
          ],
          unsetFactIds: profileFactIds.filter((factId) =>
            factId !== "given_name" && factId !== "configured_narrative"
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
            allowedOptions: [],
            answer: { kind: "answered", value: "Synthetic", provenance: "owner_provided", lane: "live_owner_fact" },
          }],
          repeatables: [],
        },
        executionPolicy: liveOwnerPolicy,
        narrative: { revision: "narrative-owner-approved" },
      },
    }, noProtection);
    const owner = JSON.parse(readFileSync(prepared.ownerConfigPath, "utf8"));
    const resolver = new FileBackedStage2ApplicationOwnerSourceResolver({
      forbiddenRoots: [process.cwd()],
    });

    const resolved = await resolver.resolve({
      runtimeRoot: prepared.runtimeRoot,
      revisionId: owner.revisionId,
      approvalId: owner.approval.approvalId,
      journeyId: owner.journeyId,
      targetHandleId: owner.target.handleId,
      profileRef: owner.profileRef,
      resumeRef: owner.resumeRef,
      approvedAt: owner.approval.approvedAt,
    }, AbortSignal.any([]));

    assert.equal(resolved.profileId, "profile-owner-approved");
    assert.equal(resolved.profilePlan.fields.length, 1);
    assert.equal(existsSync(join(prepared.runtimeRoot, "application-source-binding.json")), true);

    writeFileSync(
      join(prepared.runtimeRoot, "application-profile.json"),
      readFileSync(join(prepared.runtimeRoot, "application-profile.json")),
    );
    await assert.rejects(
      resolver.resolve({
        runtimeRoot: prepared.runtimeRoot,
        revisionId: owner.revisionId,
        approvalId: owner.approval.approvalId,
        journeyId: owner.journeyId,
        targetHandleId: owner.target.handleId,
        profileRef: owner.profileRef,
        resumeRef: owner.resumeRef,
        approvedAt: owner.approval.approvedAt,
      }, AbortSignal.any([])),
      { name: "TypeError", message: "application owner source denied" },
    );
  } finally {
    resumeBytes.fill(0);
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("preparation rejects source bytes that the production resolver cannot reopen", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-preparation-source-proof-"));
  const resumeBytes = Buffer.from("%PDF-1.7\nsource proof\n");
  try {
    await assert.rejects(prepareStage2LiveRun({
      storageRoot,
      targetUrl: "https://blackrock.wd1.myworkdayjobs.com/en-US/Careers/job/Test_R265422",
      accountMode: "sign_in",
      applicationSource: {
        resume: {
          resumeId: "resume-owner-approved",
          sha256: createHash("sha256").update(resumeBytes).digest("hex"),
          sizeBytes: resumeBytes.byteLength,
          fileType: "pdf",
          bytes: resumeBytes,
        },
        profile: {
          profileId: "profile-owner-approved",
          revision: 1,
          facts: [{
            factId: "given_name",
            value: "Synthetic",
            provenance: "owner_provided",
            lane: "live_owner_fact",
          }],
          unsetFactIds: profileFactIds.filter((factId) => factId !== "given_name"),
          discoveredFields: [],
        },
        profilePlan: {
          mode: "live",
          pageType: "profile",
          fields: [{
            fieldId: "identity.given_name",
            questionType: "identity",
            answerType: "text",
            answer: {
              kind: "answered",
              value: "Synthetic",
              provenance: "owner_provided",
              lane: "live_owner_fact",
            },
          }],
          repeatables: [],
        },
        executionPolicy: liveOwnerPolicy,
        narrative: { revision: "narrative-owner-approved" },
      },
    }, noProtection), { name: "Error", message: "run preparation denied" });
    assert.deepEqual(readdirSync(join(storageRoot, "transient")), []);
    assert.deepEqual(readdirSync(join(storageRoot, "retained")), []);
  } finally {
    resumeBytes.fill(0);
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("post-write source protection failure leaves no admitted run", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-preparation-"));
  const resumeBytes = Buffer.from("%PDF-1.7\nowner-approved resume\n");
  try {
    await assert.rejects(
      prepareStage2LiveRun({
        storageRoot,
        targetUrl: "https://blackrock.wd1.myworkdayjobs.com/en-US/Careers/job/Test_R265422",
        accountMode: "sign_in",
        applicationSource: {
          resume: {
            resumeId: "resume-owner-approved",
            sha256: createHash("sha256").update(resumeBytes).digest("hex"),
            sizeBytes: resumeBytes.byteLength,
            fileType: "pdf",
            bytes: resumeBytes,
          },
          profile: {
            profileId: "profile-owner-approved",
            revision: 1,
            facts: [{ factId: "given_name", value: "Synthetic", provenance: "owner_provided", lane: "live_owner_fact" }],
            unsetFactIds: profileFactIds.filter((factId) => factId !== "given_name"),
            discoveredFields: [],
          },
          profilePlan: {
            mode: "live",
            pageType: "profile",
            fields: [{
              fieldId: "identity.given_name",
              questionType: "identity",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Synthetic", provenance: "owner_provided", lane: "live_owner_fact" },
            }],
            repeatables: [],
          },
          executionPolicy: liveOwnerPolicy,
          narrative: { revision: "narrative-owner-approved" },
        },
      }, {
        protect: async (paths) => {
          if (paths.some(({ path }) => path.endsWith("application-profile.json"))) {
            throw new Error("injected source protection failure");
          }
        },
      }),
      { name: "Error", message: "run preparation denied" },
    );
    assert.deepEqual(readdirSync(join(storageRoot, "transient")), []);
    assert.deepEqual(readdirSync(join(storageRoot, "retained")), []);
  } finally {
    resumeBytes.fill(0);
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("application source is snapshotted before storage awaits and rejects caller time", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-preparation-"));
  const resumeBytes = Buffer.from("%PDF-1.7\nsource before await\n");
  const profile = {
    profileId: "profile-owner-approved",
    revision: 1,
    facts: [{
      factId: "given_name",
      value: "before",
      provenance: "owner_provided",
      lane: "live_owner_fact",
    }],
    unsetFactIds: profileFactIds.filter((factId) => factId !== "given_name"),
    discoveredFields: [],
  };
  const profilePlan = {
    mode: "live",
    pageType: "profile",
    fields: [{
      fieldId: "identity.given_name",
      questionType: "identity",
      answerType: "text",
      allowedOptions: [],
      answer: {
        kind: "answered",
        value: "before",
        provenance: "owner_provided",
        lane: "live_owner_fact",
      },
    }],
    repeatables: [],
  };
  const source = {
    resume: {
      resumeId: "resume-owner-approved",
      sha256: createHash("sha256").update(resumeBytes).digest("hex"),
      sizeBytes: resumeBytes.byteLength,
      fileType: "pdf" as const,
      bytes: resumeBytes,
    },
    profile,
    profilePlan,
    executionPolicy: liveOwnerPolicy,
    narrative: { revision: "narrative-owner-approved" },
  };
  try {
    await assert.rejects(prepareStage2LiveRun({
      storageRoot,
      targetUrl: "https://blackrock.wd1.myworkdayjobs.com/en-US/Careers/job/Test_R265422",
      accountMode: "sign_in",
      now: "2099-08-05T05:00:00.000Z",
      applicationSource: source,
    }, noProtection), { name: "Error", message: "run preparation denied" });

    const pending = prepareStage2LiveRun({
      storageRoot,
      targetUrl: "https://blackrock.wd1.myworkdayjobs.com/en-US/Careers/job/Test_R265422",
      accountMode: "sign_in",
      applicationSource: source,
    }, noProtection);
    profile.facts[0]!.value = "after";
    profilePlan.fields[0]!.answer.value = "after";
    resumeBytes.fill(0x78);
    const prepared = await pending;
    const captured = JSON.parse(readFileSync(
      join(prepared.runtimeRoot, "application-profile.json"),
      "utf8",
    ));
    assert.equal(captured.profile.facts[0].value, "before");
    assert.equal(captured.profilePlan.fields[0].answer.value, "before");
    assert.equal(
      readFileSync(join(prepared.runtimeRoot, "application-resume.pdf"), "ascii")
        .startsWith("%PDF-"),
      true,
    );
  } finally {
    resumeBytes.fill(0);
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("live run preparation rejects malformed or non-Workday targets before creating run state", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "hunt-s2-preparation-"));
  try {
    await assert.rejects(prepareStage2LiveRun({
      storageRoot,
      targetUrl: "https://example.com/job/Test_R265422",
      accountMode: "sign_in",
      now: "2026-08-04T12:00:00.000Z",
    }, noProtection), /run preparation denied/u);
    assert.equal(existsSync(join(storageRoot, "transient")), false);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});
