import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  linkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  createStage2ApplicationWalkProductionBinding,
  runStage2ApplicationWalkFromOwnerConfig,
  type Stage2ApplicationWalkRuntimeBinding,
} from "../../src/composition/s2-application-walk-runner.ts";
import {
  createStage2RealJourneyProductionBinding,
  type Stage2RealJourneyLiveRuntimeBinding,
} from "../../src/acceptance/s2-production-binding.ts";
import {
  createApplicationLaneAcceptanceCollector,
} from "../../src/ats/workday/application/lane-composition.ts";
import {
  browserPageId,
  fieldId,
  journeyId,
  upstreamResumeId,
  useResumeArtifactUpload,
  type ResolvedResumeArtifact,
} from "../../src/contracts/index.ts";

test("production binding resolves opaque owner sources without value leakage", async () => {
  const fixture = liveFixture();
  let runtimeCalls = 0;
  let accountCalls = 0;
  try {
    const collector = createApplicationLaneAcceptanceCollector();
    const runtime: Stage2ApplicationWalkRuntimeBinding = {
      async bind(request) {
        runtimeCalls += 1;
        assert.equal(request.ownerSources.profilePlan.fields[0]?.answer.kind, "answered");
        assert.equal(request.ownerSources.profileId, "profile-owner-approved");
        collector.record({
          schemaVersion: 1,
          checkpoint: "profile_verified",
          pageType: "profile",
          verifiedFields: [],
          ownedDuplicateRows: 0,
          independentlyVerified: true,
          submitActivated: false,
          privacyScan: "pass",
        });
        collector.record({
          schemaVersion: 1,
          checkpoint: "resume_verified",
          artifactId: upstreamResumeId("resume-owner-approved"),
          sizeBytes: fixture.resumeBytes.byteLength,
          fileType: "pdf",
          browserState: {
            variant: "workday_resume_file_upload_v1",
            inputCardinality: 1,
            uploadedFileCount: 1,
            uploadComplete: true,
            requiredErrorVisible: false,
            removeControlCardinality: 1,
          },
          independentlyVerified: true,
          duplicateUploadAvoided: false,
          replacedExisting: false,
          submitActivated: false,
          privacyScan: "pass",
        });
        let pageIndex = 0;
        return {
          walk: {
            observer: {
              async observe() {
                const page = ["profile", "profile", "resume", "resume"] as const;
                return {
                  ok: true as const,
                  value: {
                    page: page[pageIndex++]!,
                    pageId: browserPageId("s2-page"),
                    requiredFields: [{
                      fieldId: fieldId("resume.required"),
                      verification: "verified" as const,
                    }],
                    c3OwnedDuplicateRows: 0,
                    submitActivated: false,
                  },
                };
              },
            },
            handlers: {
              resume: {
                async reconcile(input) {
                  return {
                    ok: true as const,
                    value: {
                      page: "resume" as const,
                      pageId: input.pageId,
                      checkpoint: "resume_verified" as const,
                      independentlyVerified: true as const,
                    },
                  };
                },
              },
              profile: verifiedHandler("profile", "profile_verified"),
              questionnaire: neverHandler("questionnaire", "questionnaire_verified"),
            },
            navigation: { async next() { return { ok: true as const, value: { advanced: true as const } }; } },
            progress: { async record() { return { ok: true as const, value: undefined }; } },
          },
          laneAcceptances: collector,
          account: {
            async verify() {
              accountCalls += 1;
              return { ok: true as const, proof: {} as never };
            },
          },
          cleanup: { async close() { return true; } },
        };
      },
    };
    const binding = createStage2ApplicationWalkProductionBinding({
      runtime,
      inspectSource: () => ({
        repositoryRoot: resolve(".."),
        sourceRevision: "1111111111111111111111111111111111111111",
      }),
      now: () => fixture.now,
      aclAdmission: { admit: () => ({ ok: true as const }) },
    });

    const result = await runStage2ApplicationWalkFromOwnerConfig({
      configPath: fixture.configPath,
      evidenceRoot: fixture.evidenceRoot,
      checkpoint: "resume_verified",
    }, AbortSignal.any([]), binding);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(runtimeCalls, 1);
    assert.equal(accountCalls, 1);
    const written = readFileSync(join(fixture.evidenceRoot, "application-walk-acceptance.json"), "utf8");
    assert.doesNotMatch(written, /Ada|dependable systems|application-profile|application-resume|sha256|[a-f0-9]{64}/u);
    const ownerConfig = readFileSync(fixture.configPath, "utf8");
    assert.doesNotMatch(ownerConfig, /Ada|dependable systems|application-profile|application-resume|\.pdf|[a-f0-9]{64}/u);
  } finally {
    fixture.cleanup();
  }
});

test("production binding denies a crossed opaque reference before runtime assembly", async () => {
  const fixture = liveFixture();
  let runtimeCalls = 0;
  try {
    const owner = fixture.owner as Record<string, unknown>;
    owner.profileRef = "profile_ref_wrongwrongwrong1";
    writeFileSync(fixture.configPath, JSON.stringify(owner));
    const binding = createStage2ApplicationWalkProductionBinding({
      runtime: {
        async bind() {
          runtimeCalls += 1;
          throw new Error("must not bind runtime");
        },
      },
      inspectSource: () => ({
        repositoryRoot: resolve(".."),
        sourceRevision: "1111111111111111111111111111111111111111",
      }),
      now: () => fixture.now,
      aclAdmission: { admit: () => ({ ok: true as const }) },
    });
    const result = await runStage2ApplicationWalkFromOwnerConfig({
      configPath: fixture.configPath,
      evidenceRoot: fixture.evidenceRoot,
      checkpoint: "resume_verified",
    }, AbortSignal.any([]), binding);
    assert.deepEqual(result, { ok: false, code: "owner_config_invalid" });
    assert.equal(runtimeCalls, 0);
  } finally {
    fixture.cleanup();
  }
});

test("production binding denies a hard-linked owner config before source resolution", async () => {
  const fixture = liveFixture();
  let runtimeCalls = 0;
  try {
    linkSync(fixture.configPath, join(fixture.root, "owner-input-alias.json"));
    const binding = createStage2ApplicationWalkProductionBinding({
      runtime: {
        async bind() {
          runtimeCalls += 1;
          throw new Error("must not bind runtime");
        },
      },
      inspectSource: () => ({
        repositoryRoot: resolve(".."),
        sourceRevision: "1111111111111111111111111111111111111111",
      }),
      now: () => fixture.now,
      aclAdmission: { admit: () => ({ ok: true as const }) },
    });
    const result = await runStage2ApplicationWalkFromOwnerConfig({
      configPath: fixture.configPath,
      evidenceRoot: fixture.evidenceRoot,
      checkpoint: "resume_verified",
    }, AbortSignal.any([]), binding);
    assert.deepEqual(result, { ok: false, code: "owner_config_invalid" });
    assert.equal(runtimeCalls, 0);
  } finally {
    fixture.cleanup();
  }
});

test("production binding disposes the immutable resume snapshot when runtime assembly fails", async () => {
  const fixture = liveFixture();
  let artifact: ResolvedResumeArtifact | undefined;
  try {
    const binding = createStage2ApplicationWalkProductionBinding({
      runtime: {
        async bind(request) {
          artifact = request.ownerSources.resumeIntent.artifact;
          throw new Error("fixture runtime assembly failure");
        },
      },
      inspectSource: () => ({
        repositoryRoot: resolve(".."),
        sourceRevision: "1111111111111111111111111111111111111111",
      }),
      now: () => fixture.now,
      aclAdmission: { admit: () => ({ ok: true as const }) },
    });
    const result = await runStage2ApplicationWalkFromOwnerConfig({
      configPath: fixture.configPath,
      evidenceRoot: fixture.evidenceRoot,
      checkpoint: "resume_verified",
    }, AbortSignal.any([]), binding);
    assert.deepEqual(result, { ok: false, code: "owner_config_invalid" });
    assert.notEqual(artifact, undefined);
    const reused = await useResumeArtifactUpload(artifact!, () => ({
      ok: true as const,
      value: undefined,
    }));
    assert.deepEqual(reused, {
      ok: false,
      error: { code: "artifact_already_consumed", retryable: false },
    });
  } finally {
    fixture.cleanup();
  }
});

test("outer Review binding resolves owner sources and retains only live browser authority", async () => {
  const fixture = liveFixture();
  const calls: string[] = [];
  try {
    const pages = [
      truth("profile", "s2-profile"),
      truth("profile", "s2-profile"),
      truth("resume", "s2-resume"),
      truth("resume", "s2-resume"),
      truth("questionnaire", "s2-questionnaire"),
      truth("questionnaire", "s2-questionnaire"),
      truth("pre_review", "s2-review"),
    ];
    let observed = 0;
    const runtime: Stage2RealJourneyLiveRuntimeBinding = {
      async bind(request) {
        calls.push("live.bind");
        assert.equal(request.ownerSources.profileId, "profile-owner-approved");
        assert.equal(
          request.configSha256,
          createHash("sha256").update(readFileSync(fixture.configPath)).digest("hex"),
        );
        return {
          walk: {
            observer: { async observe() { return { ok: true as const, value: pages[observed++]! }; } },
            handlers: {
              resume: verifiedHandler("resume", "resume_verified"),
              profile: verifiedHandler("profile", "profile_verified"),
              questionnaire: verifiedHandler("questionnaire", "questionnaire_verified"),
            },
            navigation: { async next() { return { ok: true as const, value: { advanced: true as const } }; } },
            progress: { async record() { return { ok: true as const, value: undefined }; } },
          },
          laneAcceptances: createApplicationLaneAcceptanceCollector(),
          account: {
            async verify() {
              return { ok: false as const, code: "account_proof_invalid" };
            },
          },
          recovery: { async pending() { return null; } },
          review: { async capture() { throw new Error("not used by binding test"); } },
          privacy: { async forbiddenTokens() { return ["private-owner-value"]; } },
          cleanup: { async close() { calls.push("cleanup.close"); return true; } },
        };
      },
    };
    const sourceRevision = "1111111111111111111111111111111111111111";
    const binding = createStage2RealJourneyProductionBinding({
      runtime,
      inspectSource: () => ({ repositoryRoot: resolve(".."), sourceRevision }),
      now: () => fixture.now,
      aclAdmission: { admit: () => ({ ok: true as const }) },
    });
    const owner = fixture.owner as typeof fixture.owner & {
      approval: { approvalId: string };
      target: { handleId: string };
    };
    const bound = await binding.bind({
      args: { configPath: fixture.configPath, evidenceRoot: fixture.evidenceRoot },
      source: { repositoryRoot: resolve(".."), sourceRevision },
      config: {
        configSha256: createHash("sha256").update(readFileSync(fixture.configPath)).digest("hex"),
        contractRevision: "s2-owner-inputs-v1",
        revisionId: String(owner.revisionId),
        approvalId: owner.approval.approvalId,
        journeyId: String(owner.journeyId),
        targetHandleId: owner.target.handleId,
      },
    }, AbortSignal.any([]));

    const walked = await bound.application.run(AbortSignal.any([]));
    assert.equal(walked.ok, true, JSON.stringify(walked));
    assert.equal(walked.ok && walked.value.checkpoint, "pre_review");
    assert.deepEqual(await bound.privacy.forbiddenTokens(AbortSignal.any([])), ["private-owner-value"]);
    assert.equal(await bound.cleanup.close(AbortSignal.any([])), true);
    assert.deepEqual(calls, ["live.bind", "cleanup.close"]);
  } finally {
    fixture.cleanup();
  }
});

function liveFixture() {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-application-binding-"));
  const runKey = "run_20260805_abcdefghijklmnop";
  const transient = join(root, "transient", runKey);
  const runtimeRoot = join(transient, "runtime");
  const secretsRoot = join(transient, "secrets");
  const evidenceRoot = join(root, "retained", runKey, "evidence");
  for (const path of [runtimeRoot, secretsRoot, evidenceRoot]) mkdirSync(path, { recursive: true });
  const approvedAt = "2099-08-05T05:00:00.000Z";
  const now = "2099-08-05T06:00:00.000Z";
  const expiresAt = "2099-08-05T07:00:00.000Z";
  const ids = {
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop",
    targetHandleId: "target_ref_abcdefghijklmnop",
    profileRef: "profile_ref_abcdefghijklmnop",
    resumeRef: "resume_ref_abcdefghijklmnop",
    approvedAt,
  } as const;
  const owner = {
    schemaVersion: 1,
    contractRevision: "s2-owner-inputs-v1",
    revisionId: ids.revisionId,
    journeyId: ids.journeyId,
    accountMode: "sign_in",
    target: {
      handleId: ids.targetHandleId,
      url: "https://example.wd1.myworkdayjobs.invalid/en-US/Careers/job/Test_P12345",
      host: "example.wd1.myworkdayjobs.invalid",
      tenant: "example",
      posting: "P12345",
    },
    profileRef: ids.profileRef,
    resumeRef: ids.resumeRef,
    recipientBindingId: "recipient_abcdefghijklmnop",
    roots: {
      runtime: { rootId: "runtime_root_abcdefghijklmnop", path: runtimeRoot, access: "current_user_only" },
      secrets: { rootId: "secrets_root_abcdefghijklmnop", path: secretsRoot, access: "current_user_only" },
      evidence: { rootId: "evidence_root_abcdefghijklmnop", path: evidenceRoot, access: "current_user_only" },
    },
    policy: { cleanupLeaseHours: 24, retentionDays: 30 },
    approval: {
      schemaVersion: 1,
      approvalId: ids.approvalId,
      journeyId: ids.journeyId,
      revisionId: ids.revisionId,
      approved: true,
      liveAccess: true,
      approvedAt,
      expiresAt,
      ownerId: "owner_abcdefghijklmnop",
      runtimeOperatorId: "owner_abcdefghijklmnop",
      secretCustodianId: "owner_abcdefghijklmnop",
      evidenceCustodianId: "owner_abcdefghijklmnop",
    },
    adapters: { secretStore: "windows-dpapi-current-user-v1", mailboxProvider: "gmail-api-v1" },
    accountSecret: secret(ids.journeyId, "secret_handle_account123456789", "account_credentials", "credential_mutation_adapter", "account_access", expiresAt),
    gmailAuthorization: secret(ids.journeyId, "secret_handle_gmail12345678901", "gmail_oauth", "gmail_auth_executor", "mailbox_verification", expiresAt),
  };
  const configPath = join(transient, "owner-input.json");
  writeFileSync(configPath, JSON.stringify(owner));
  const resumeBytes = Buffer.from("%PDF-1.7\nproduction binding fixture\n");
  const sha256 = createHash("sha256").update(resumeBytes).digest("hex");
  writeFileSync(join(runtimeRoot, "application-resume.pdf"), resumeBytes);
  writeFileSync(join(runtimeRoot, "application-profile.json"), JSON.stringify({
    schemaVersion: 1,
    sourceRevision: "s2-application-owner-source-v1",
    scope: "application_completion",
    ...ids,
    resume: { resumeId: "resume-owner-approved", sha256, sizeBytes: resumeBytes.byteLength, fileType: "pdf" },
    profile: {
      profileId: "profile-owner-approved",
      revision: 3,
      facts: [
        { factId: "given_name", value: "Ada", provenance: "owner_provided" },
        { factId: "configured_narrative", value: "I build dependable systems.", provenance: "configured_template" },
      ],
    },
    profilePlan: {
      pageType: "profile",
      fields: [{
        fieldId: "identity.given_name",
        questionType: "identity",
        answerType: "text",
        answer: { kind: "answered", value: "Ada", provenance: "owner_provided" },
      }],
      repeatables: [],
    },
    narrative: { revision: "narrative-v1" },
  }));
  return {
    root,
    now,
    owner,
    configPath,
    evidenceRoot,
    resumeBytes,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function secret(
  journeyIdValue: string,
  handleId: string,
  purpose: string,
  consumer: string,
  scope: string,
  expiresAt: string,
) {
  return {
    schemaVersion: 1,
    handleId,
    journeyId: journeyIdValue,
    provider: "windows-dpapi-current-user-v1",
    purpose,
    consumer,
    scope,
    expiresAt,
  };
}

function neverHandler<Page extends "profile" | "questionnaire", Checkpoint extends "profile_verified" | "questionnaire_verified">(
  page: Page,
  checkpoint: Checkpoint,
) {
  return {
    async reconcile(input: { readonly pageId: ReturnType<typeof browserPageId> }) {
      return {
        ok: true as const,
        value: { page, pageId: input.pageId, checkpoint, independentlyVerified: true as const },
      };
    },
  };
}

function truth(page: "resume" | "profile" | "questionnaire" | "pre_review", id: string) {
  return {
    page,
    pageId: browserPageId(id),
    requiredFields: [],
    c3OwnedDuplicateRows: 0,
    submitActivated: false as const,
  };
}

function verifiedHandler<
  Page extends "resume" | "profile" | "questionnaire",
  Checkpoint extends "resume_verified" | "profile_verified" | "questionnaire_verified",
>(page: Page, checkpoint: Checkpoint) {
  return {
    async reconcile(input: { readonly pageId: ReturnType<typeof browserPageId> }) {
      return {
        ok: true as const,
        value: { page, pageId: input.pageId, checkpoint, independentlyVerified: true as const },
      };
    },
  };
}
