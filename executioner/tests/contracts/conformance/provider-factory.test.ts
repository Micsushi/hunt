import assert from "node:assert/strict";
import { test } from "node:test";

import { useResumeArtifactUpload } from "../../../src/contracts/index.ts";

import {
  contractProviderFactories,
  contractFixtures,
  withContractProvider,
} from "../../../src/testing/contracts/index.ts";

test("contract provider factories return fresh providers with isolated state", async () => {
  const factory = contractProviderFactories.ProfileQuery;
  const first = factory.create();
  const second = factory.create();

  assert.notEqual(first.provider, second.provider);
  await first.provider.query(
    {
      profileId: contractFixtures.profile.profileId,
      profileRevision: contractFixtures.profile.revision,
      factId: "given_name",
    },
    new AbortController().signal,
  );
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);

  await first.cleanup();
  await second.cleanup();
});

test("one-use artifact and admission fixtures are fresh on every access", async () => {
  const firstArtifact = contractFixtures.resumeArtifact;
  const secondArtifact = contractFixtures.resumeArtifact;
  assert.notEqual(firstArtifact, secondArtifact);
  assert.equal(
    (await useResumeArtifactUpload(firstArtifact, () => ({ ok: true, value: undefined }))).ok,
    true,
  );
  assert.equal(
    (await useResumeArtifactUpload(secondArtifact, () => ({ ok: true, value: undefined }))).ok,
    true,
  );

  assert.notEqual(contractFixtures.privacyAdmission, contractFixtures.privacyAdmission);
  assert.notEqual(contractFixtures.safetyAdmission, contractFixtures.safetyAdmission);
});

test("separate intake and guard providers never share one-use outputs", async () => {
  const intakeA = contractProviderFactories.JourneyIntake.create();
  const intakeB = contractProviderFactories.JourneyIntake.create();
  const request = {
    jobId: contractFixtures.job.jobId,
    resumeId: contractFixtures.resume.resumeId,
    profileId: contractFixtures.profile.profileId,
  };
  const first = await intakeA.provider.bootstrap(request, new AbortController().signal);
  const second = await intakeB.provider.bootstrap(request, new AbortController().signal);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.value.inputs.resumeArtifact, second.value.inputs.resumeArtifact);
  assert.equal((await useResumeArtifactUpload(first.value.inputs.resumeArtifact, () => ({ ok: true, value: undefined }))).ok, true);
  assert.equal((await useResumeArtifactUpload(second.value.inputs.resumeArtifact, () => ({ ok: true, value: undefined }))).ok, true);

  const privacyA = contractProviderFactories.PrivacyGuard.create();
  const privacyB = contractProviderFactories.PrivacyGuard.create();
  const privacyRequest = {
    binding: {
      journeyId: contractFixtures.privacyAdmission.journeyId,
      attemptId: contractFixtures.privacyAdmission.attemptId,
      guardRevision: contractFixtures.privacyAdmission.guardRevision,
    },
    purpose: "privacy" as const,
    input: { policyRevision: "policy-s1", semanticPayload: { fieldId: "field-given-name" } },
  };
  const admissionA = await privacyA.provider.admit(privacyRequest, new AbortController().signal);
  const admissionB = await privacyB.provider.admit(privacyRequest, new AbortController().signal);
  assert.equal(admissionA.ok, true);
  assert.equal(admissionB.ok, true);
  if (admissionA.ok && admissionB.ok) assert.notEqual(admissionA.value, admissionB.value);
});

test("withContractProvider cleans up after success and failure", async () => {
  let cleanups = 0;
  const factory = {
    name: "ProfileQuery" as const,
    create: () => {
      let cleaned = false;
      return {
        provider: contractProviderFactories.ProfileQuery.create().provider,
        calls: [],
        get cleaned() {
          return cleaned;
        },
        cleanup: () => {
          cleanups += 1;
          cleaned = true;
        },
      };
    },
  };

  await withContractProvider(factory, async () => "ok");
  await assert.rejects(
    () =>
      withContractProvider(factory, async () => {
        throw new Error("deliberate scenario failure");
      }),
    /deliberate scenario failure/u,
  );
  assert.equal(cleanups, 2);
});
