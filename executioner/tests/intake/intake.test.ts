import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  journeyId,
  providerError,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
  useResumeArtifactUpload,
  type DurableJourneyState,
  type JourneyBootstrapRequest,
} from "../../src/contracts/index.ts";
import {
  createJourneyIntake,
  type JourneyStateInitializer,
} from "../../src/intake/intake.ts";

const bytes = new TextEncoder().encode("synthetic resume");
const digest = createHash("sha256").update(bytes).digest("hex");
const source = {
  job: {
    jobId: "job-1",
    title: "Engineer",
    company: "Example",
    applyUrl: "https://example.invalid/apply",
  },
  resume: { resumeId: "resume-1", sha256: digest },
  profile: {
    profileId: "profile-1",
    revision: 1,
    facts: [],
  },
} as const;
const generatedId = journeyId("journey_0123456789abcdef");
const request = {
  jobId: upstreamJobId("job-1"),
  resumeId: upstreamResumeId("resume-1"),
  profileId: upstreamProfileId("profile-1"),
} as const;

function readyState(): DurableJourneyState {
  return Object.freeze({
    schemaVersion: 3,
    journeyId: generatedId,
    status: "ready",
    pageId: null,
    revision: 0,
  });
}

test("intake uses an injected journey ID and memoizes successful persistence", async () => {
  let initializations = 0;
  const initialize: JourneyStateInitializer = async (candidate, signal) => {
    initializations += 1;
    assert.equal(candidate, generatedId);
    assert.equal(signal.aborted, false);
    return { ok: true, value: readyState() };
  };
  const mutable = structuredClone(source);
  const mutableBytes = Uint8Array.from(bytes);
  const intake = createJourneyIntake(mutable, mutableBytes, generatedId, initialize);
  (mutable.job as { title: string }).title = "changed";
  mutableBytes.fill(0);

  const first = await intake.bootstrap(request, new AbortController().signal);
  const replay = await intake.bootstrap(request, new AbortController().signal);

  assert.deepEqual(replay, first);
  assert.equal(initializations, 1);
  assert.equal(first.ok && first.value.journeyId, generatedId);
  assert.equal(first.ok && first.value.inputs.job.title, "Engineer");
  if (!first.ok) assert.fail("expected a successful bootstrap");
  assert.equal(first.value.inputs.resumeArtifact.resumeId, request.resumeId);
  assert.ok(Object.isFrozen(first.value.inputs));
  const upload = await useResumeArtifactUpload(
    first.value.inputs.resumeArtifact,
    (captured) => ({ ok: true, value: new TextDecoder().decode(captured) }),
  );
  assert.deepEqual(upload, { ok: true, value: "synthetic resume" });
});

test("intake rejects malformed and mismatched requests without persistence", async () => {
  let initializations = 0;
  const intake = createJourneyIntake(source, bytes, generatedId, async () => {
    initializations += 1;
    return { ok: true, value: readyState() };
  });
  const invalid = { ok: false, error: providerError("journey_input_invalid") } as const;

  assert.deepEqual(
    await intake.bootstrap(null as unknown as JourneyBootstrapRequest, new AbortController().signal),
    invalid,
  );
  assert.deepEqual(await intake.bootstrap({
    ...request,
    extra: "forbidden",
  } as unknown as JourneyBootstrapRequest, new AbortController().signal), invalid);
  assert.deepEqual(await intake.bootstrap({
    ...request,
    jobId: upstreamJobId("job-other"),
  }, new AbortController().signal), invalid);
  assert.deepEqual(await intake.bootstrap(request, AbortSignal.abort()), {
    ok: false,
    error: providerError("operation_cancelled"),
  });
  assert.deepEqual(await intake.bootstrap({
    ...request,
    resumeId: upstreamResumeId("resume-other"),
  }, new AbortController().signal), {
    ok: false,
    error: providerError("resume_identity_mismatch"),
  });
  assert.deepEqual(await intake.bootstrap(request, new AbortController().signal), {
    ok: false,
    error: providerError("resume_identity_mismatch"),
  });
  assert.equal(initializations, 0);
});

test("intake returns artifact and source validation failures as closed port errors", async () => {
  let initializations = 0;
  const initialize: JourneyStateInitializer = async () => {
    initializations += 1;
    return { ok: true, value: readyState() };
  };
  const malformed = createJourneyIntake({
    ...source,
    job: { ...source.job, applyUrl: "file:///private/resume" },
  }, bytes, generatedId, initialize);
  const digestMismatch = createJourneyIntake({
    ...source,
    resume: { ...source.resume, sha256: "0".repeat(64) },
  }, bytes, generatedId, initialize);
  const empty = createJourneyIntake(source, new Uint8Array(), generatedId, initialize);

  assert.deepEqual(await malformed.bootstrap(request, new AbortController().signal), {
    ok: false,
    error: providerError("journey_input_invalid"),
  });
  assert.deepEqual(await digestMismatch.bootstrap(request, new AbortController().signal), {
    ok: false,
    error: providerError("artifact_digest_mismatch"),
  });
  assert.deepEqual(await empty.bootstrap(request, new AbortController().signal), {
    ok: false,
    error: providerError("artifact_size_invalid"),
  });
  assert.equal(initializations, 0);
});

test("intake maps factual persistence failure and cancellation outcomes", async () => {
  const unavailable = createJourneyIntake(source, bytes, generatedId, async () => ({
    ok: false,
    error: providerError("journey_state_unavailable"),
  }));
  const cancelled = createJourneyIntake(source, bytes, generatedId, async () => ({
    ok: false,
    error: providerError("operation_cancelled"),
  }));

  assert.deepEqual(await unavailable.bootstrap(request, new AbortController().signal), {
    ok: false,
    error: providerError("journey_persistence_unavailable"),
  });
  assert.deepEqual(await cancelled.bootstrap(request, new AbortController().signal), {
    ok: false,
    error: providerError("operation_cancelled"),
  });
});
