import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  browserPageId,
  browserTargetToken,
  boundedText,
  fieldId,
  optionId,
  upstreamProfileId,
  useResumeArtifactUpload,
  type BrowserControl,
  type BrowserReadback,
  type BrowserTargetObservation,
  type DurableJourneyState,
  type FieldObservation,
  type PortResult,
} from "../../../src/contracts/index.ts";
import { createWorkdayPageUnderstanding } from "../../../src/ats/workday/page-understanding.ts";
import { createApplicationAnswerResolver as createAnswerResolver } from
  "../../../src/form/answers/resolver.ts";
import type { ApplicationAnswerResolutionRequest } from
  "../../../src/form/answers/application-types.ts";
import { questionCatalog } from "../../../src/form/questions/catalog.ts";
import { createJourneyIntake } from "../../../src/intake/intake.ts";
import {
  createApplicationProfileQuery,
  toFrozenApplicantProfile,
} from "../../../src/profile/application-profile.ts";
import { contractFixtures } from "../../../src/testing/contracts/index.ts";
import { applicantProfileFixture } from "../../../src/testing/contracts/profile-fixture.ts";
import { requiredFieldFlowCases } from "../../../src/testing/contracts/field-flow-cases.ts";

const signal = new AbortController().signal;
const resumeBytes = new TextEncoder().encode("synthetic resume");
const profile = applicantProfileFixture({
  profileId: upstreamProfileId("profile-answer-connection"),
  revision: 7,
  facts: [
    { factId: "given_name", value: "Ada", provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "family_name", value: "Lovelace", provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "phone_number", value: "555-0100", provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "work_authorization", value: true, provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "age_requirement_met", value: true, provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "sponsorship_required", value: false, provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "country", value: "Canada", provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "earliest_start_date", value: "2026-09-01", provenance: "owner_provided", lane: "live_owner_fact" },
    { factId: "configured_narrative", value: "Exact configured interest statement.", provenance: "configured_template", lane: "live_owner_fact" },
  ],
} as const);

const targets = requiredFieldFlowCases.map((row): BrowserTargetObservation => {
  let control: BrowserControl;
  let readback: BrowserReadback = { kind: "empty" };
  switch (row.behavior) {
    case "text":
      control = { kind: "text", element: "input" };
      break;
    case "textarea":
      control = { kind: "text", element: "textarea" };
      break;
    case "radio":
      control = {
        kind: "choice",
        element: "input",
        choice: "radio",
        group: boundedText(row.fieldLabel),
        checked: false,
      };
      readback = { kind: "selected", option: null };
      break;
    case "checkbox":
      control = {
        kind: "choice",
        element: "input",
        choice: "checkbox",
        group: boundedText("Are you at least 18 years of age?"),
        checked: false,
      };
      readback = { kind: "checked", checked: false };
      break;
    case "select":
    case "listbox":
      control = {
        kind: "select",
        element: row.behavior === "select" ? "select" : "listbox",
        options: row.options.map(({ label }) => boundedText(label)),
      };
      readback = { kind: "selected", option: null };
      break;
    case "date":
      control = { kind: "date", element: "input" };
      break;
    case "file_upload":
      control = { kind: "file", element: "input" };
      readback = { kind: "upload", resumeId: null, sha256: null };
      break;
  }
  return Object.freeze({
    token: browserTargetToken(`target-${row.fieldId}`),
    name: boundedText(row.fieldLabel),
    required: true,
    control,
    state: { visibility: "visible", enabled: true, actionable: true } as const,
    readback,
  });
});

async function understand(fields: readonly BrowserTargetObservation[] = targets) {
  return createWorkdayPageUnderstanding().understand({
    observation: {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: browserPageId("page-questionnaire"),
      origin: "https://fixture.invalid",
      path: "/questionnaire",
      targets: fields,
    },
  }, signal);
}

function answerRequest(
  field: FieldObservation,
  values: Pick<ApplicationAnswerResolutionRequest, "profileId" | "profileRevision" | "resume" | "resumeArtifact">,
): ApplicationAnswerResolutionRequest {
  return { mode: "live", field, ...values };
}

test("real F4 intake and F5 facts produce ten exact F6 answer intents", async () => {
  let initializationCalls = 0;
  const mutableBytes = Uint8Array.from(resumeBytes);
  const intake = createJourneyIntake(
    { job: contractFixtures.job, resume: contractFixtures.resume, profile: toFrozenApplicantProfile(profile) },
    mutableBytes,
    contractFixtures.journeyState.journeyId,
    async (journeyId): Promise<PortResult<DurableJourneyState, never>> => {
      initializationCalls += 1;
      return {
        ok: true,
        value: { schemaVersion: 3, journeyId, status: "ready", pageId: null, revision: 0 },
      };
    },
  );
  mutableBytes.fill(0);
  const bootstrapped = await intake.bootstrap({
    jobId: contractFixtures.job.jobId,
    resumeId: contractFixtures.resume.resumeId,
    profileId: profile.profileId,
  }, signal);
  assert.equal(initializationCalls, 1);
  assert.equal(bootstrapped.ok, true);
  if (!bootstrapped.ok) assert.fail("real F4 intake rejected valid inputs");

  assert.equal(bootstrapped.value.inputs.job.jobId, contractFixtures.job.jobId);
  assert.equal(bootstrapped.value.inputs.profile.profileId, profile.profileId);
  assert.equal(bootstrapped.value.inputs.profile.revision, profile.revision);
  assert.equal(bootstrapped.value.inputs.resume.resumeId, contractFixtures.resume.resumeId);
  assert.deepEqual(bootstrapped.value.state, {
    schemaVersion: 3,
    journeyId: contractFixtures.journeyState.journeyId,
    status: "ready",
    pageId: null,
    revision: 0,
  });

  const artifact = bootstrapped.value.inputs.resumeArtifact;
  assert.equal(Object.isFrozen(artifact), true);
  assert.deepEqual({
    resumeId: artifact.resumeId,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
  }, {
    resumeId: contractFixtures.resume.resumeId,
    byteLength: resumeBytes.byteLength,
    sha256: contractFixtures.resume.sha256,
  });
  assert.throws(() => {
    (artifact as { sha256: string }).sha256 = "0".repeat(64);
  }, TypeError);

  const understood = await understand();
  assert.equal(understood.ok, true);
  if (!understood.ok || understood.value.kind !== "understood") {
    assert.fail("real F5 did not understand the canonical questionnaire");
  }
  const expectedCatalog = requiredFieldFlowCases.map((row) => ({
    fieldId: row.fieldId,
    label: row.fieldLabel,
    behavior: row.behavior,
    options: row.options.map(({ id, label }) => ({ id, label })),
  })).sort((left, right) => left.fieldId.localeCompare(right.fieldId));
  assert.deepEqual(
    understood.value.snapshot.fields.map(({ fieldId: id, label, behavior, options }) => ({
      fieldId: id,
      label,
      behavior,
      options: options.map(({ id: option, label: text }) => ({ id: option, label: text })),
    })),
    expectedCatalog,
  );
  assert.deepEqual(
    questionCatalog.map(({ id, labels, behavior }) => ({ id, label: labels[0], behavior })),
    requiredFieldFlowCases.map(({ questionId, fieldLabel, behavior }) => ({
      id: questionId,
      label: fieldLabel,
      behavior,
    })),
  );

  const resolver = createAnswerResolver(
    createApplicationProfileQuery(profile),
    "Exact configured interest statement.",
  );
  const requests = {
    profileId: bootstrapped.value.inputs.profile.profileId,
    profileRevision: bootstrapped.value.inputs.profile.revision,
    resume: bootstrapped.value.inputs.resume,
    resumeArtifact: artifact,
  };
  const intents = [];
  for (const field of understood.value.snapshot.fields) {
    const result = await resolver.resolve(answerRequest(field, requests), signal);
    assert.equal(result.ok, true, `${field.fieldId} returned an error`);
    if (!result.ok || result.value.kind !== "resolved") {
      assert.fail(`${field.fieldId} did not resolve`);
    }
    intents.push(result.value.intent);
  }
  assert.deepEqual(intents.map((intent) => {
    switch (intent.kind) {
      case "text":
        return { fieldId: intent.fieldId, kind: intent.kind, behavior: intent.behavior, value: intent.value, provenance: intent.provenance, lane: "live_owner_fact" };
      case "choice":
        return { fieldId: intent.fieldId, kind: intent.kind, behavior: intent.behavior, optionId: intent.optionId, expectedOption: intent.expectedOption, provenance: intent.provenance, lane: "live_owner_fact" };
      case "toggle":
        return { fieldId: intent.fieldId, kind: intent.kind, behavior: intent.behavior, checked: intent.checked, provenance: intent.provenance, lane: "live_owner_fact" };
      case "date":
        return { fieldId: intent.fieldId, kind: intent.kind, behavior: intent.behavior, isoDate: intent.isoDate, provenance: intent.provenance, lane: "live_owner_fact" };
      case "resume_upload":
        return { fieldId: intent.fieldId, kind: intent.kind, behavior: intent.behavior, artifact: intent.artifact, provenance: intent.provenance, lane: "live_owner_fact" };
    }
  }), [
    { fieldId: "s1-field-age-requirement", kind: "toggle", behavior: "checkbox", checked: true, provenance: "owner_provided", lane: "live_owner_fact" },
    { fieldId: "s1-field-country", kind: "choice", behavior: "listbox", optionId: "s1-option-country-ca", expectedOption: "Canada", provenance: "owner_provided", lane: "live_owner_fact" },
    { fieldId: "s1-field-family-name", kind: "text", behavior: "text", value: "Lovelace", provenance: "owner_provided", lane: "live_owner_fact" },
    { fieldId: "s1-field-given-name", kind: "text", behavior: "text", value: "Ada", provenance: "owner_provided", lane: "live_owner_fact" },
    { fieldId: "s1-field-interest", kind: "text", behavior: "textarea", value: "Exact configured interest statement.", provenance: "configured_template", lane: "live_owner_fact" },
    { fieldId: "s1-field-phone-number", kind: "text", behavior: "text", value: "555-0100", provenance: "owner_provided", lane: "live_owner_fact" },
    { fieldId: "s1-field-resume", kind: "resume_upload", behavior: "file_upload", artifact, provenance: "resume_verified", lane: "live_owner_fact" },
    { fieldId: "s1-field-sponsorship", kind: "choice", behavior: "select", optionId: "s1-option-sponsorship-no", expectedOption: "No", provenance: "owner_provided", lane: "live_owner_fact" },
    { fieldId: "s1-field-start-date", kind: "date", behavior: "date", isoDate: "2026-09-01", provenance: "owner_provided", lane: "live_owner_fact" },
    { fieldId: "s1-field-work-authorization", kind: "choice", behavior: "radio", optionId: "s1-option-work-authorization-yes", expectedOption: "Yes", provenance: "owner_provided", lane: "live_owner_fact" },
  ]);

  const upload = await useResumeArtifactUpload(artifact, (bytes) => ({
    ok: true as const,
    value: {
      text: new TextDecoder().decode(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  }));
  assert.deepEqual(upload, {
    ok: true,
    value: { text: "synthetic resume", sha256: contractFixtures.resume.sha256 },
  });
});

test("real F4 intake rejects malformed identity, credentials, persistence failure, and byte mismatch", async () => {
  const frozenProfile = toFrozenApplicantProfile(profile);
  const cases = [
    {
      name: "byte/hash mismatch",
      source: { job: contractFixtures.job, resume: contractFixtures.resume, profile: frozenProfile },
      bytes: new TextEncoder().encode("changed resume"),
      request: { jobId: contractFixtures.job.jobId, resumeId: contractFixtures.resume.resumeId, profileId: profile.profileId },
      error: "artifact_digest_mismatch",
      initializerError: null,
    },
    {
      name: "credential profile",
      source: {
        job: contractFixtures.job,
        resume: contractFixtures.resume,
        profile: {
          profileId: profile.profileId,
          revision: profile.revision,
          facts: [{ factId: "password", value: "synthetic-rejected", provenance: "owner_provided" }],
        },
      },
      bytes: resumeBytes,
      request: { jobId: contractFixtures.job.jobId, resumeId: contractFixtures.resume.resumeId, profileId: profile.profileId },
      error: "journey_input_invalid",
      initializerError: null,
    },
    {
      name: "malformed job identity",
      source: { job: contractFixtures.job, resume: contractFixtures.resume, profile: frozenProfile },
      bytes: resumeBytes,
      request: { jobId: "bad id", resumeId: contractFixtures.resume.resumeId, profileId: profile.profileId },
      error: "journey_input_invalid",
      initializerError: null,
    },
    {
      name: "wrong job identity",
      source: { job: contractFixtures.job, resume: contractFixtures.resume, profile: frozenProfile },
      bytes: resumeBytes,
      request: { jobId: "job-other", resumeId: contractFixtures.resume.resumeId, profileId: profile.profileId },
      error: "journey_input_invalid",
      initializerError: null,
    },
    {
      name: "wrong profile identity",
      source: { job: contractFixtures.job, resume: contractFixtures.resume, profile: frozenProfile },
      bytes: resumeBytes,
      request: { jobId: contractFixtures.job.jobId, resumeId: contractFixtures.resume.resumeId, profileId: "profile-other" },
      error: "journey_input_invalid",
      initializerError: null,
    },
    {
      name: "wrong resume identity",
      source: { job: contractFixtures.job, resume: contractFixtures.resume, profile: frozenProfile },
      bytes: resumeBytes,
      request: { jobId: contractFixtures.job.jobId, resumeId: "resume-other", profileId: profile.profileId },
      error: "resume_identity_mismatch",
      initializerError: null,
    },
    {
      name: "persistence unavailable",
      source: { job: contractFixtures.job, resume: contractFixtures.resume, profile: frozenProfile },
      bytes: resumeBytes,
      request: { jobId: contractFixtures.job.jobId, resumeId: contractFixtures.resume.resumeId, profileId: profile.profileId },
      error: "journey_persistence_unavailable",
      initializerError: { ok: false as const, error: { code: "journey_state_unavailable" as const, retryable: true as const } },
    },
  ] as const;

  for (const entry of cases) {
    let initializerCalls = 0;
    const intake = createJourneyIntake(
      entry.source,
      entry.bytes,
      contractFixtures.journeyState.journeyId,
      async (journeyId) => {
        initializerCalls += 1;
        return entry.initializerError ?? {
          ok: true as const,
          value: { schemaVersion: 3 as const, journeyId, status: "ready" as const, pageId: null, revision: 0 },
        };
      },
    );
    let result: Awaited<ReturnType<typeof intake.bootstrap>> | undefined;
    await assert.doesNotReject(async () => {
      result = await intake.bootstrap(entry.request as never, signal);
    }, entry.name);
    assert.deepEqual(result, {
      ok: false,
      error: {
        code: entry.error,
        retryable: entry.error === "journey_persistence_unavailable",
      },
    }, entry.name);
    assert.equal(initializerCalls, entry.initializerError === null ? 0 : 1, entry.name);
  }
});

test("real F4 errors remain exact while live missing and unmatched answers never become defaults", async () => {
  const understood = await understand();
  if (!understood.ok || understood.value.kind !== "understood") assert.fail("expected facts");
  const fields = new Map(understood.value.snapshot.fields.map((field) => [field.fieldId, field]));
  const artifact = contractFixtures.resumeArtifact;
  const values = {
    profileId: profile.profileId,
    profileRevision: profile.revision,
    resume: contractFixtures.resume,
    resumeArtifact: artifact,
  };

  const exactErrors = [
    { profileId: "bad id", profileRevision: profile.revision, code: "profile_query_invalid", retryable: false },
    { profileId: "profile-missing", profileRevision: profile.revision, code: "profile_missing", retryable: false },
    { profileId: profile.profileId, profileRevision: profile.revision + 1, code: "profile_revision_mismatch", retryable: false },
  ] as const;
  for (const entry of exactErrors) {
    const resolver = createAnswerResolver(createApplicationProfileQuery(profile), "Narrative.");
    let result: Awaited<ReturnType<typeof resolver.resolve>> | undefined;
    await assert.doesNotReject(async () => {
      result = await resolver.resolve(answerRequest(fields.get(fieldId("s1-field-given-name"))!, {
        ...values,
        profileId: entry.profileId as typeof profile.profileId,
        profileRevision: entry.profileRevision,
      }), signal);
    });
    assert.deepEqual(result, { ok: false, error: { code: entry.code, retryable: entry.retryable } });
  }

  const missingProfile = applicantProfileFixture({
    profileId: profile.profileId,
    revision: profile.revision,
    facts: profile.facts.filter(({ factId: fact }) => fact !== "family_name"),
  });
  const missing = createAnswerResolver(createApplicationProfileQuery(missingProfile), "Narrative.");
  assert.deepEqual(
    await missing.resolve(answerRequest(fields.get(fieldId("s1-field-family-name"))!, values), signal),
    {
      ok: true,
      value: { kind: "profile_answer_missing", questionId: "s1-question-family-name" },
    },
  );

  const noMatchProfile = applicantProfileFixture({
    profileId: profile.profileId,
    revision: profile.revision,
    facts: [{ factId: "country", value: "Mexico", provenance: "owner_provided", lane: "live_owner_fact" }],
  });
  const noMatch = createAnswerResolver(createApplicationProfileQuery(noMatchProfile), "Narrative.");
  const noMatchResult = await noMatch.resolve(
    answerRequest(fields.get(fieldId("s1-field-country"))!, values),
    signal,
  );
  assert.equal(noMatchResult.ok && noMatchResult.value.kind, "option_no_match");

  const workAuthorization = fields.get(fieldId("s1-field-work-authorization"))!;
  const ambiguousField = Object.freeze({
    ...workAuthorization,
    options: Object.freeze([
      { id: optionId("s1-option-work-authorization-yes"), label: boundedText("Yes") },
      { id: optionId("s1-option-work-authorization-y"), label: boundedText("Y") },
    ]),
  });
  const ambiguousResult = await createAnswerResolver(
    createApplicationProfileQuery(profile),
    "Narrative.",
  ).resolve(answerRequest(ambiguousField, values), signal);
  assert.deepEqual(ambiguousResult, {
    ok: false,
    error: { code: "protected_answer_denied", retryable: false },
  });

  const unsupportedTarget = Object.freeze({
    ...targets.find(({ token }) => token === "target-s1-field-given-name")!,
    control: { kind: "text" as const, element: "textarea" as const },
  });
  const unsupportedPage = await understand([unsupportedTarget]);
  if (!unsupportedPage.ok || unsupportedPage.value.kind !== "understood") {
    assert.fail("expected real F5 unsupported fact");
  }
  const unsupportedField = unsupportedPage.value.snapshot.fields[0]!;
  assert.equal(unsupportedField.behavior, "unsupported");
  assert.deepEqual(
    await createAnswerResolver(createApplicationProfileQuery(profile), "Narrative.").resolve(
      answerRequest(unsupportedField, values),
      signal,
    ),
    { ok: true, value: { kind: "unsupported", fieldId: "s1-field-given-name" } },
  );
});

test("protected F5 facts reject non-owner provenance without a learning default", async () => {
  const understood = await understand();
  if (!understood.ok || understood.value.kind !== "understood") assert.fail("expected facts");
  const protectedField = understood.value.snapshot.fields.find(
    ({ fieldId: id }) => id === "s1-field-start-date",
  )!;
  const protectedProfile = applicantProfileFixture({
    profileId: profile.profileId,
    revision: profile.revision,
    facts: [{
      factId: "earliest_start_date",
      value: "2026-09-01",
      provenance: "resume_verified",
      lane: "live_owner_fact",
    }],
  } as const);
  const result = await createAnswerResolver(
    createApplicationProfileQuery(protectedProfile),
    "Narrative.",
  ).resolve(answerRequest(protectedField, {
    profileId: protectedProfile.profileId,
    profileRevision: protectedProfile.revision,
    resume: contractFixtures.resume,
    resumeArtifact: contractFixtures.resumeArtifact,
  }), signal);
  assert.deepEqual(result, {
    ok: false,
    error: { code: "protected_answer_denied", retryable: false },
  });
});
