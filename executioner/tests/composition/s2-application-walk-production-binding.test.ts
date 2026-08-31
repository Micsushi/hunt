import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
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
import { runStage2RealJourney } from "../../src/acceptance/s2-journey.ts";
import {
  createApplicationLaneAcceptanceCollector,
} from "../../src/ats/workday/application/lane-composition.ts";
import {
  browserPageId,
  disposeResumeArtifact,
  fieldId,
  journeyId,
  upstreamResumeId,
  useResumeArtifactUpload,
  type ResolvedResumeArtifact,
} from "../../src/contracts/index.ts";
import { FileBackedStage2ApplicationOwnerSourceResolver } from
  "../../src/composition/private/s2-application-owner-source.ts";
import { applicationProfileFactIds as profileFactIds } from
  "../../src/profile/application-profile.ts";

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
        pageId: "profile-page-1" as never,
        answerFallbackPolicy: "owner_facts_only",
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

test("production binding carries admitted synthetic mode without requiring a Profile lane", async () => {
  const fixture = liveFixture();
  try {
    const sourcePath = join(dirname(fixture.configPath), "runtime", "application-profile.json");
    const source = JSON.parse(readFileSync(sourcePath, "utf8"));
    source.profilePlan.mode = "synthetic_test_non_submittable";
    source.profilePlan.fields = [];
    source.executionPolicy = {
      browserTransport: "live_browser",
      answerFallbackPolicy: "deterministic_site_valid_editable",
      submissionPolicy: "forbidden",
      liveProofEligibility: "eligible",
    };
    writeFileSync(sourcePath, JSON.stringify(source));
    let admittedMode: string | undefined;
    const binding = createStage2ApplicationWalkProductionBinding({
      runtime: {
        async bind(request) {
          admittedMode = request.ownerSources.profilePlan.mode;
          return {
            walk: {
              observer: { async observe() { throw new Error("offline binding only"); } },
              handlers: {
                resume: verifiedHandler("resume", "resume_verified"),
                profile: neverHandler("profile", "profile_verified"),
                questionnaire: verifiedHandler("questionnaire", "questionnaire_verified"),
              },
              navigation: { async next() { throw new Error("offline binding only"); } },
              progress: { async record() { throw new Error("offline binding only"); } },
            },
            laneAcceptances: createApplicationLaneAcceptanceCollector(),
            cleanup: { async close() { return true; } },
          };
        },
      },
      inspectSource: () => ({
        repositoryRoot: resolve(".."),
        sourceRevision: "1111111111111111111111111111111111111111",
      }),
      now: () => fixture.now,
      aclAdmission: { admit: () => ({ ok: true as const }) },
    });
    const resolved = await binding.bind({
      configPath: fixture.configPath,
      evidenceRoot: fixture.evidenceRoot,
      checkpoint: "pre_review",
    }, AbortSignal.any([]));
    assert.equal(admittedMode, "synthetic_test_non_submittable");
    assert.deepEqual(resolved.input.executionPolicy, {
      browserTransport: "live_browser",
      answerFallbackPolicy: "deterministic_site_valid_editable",
      submissionPolicy: "forbidden",
      liveProofEligibility: "eligible",
    });
    assert.equal(await resolved.dependencies.cleanup.close(AbortSignal.any([])), true);
  } finally {
    fixture.cleanup();
  }
});

test("application slice preserves a posting-unavailable account fact", async () => {
  const fixture = liveFixture();
  let cleanupCalls = 0;
  try {
    const collector = createApplicationLaneAcceptanceCollector();
    const binding = createStage2ApplicationWalkProductionBinding({
      runtime: {
        async bind() {
          return {
            walk: {
              observer: { async observe() { throw new Error("must not walk"); } },
              handlers: {
                resume: verifiedHandler("resume", "resume_verified"),
                profile: neverHandler("profile", "profile_verified"),
                questionnaire: neverHandler("questionnaire", "questionnaire_verified"),
              },
              navigation: { async next() { throw new Error("must not navigate"); } },
              progress: { async record() { throw new Error("must not record"); } },
            },
            laneAcceptances: collector,
            account: {
              async verify() {
                return {
                  ok: false as const,
                  code: "posting_unavailable",
                  fact: { kind: "posting_unavailable" as const, reason: "not_found" as const },
                };
              },
            },
            cleanup: {
              async close() {
                cleanupCalls += 1;
                return true;
              },
            },
          };
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

    assert.deepEqual(result, {
      ok: false,
      code: "posting_unavailable",
      fact: { kind: "posting_unavailable", reason: "not_found" },
    });
    assert.equal(cleanupCalls, 1);
  } finally {
    fixture.cleanup();
  }
});

test("production owner source admits catalog-bound resume fields outside flat profile facts", async () => {
  const fixture = liveFixture();
  try {
    const manifestPath = join(dirname(fixture.configPath), "runtime", "application-profile.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      profilePlan: Record<string, unknown>;
      executionPolicy: Record<string, unknown>;
    };
    manifest.profilePlan = {
      mode: "synthetic_test_non_submittable",
      pageType: "profile",
      fields: [{
        fieldId: "skills.values",
        questionType: "skill",
        answerType: "multi_select",
        allowedOptions: ["TypeScript"],
        answer: {
          kind: "answered",
          value: "TypeScript",
          provenance: "resume_verified",
          lane: "live_owner_fact",
        },
        optionMapping: {
          canonicalValue: "TypeScript",
          visibleOption: "TypeScript",
          provenance: "visible_option",
        },
      }],
      repeatables: [{
        section: "experience",
        rows: [{
          rowKey: "experience_fixture_row_01",
          fields: [{
            fieldId: "experience.company",
            questionType: "employment",
            answerType: "text",
            allowedOptions: [],
            answer: {
              kind: "answered",
              value: "Example Company",
              provenance: "resume_verified",
              lane: "live_owner_fact",
            },
          }, {
            fieldId: "experience.location",
            questionType: "employment",
            answerType: "text",
            allowedOptions: [],
            answer: {
              kind: "answered",
              value: "Example City",
              provenance: "resume_verified",
              lane: "live_owner_fact",
            },
          }],
        }],
      }],
    };
    manifest.executionPolicy = {
      browserTransport: "live_browser",
      answerFallbackPolicy: "deterministic_site_valid_editable",
      submissionPolicy: "forbidden",
      liveProofEligibility: "eligible",
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const owner = fixture.owner;
    const sources = await new FileBackedStage2ApplicationOwnerSourceResolver({
      forbiddenRoots: [resolve("..")],
    }).resolve({
      runtimeRoot: owner.roots.runtime.path,
      revisionId: owner.revisionId,
      approvalId: owner.approval.approvalId,
      journeyId: owner.journeyId,
      targetHandleId: owner.target.handleId,
      profileRef: owner.profileRef,
      resumeRef: owner.resumeRef,
      approvedAt: owner.approval.approvedAt,
    }, AbortSignal.any([]));
    try {
      assert.equal(sources.profilePlan.fields[0]?.fieldId, "skills.values");
      assert.equal(sources.profilePlan.repeatables[0]?.rows[0]?.fields.length, 2);
    } finally {
      disposeResumeArtifact(sources.resumeIntent.artifact);
    }
  } finally {
    fixture.cleanup();
  }
});

test("production application graph routes approval expiry through release cleanup", async () => {
  const fixture = liveFixture();
  const calls: string[] = [];
  let retainedResume: ResolvedResumeArtifact | undefined;
  let released = false;
  let releaseAt = 0;
  const approvalExpiryAt = Date.now() + 40;
  const leaseExpiryAt = Date.now() + 500;
  try {
    const collector = createApplicationLaneAcceptanceCollector();
    collector.record({
      schemaVersion: 1,
      checkpoint: "profile_verified",
      pageId: "profile-page-1" as never,
      answerFallbackPolicy: "owner_facts_only",
      pageType: "profile",
      verifiedFields: [],
      ownedDuplicateRows: 0,
      independentlyVerified: true,
      submitActivated: false,
      privacyScan: "pass",
    });
    const runtime: Stage2ApplicationWalkRuntimeBinding = {
      async bind(request) {
        retainedResume = request.ownerSources.resumeIntent.artifact;
        return {
          walk: {
            observer: {
              async observe() {
                return { ok: true as const, value: truth("profile", "expiry-profile") };
              },
            },
            handlers: {
              resume: verifiedHandler("resume", "resume_verified"),
              profile: verifiedHandler("profile", "profile_verified"),
              questionnaire: neverHandler("questionnaire", "questionnaire_verified"),
            },
            navigation: { async next() { return { ok: true as const, value: { advanced: true as const } }; } },
            progress: { async record() { return { ok: true as const, value: undefined }; } },
          },
          laneAcceptances: collector,
          cleanup: {
            async preserve() {
              calls.push("preserve");
              return true;
            },
            retentionExpiresAt() {
              return new Date(Math.min(approvalExpiryAt, leaseExpiryAt)).toISOString();
            },
            async release() {
              calls.push("release");
              calls.push("monitor.close", "profile.close", "context.close");
              releaseAt = Date.now();
              released = true;
              return true;
            },
            async close() {
              calls.push("ordinary.close");
              return true;
            },
          },
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
      checkpoint: "profile_verified",
    }, AbortSignal.any([]), binding);
    assert.equal(result.ok, true, JSON.stringify(result));
    for (let attempt = 0; attempt < 50 && !released; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(released, true);
    assert.equal(releaseAt < leaseExpiryAt, true);
    assert.deepEqual(calls, [
      "preserve",
      "release",
      "monitor.close",
      "profile.close",
      "context.close",
    ]);
    assert.equal(retainedResume !== undefined, true);
    if (retainedResume !== undefined) {
      assert.deepEqual(await useResumeArtifactUpload(retainedResume, () => ({
        ok: true as const,
        value: undefined,
      })), {
        ok: false,
        error: { code: "artifact_already_consumed", retryable: false },
      });
    }
  } finally {
    fixture.cleanup();
  }
});

test("real journey production graph forwards retention and preserves its causal failure", async () => {
  const runScenario = async (preserveAccepted: boolean) => {
    const fixture = liveFixture();
    const calls: string[] = [];
    let retainedResume: ResolvedResumeArtifact | undefined;
    let retained = false;
    let releaseCalls = 0;
    let closeCalls = 0;
    const sourceRevision = "1111111111111111111111111111111111111111";
    try {
      const configSha256 = createHash("sha256").update(readFileSync(fixture.configPath)).digest("hex");
      const owner = fixture.owner as typeof fixture.owner & {
        approval: { approvalId: string };
        target: { handleId: string };
      };
      const incomplete = {
        ...truth("profile", "real-journey-profile"),
        requiredFields: [{
          fieldId: fieldId("real-journey-required"),
          verification: "unverified" as const,
        }],
      };
      const runtime: Stage2RealJourneyLiveRuntimeBinding = {
        async bind(request) {
          retainedResume = request.ownerSources.resumeIntent.artifact;
          return {
            walk: {
              observer: { async observe() { return { ok: true as const, value: incomplete }; } },
              handlers: {
                resume: verifiedHandler("resume", "resume_verified"),
                profile: verifiedHandler("profile", "profile_verified"),
                questionnaire: verifiedHandler("questionnaire", "questionnaire_verified"),
              },
              navigation: { async next() { return { ok: true as const, value: { advanced: true as const } }; } },
              progress: { async record() { return { ok: true as const, value: undefined }; } },
            },
            laneAcceptances: { snapshot: () => [] },
            account: {
              async verify() {
                return {
                  ok: true as const,
                  proof: {
                    schemaVersion: 1 as const,
                    proofRevision: "s2-account-session-proof-v1" as const,
                    status: "unsealed" as const,
                    sourceRevision: request.sourceRevision,
                    configSha256: request.configSha256,
                    revisionId: request.owner.revisionId,
                    approvalId: request.owner.approval.approvalId,
                    journeyId: request.owner.journeyId,
                    targetHandleId: request.owner.target.handleId,
                    accountState: "application_ready" as const,
                    independentlyObservedVerifiedState: true as const,
                    verificationProof: "credential_sign_in" as const,
                    provider: "workday-auth" as const,
                    consumedCandidateCount: 0 as const,
                    messageBodyRetained: false as const,
                    submitActivated: false as const,
                  },
                };
              },
            },
            recovery: { async pending() { return null; } },
            review: { async capture() { throw new Error("review must not be reached"); } },
            privacy: { async forbiddenTokens() { return []; } },
            cleanup: {
              async preserve() {
                calls.push("preserve");
                retained = preserveAccepted;
                return preserveAccepted;
              },
              retentionExpiresAt() {
                return retained && releaseCalls === 0
                  ? new Date(Date.now() + 25).toISOString()
                  : undefined;
              },
              async release() {
                calls.push("release", "monitor.close", "profile.close", "context.close");
                releaseCalls += 1;
                retained = false;
                return true;
              },
              async close() {
                calls.push("close:false");
                closeCalls += 1;
                retained = false;
                return true;
              },
            },
          };
        },
      };
      const binding = createStage2RealJourneyProductionBinding({
        runtime,
        inspectSource: () => ({ repositoryRoot: resolve(".."), sourceRevision }),
        now: () => fixture.now,
        aclAdmission: { admit: () => ({ ok: true as const }) },
      });
      const result = await runStage2RealJourney(
        {
          args: { configPath: fixture.configPath, evidenceRoot: fixture.evidenceRoot },
          source: { repositoryRoot: resolve(".."), sourceRevision },
          config: {
            configSha256,
            contractRevision: "s2-owner-inputs-v1",
            revisionId: String(owner.revisionId),
            approvalId: owner.approval.approvalId,
            journeyId: String(owner.journeyId),
            targetHandleId: owner.target.handleId,
          },
        },
        binding,
        { now: () => fixture.now, writeAcceptance: async () => undefined },
        AbortSignal.any([]),
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "pre_review_failed");
      assert.equal(result.terminal.status, "failed");
      if (result.terminal.status !== "failed") return;
      assert.equal(result.terminal.errorCode, "page_incomplete");
      assert.equal(result.cleanupErrorCode, undefined);
      assert.equal(calls.includes("preserve"), true);
      if (preserveAccepted) {
        assert.equal(retained, true);
        assert.equal(closeCalls, 0);
        for (let attempt = 0; attempt < 50 && releaseCalls === 0; attempt += 1) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
        assert.equal(releaseCalls, 1);
        assert.equal(retained, false);
        assert.equal(closeCalls, 0);
        assert.deepEqual(calls.slice(-4), ["release", "monitor.close", "profile.close", "context.close"]);
      } else {
        assert.equal(releaseCalls, 0);
        assert.equal(closeCalls, 1);
        assert.deepEqual(calls, ["preserve", "close:false"]);
      }
      assert.equal(retainedResume !== undefined, true);
      if (retainedResume !== undefined) {
        assert.deepEqual(await useResumeArtifactUpload(retainedResume, () => ({
          ok: true as const,
          value: undefined,
        })), {
          ok: false,
          error: { code: "artifact_already_consumed", retryable: false },
        });
      }
      assert.doesNotMatch(JSON.stringify(result), /submitActivated":true/iu);
    } finally {
      fixture.cleanup();
    }
  };

  await runScenario(true);
  await runScenario(false);
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
    assert.deepEqual(result, { ok: false, code: "browser_session_missing" });
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
    const collector = createApplicationLaneAcceptanceCollector();
    const pages = [
      truth("profile", "s2-profile"),
      truth("profile", "s2-profile"),
      truth("pre_review", "s2-review"),
    ];
    let observed = 0;
    const runtime: Stage2RealJourneyLiveRuntimeBinding = {
      async bind(request) {
        calls.push("live.bind");
        collector.record({
        schemaVersion: 1,
        checkpoint: "profile_verified",
        pageId: "profile-page-1" as never,
        answerFallbackPolicy: "owner_facts_only",
          pageType: "profile",
          verifiedFields: [],
          ownedDuplicateRows: 0,
          independentlyVerified: true,
          submitActivated: false,
          privacyScan: "pass",
        });
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
          laneAcceptances: collector,
          account: {
            async verify() {
              return { ok: false as const, code: "account_proof_invalid" };
            },
          },
          recovery: { async pending() { return null; } },
          review: { async capture() { throw new Error("not used by binding test"); } },
          privacy: { async forbiddenTokens() { return ["private-owner-value"]; } },
          cleanup: {
            async preserve() {
              calls.push("cleanup.preserve");
              return false;
            },
            async release() {
              calls.push("cleanup.release");
              return true;
            },
            retentionExpiresAt() {
              return "2099-08-05T07:00:00.000Z";
            },
            async close() {
              calls.push("cleanup.close");
              throw new Error("Windows profile remains locked until process exit");
            },
          },
        };
      },
    };
    const sourceRevision = "1111111111111111111111111111111111111111";
    const binding = createStage2RealJourneyProductionBinding({
      runtime,
      outerProcessCleanup: true,
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
    assert.equal(typeof bound.cleanup.release, "function");
    assert.equal(typeof bound.cleanup.retentionExpiresAt, "function");
    assert.deepEqual(await bound.privacy.forbiddenTokens(AbortSignal.any([])), ["private-owner-value"]);
    assert.equal(await bound.cleanup.close(AbortSignal.any([]), true), true);
    assert.equal(existsSync(join(fixture.evidenceRoot, "application-walk-acceptance.json")), true);
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
        { factId: "given_name", value: "Ada", provenance: "owner_provided", lane: "live_owner_fact" },
        { factId: "configured_narrative", value: "I build dependable systems.", provenance: "configured_template", lane: "live_owner_fact" },
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
        answer: { kind: "answered", value: "Ada", provenance: "owner_provided", lane: "live_owner_fact" },
      }],
      repeatables: [],
    },
    executionPolicy: {
      browserTransport: "live_browser",
      answerFallbackPolicy: "owner_facts_only",
      submissionPolicy: "forbidden",
      liveProofEligibility: "eligible",
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
