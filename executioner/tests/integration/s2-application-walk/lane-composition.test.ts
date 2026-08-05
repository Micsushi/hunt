import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createApplicationLaneHandlers,
  createApplicationLaneAcceptanceCollector,
  createImmutableApplicationLaneSources,
} from "../../../src/ats/workday/application/lane-composition.ts";
import {
  createWorkdayResumeFileIntent,
  type WorkdayResumeAcceptance,
  type WorkdayResumeFileIntent,
  type WorkdayResumeUploadHandler,
} from "../../../src/ats/workday/application/resume/index.ts";
import type {
  QuestionnairePageHandler,
  QuestionnairePageRequest,
} from "../../../src/ats/workday/application/questions/index.ts";
import type {
  ProfilePagePlan,
  ProfilePageSnapshot,
  WorkdayProfilePagePort,
} from "../../../src/ats/workday/application/profile/index.ts";
import {
  browserPageId,
  captureResumeArtifact,
  fieldId,
  guardRevision,
  upstreamProfileId,
  upstreamResumeId,
  type BrowserSessionId,
} from "../../../src/contracts/index.ts";
import { walkFixture } from "./fixtures.ts";

test("adapts T1-T3 lane ports into independently verified walk checkpoints", async () => {
  const values = laneValues();
  let profileValue: string | null = null;
  const profileSnapshot = (): ProfilePageSnapshot => ({
      pageType: "profile",
      controls: [{
        controlId: "given-name",
        fieldId: "identity.given_name",
        required: true,
        uiBehavior: "text",
        uiVariant: "workday_text_v1",
        readback: profileValue,
      }],
      rows: [],
    });
  const profilePage: WorkdayProfilePagePort = {
    async inspect() {
      return profileSnapshot();
    },
    async commit() {
      profileValue = "Ada";
    },
    async addOwnedRow() {
      throw new Error("not used");
    },
    async removeOwnedRow() {
      throw new Error("not used");
    },
  };
  const resume: WorkdayResumeUploadHandler = {
    async upload(intent) {
      assert.equal(intent, values.resumeIntent);
      return { ok: true, value: resumeAcceptance() };
    },
  };
  const questionnaire: QuestionnairePageHandler = {
    async complete(request) {
      assert.equal(request, sources.questionnaireRequest());
      return {
        ok: true,
        value: {
          kind: "verified",
          answers: [],
          protectedPlaceholderCount: 0,
        },
      };
    },
  };
  const sources = createImmutableApplicationLaneSources(values);
  const acceptances = createApplicationLaneAcceptanceCollector();
  const handlers = createApplicationLaneHandlers({
    sources,
    resume,
    profilePage,
    questionnaire,
    acceptanceSink: acceptances,
  });
  const signal = new AbortController().signal;

  const resumeResult = await handlers.resume.reconcile({
    journeyId: walkFixture.journeyId,
    pageId: walkFixture.pages.resume,
    attempt: 1,
  }, signal);
  const profileResult = await handlers.profile.reconcile({
    journeyId: walkFixture.journeyId,
    pageId: walkFixture.pages.profile,
    attempt: 1,
  }, signal);
  const questionResult = await handlers.questionnaire.reconcile({
    journeyId: walkFixture.journeyId,
    pageId: walkFixture.pages.questionnaire,
    attempt: 1,
  }, signal);

  assert.deepEqual(resumeResult.ok && resumeResult.value, {
    page: "resume",
    pageId: walkFixture.pages.resume,
    checkpoint: "resume_verified",
    independentlyVerified: true,
  });
  assert.deepEqual(profileResult.ok && profileResult.value, {
    page: "profile",
    pageId: walkFixture.pages.profile,
    checkpoint: "profile_verified",
    independentlyVerified: true,
  });
  assert.deepEqual(questionResult.ok && questionResult.value, {
    page: "questionnaire",
    pageId: walkFixture.pages.questionnaire,
    checkpoint: "questionnaire_verified",
    independentlyVerified: true,
  });
  assert.deepEqual(
    acceptances.snapshot("questionnaire_verified").map(({ checkpoint }) =>
      checkpoint
    ),
    ["resume_verified", "profile_verified", "questionnaire_verified"],
  );
  assert.doesNotMatch(JSON.stringify(acceptances.snapshot("questionnaire_verified")), /Ada/u);
});

test("captures profile and questionnaire inputs as immutable source snapshots", () => {
  const values = laneValues();
  const sources = createImmutableApplicationLaneSources(values);
  const plan = sources.profilePlan();
  const request = sources.questionnaireRequest();

  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.fields), true);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.page), true);
  assert.notEqual(plan, values.profilePlan);
  assert.notEqual(request, values.questionnaireRequest);
  assert.equal(request.resumeArtifact, values.questionnaireRequest.resumeArtifact);
});

test("maps a transient profile page-port outage to the bounded retry policy", async () => {
  const values = laneValues();
  const handlers = createApplicationLaneHandlers({
    sources: createImmutableApplicationLaneSources(values),
    resume: { async upload() { return { ok: true, value: resumeAcceptance() }; } },
    profilePage: {
      async inspect() { throw new Error("transient fixture outage"); },
      async commit() {},
      async addOwnedRow() { throw new Error("not used"); },
      async removeOwnedRow() {},
    },
    questionnaire: {
      async complete() {
        return { ok: true, value: { kind: "verified", answers: [], protectedPlaceholderCount: 0 } };
      },
    },
  });

  const result = await handlers.profile.reconcile({
    journeyId: walkFixture.journeyId,
    pageId: walkFixture.pages.profile,
    attempt: 1,
  }, new AbortController().signal);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "browser_timeout");
  assert.equal(result.error.classifier, "profile_page");
  assert.equal(result.error.primitive, "profile_control");
  assert.equal("message" in result.error, false);
});

function laneValues(): {
  readonly resumeIntent: WorkdayResumeFileIntent;
  readonly profilePlan: ProfilePagePlan;
  readonly questionnaireRequest: QuestionnairePageRequest;
} {
  const bytes = new TextEncoder().encode("S2 F3 immutable resume fixture");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const resumeId = upstreamResumeId("resume-s2-f3-composition");
  const artifact = captureResumeArtifact({ resumeId, sha256 }, bytes);
  assert.equal(artifact.ok, true);
  if (!artifact.ok) throw new Error("fixture artifact capture failed");
  const intent = createWorkdayResumeFileIntent({
    artifactId: resumeId,
    artifact: artifact.value,
    fileType: "pdf",
  });
  assert.equal(intent.ok, true);
  if (!intent.ok) throw new Error("fixture resume intent failed");
  const profilePlan: ProfilePagePlan = {
    pageType: "profile",
    fields: [{
      fieldId: "identity.given_name",
      questionType: "identity",
      answerType: "text",
      answer: { kind: "answered", value: "Ada", provenance: "owner_provided" },
    }],
    repeatables: [],
  };
  const questionnaireRequest = {
    journeyId: walkFixture.journeyId,
    sessionId: "browser_session_s2f3fixture0001" as BrowserSessionId,
    pageId: walkFixture.pages.questionnaire,
    guardRevision: guardRevision("guard-s2-f3-composition"),
    profileId: upstreamProfileId("profile-s2-f3-composition"),
    profileRevision: 1,
    resume: { resumeId, sha256 },
    resumeArtifact: artifact.value,
    page: {
      sessionId: "browser_session_s2f3fixture0001",
      pageId: browserPageId("s2-questionnaire"),
      path: "/questionnaire",
      pageIdentity: { kind: "workday", page: "questionnaire" },
      fields: [{
        fieldId: fieldId("authorization-answer"),
        target: "target-authorization-answer",
        label: "Are you authorized to work?",
        required: true,
        behavior: "radio",
        state: "visible",
        options: [],
      }],
    },
  } as unknown as QuestionnairePageRequest;
  return { resumeIntent: intent.value, profilePlan, questionnaireRequest };
}

function resumeAcceptance(): WorkdayResumeAcceptance {
  return {
    schemaVersion: 1,
    checkpoint: "resume_verified",
    artifactId: upstreamResumeId("resume-s2-f3-composition"),
    sizeBytes: 30,
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
  };
}
