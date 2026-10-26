import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  generatedOperationId,
  type DurableJourneyState,
} from "../../../../src/contracts/index.ts";
import { createJourneyIntake } from "../../../../src/intake/intake.ts";
import { FileJourneyStateStore } from "../../../../src/journey/state-store.ts";
import { createProfileQuery } from "../../../../src/profile/profile.ts";
import {
  assertProviderConformance,
  contractFixtures,
} from "../../../../src/testing/contracts/index.ts";

test("F4 real providers satisfy the R2.n port conformance kit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hunt-f4-acceptance-"));
  t.after(() => rm(directory, { force: true, recursive: true }));

  const intakeStore = new FileJourneyStateStore(join(directory, "intake"));
  const intake = createJourneyIntake(
    {
      job: contractFixtures.job,
      resume: contractFixtures.resume,
      profile: contractFixtures.profile,
    },
    new TextEncoder().encode("synthetic resume"),
    contractFixtures.journeyState.journeyId,
    intakeStore.initialize.bind(intakeStore),
  );
  await assertProviderConformance("JourneyIntake", intake);
  await assertProviderConformance(
    "ProfileQuery",
    createProfileQuery(contractFixtures.profile),
  );

  const stateStore = new FileJourneyStateStore(join(directory, "state"));
  const initialized = await stateStore.initialize(
    contractFixtures.journeyState.journeyId,
    new AbortController().signal,
  );
  assert.equal(initialized.ok, true);
  const prepared = await stateStore.transition({
    journeyId: contractFixtures.journeyState.journeyId,
    operationId: generatedOperationId("operation_fedcba9876543210"),
    expectedRevision: 0,
    status: "running",
    pageId: contractFixtures.journeyState.pageId,
  }, new AbortController().signal);
  assert.deepEqual(
    prepared.ok ? prepared.value.state : null,
    contractFixtures.journeyState,
  );
  await assertProviderConformance("JourneyStateStore", stateStore);
});

test("F4 reload preserves current state without persisting applicant inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hunt-f4-reload-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const store = new FileJourneyStateStore(directory);
  const source = {
    job: contractFixtures.job,
    resume: contractFixtures.resume,
    profile: contractFixtures.profile,
  };
  const bytes = new TextEncoder().encode("synthetic resume");
  const first = createJourneyIntake(
    source,
    bytes,
    contractFixtures.journeyState.journeyId,
    store.initialize.bind(store),
  );
  const request = {
    jobId: contractFixtures.job.jobId,
    resumeId: contractFixtures.resume.resumeId,
    profileId: contractFixtures.profile.profileId,
  } as const;
  const bootstrapped = await first.bootstrap(request, new AbortController().signal);
  assert.equal(bootstrapped.ok, true);
  const running = await store.transition({
    journeyId: contractFixtures.journeyState.journeyId,
    operationId: generatedOperationId("operation_fedcba9876543210"),
    expectedRevision: 0,
    status: "running",
    pageId: contractFixtures.journeyState.pageId,
  }, new AbortController().signal);
  assert.equal(running.ok, true);

  const reopenedStore = new FileJourneyStateStore(directory);
  const reopened = createJourneyIntake(
    source,
    bytes,
    contractFixtures.journeyState.journeyId,
    reopenedStore.initialize.bind(reopenedStore),
  );
  const replay = await reopened.bootstrap(request, new AbortController().signal);
  assert.deepEqual(
    replay.ok ? replay.value.state : null,
    running.ok ? running.value.state : null,
  );

  const [filename] = await readdir(directory);
  assert.ok(filename);
  const durableText = await readFile(join(directory, filename), "utf8");
  for (const forbidden of [
    contractFixtures.job.title,
    contractFixtures.job.company,
    contractFixtures.job.applyUrl,
    contractFixtures.resume.resumeId,
    contractFixtures.resume.sha256,
    contractFixtures.profile.profileId,
    "Synthetic",
    "synthetic resume",
  ]) {
    assert.equal(durableText.includes(forbidden), false, `persisted private input: ${forbidden}`);
  }
  const persisted = JSON.parse(durableText) as {
    storageVersion: number;
    state: DurableJourneyState;
    operations: Record<string, unknown>;
  };
  assert.equal(persisted.storageVersion, 1);
  assert.deepEqual(Object.keys(persisted).sort(), [
    "operations",
    "state",
    "storageVersion",
  ]);
});
