import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  browserTargetToken,
  admitContractSnapshot,
  bindAdmissionRequest,
  consumeBrowserMutationAdmission,
  browserPageId,
  boundedText,
  browserUploadPolicy,
  captureResumeArtifact,
  disposeResumeArtifact,
  upstreamResumeId,
  upstreamJobId,
  upstreamProfileId,
  fieldId,
  generatedOperationId,
  guardRevision,
  useResumeArtifactUpload,
} from "../../src/contracts/index.ts";
import { contractFixtures } from "../../src/testing/contracts/fixtures.ts";
import type {
  AnswerResolutionRequest,
  BrowserMutation,
  DriverRequest,
  FieldIntent,
  JourneyInputs,
} from "../../src/contracts/index.ts";

type PublicContracts = typeof import("../../src/contracts/index.ts");
// @ts-expect-error Raw artifact consumption must not be a public contract API.
type RawArtifactConsumer = PublicContracts["consumeResumeArtifact"];

test("raw resume artifact consumption is not a public contracts API", () => {
  const source = readFileSync(
    new URL("../../src/contracts/resume-artifact.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /export function consumeResumeArtifact\b/u);
});

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("resume resolution privately captures bounded bytes and immutable metadata", async () => {
  const source = Uint8Array.from([1, 2, 3, 4]);
  const result = captureResumeArtifact(
    { resumeId: upstreamResumeId("resume-1"), sha256: digest(source) },
    source,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(result.value.byteLength, 4);
  assert.equal(result.value.sha256, digest(source));
  assert.equal("bytes" in result.value, false);

  source.fill(9);
  let uploadCopy: Uint8Array | undefined;
  const upload = await useResumeArtifactUpload(result.value, (copy) => {
    uploadCopy = copy;
    assert.deepEqual(copy, Uint8Array.from([1, 2, 3, 4]));
    return { ok: true, value: undefined } as const;
  });
  assert.deepEqual(upload, { ok: true, value: undefined });
  assert.deepEqual(uploadCopy, new Uint8Array(4));

  const replay = await useResumeArtifactUpload(result.value, () => {
    assert.fail("a consumed artifact must not reach the upload effect");
  });
  assert.deepEqual(replay, {
    ok: false,
    error: { code: "artifact_already_consumed", retryable: false },
  });
});

test("resume resolution rejects size or digest mismatch before upload", () => {
  assert.deepEqual(
    captureResumeArtifact(
      { resumeId: upstreamResumeId("resume-1"), sha256: "0".repeat(64) },
      Uint8Array.from([1]),
    ),
    {
      ok: false,
      error: { code: "artifact_digest_mismatch", retryable: false },
    },
  );

  assert.deepEqual(
    captureResumeArtifact(
      { resumeId: upstreamResumeId("resume-1"), sha256: digest(new Uint8Array()) },
      new Uint8Array(0),
    ),
    {
      ok: false,
      error: { code: "artifact_size_invalid", retryable: false },
    },
  );
});

test("browser upload carries only the opaque artifact handle", () => {
  const bytes = Uint8Array.from([1, 2, 3]);
  const captured = captureResumeArtifact(
    { resumeId: upstreamResumeId("resume-2"), sha256: digest(bytes) },
    bytes,
  );
  assert.equal(captured.ok, true);
  if (!captured.ok) return;

  const mutation = {
    kind: "upload",
    target: browserTargetToken("target-resume"),
    artifact: captured.value,
  } satisfies BrowserMutation;
  assert.equal("resumeId" in mutation, false);
  assert.deepEqual(browserUploadPolicy, {
    consumeHandle: true,
    verifyFreshCopyDigestBeforeSideEffect: true,
  });
});

test("the exact owner-preserving artifact handle reaches the upload mutation", () => {
  const bytes = Uint8Array.from([4, 5, 6]);
  const selection = { resumeId: upstreamResumeId("resume-route"), sha256: digest(bytes) };
  const captured = captureResumeArtifact(selection, bytes);
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  const inputs = {
    job: { jobId: upstreamJobId("job-route"), title: "Role", company: "Company", applyUrl: "https://fixture.invalid" },
    resume: selection,
    resumeArtifact: captured.value,
    profile: { profileId: upstreamProfileId("profile-route"), revision: 1, facts: [] },
  } satisfies JourneyInputs;
  const answer = {
    field: {
      fieldId: fieldId("resume-field"), target: browserTargetToken("resume-target"),
      label: boundedText("Resume"), required: true, behavior: "file_upload", options: [], state: "empty",
    },
    profileId: inputs.profile.profileId,
    profileRevision: inputs.profile.revision,
    resume: inputs.resume,
    resumeArtifact: inputs.resumeArtifact,
  } satisfies AnswerResolutionRequest;
  const intent = {
    kind: "resume_upload", behavior: "file_upload", fieldId: answer.field.fieldId,
    target: answer.field.target, artifact: answer.resumeArtifact, provenance: "resume_verified",
  } satisfies FieldIntent;
  const driver = {
    journeyId: contractFixtures.journeyState.journeyId,
    sessionId: "browser_session_0123456789abcdef" as DriverRequest["sessionId"],
    pageId: browserPageId("page-route"),
    guardRevision: guardRevision("guard-upload-route"),
    operationId: generatedOperationId("operation_abcdef0123456789"),
    intent,
  } satisfies DriverRequest;
  const mutation = { kind: "upload", target: driver.intent.target, artifact: driver.intent.artifact } satisfies BrowserMutation;

  assert.equal(mutation.artifact, captured.value);
  assert.deepEqual(Object.keys(mutation.artifact).sort(), ["byteLength", "resumeId", "sha256"]);
  assert.equal("bytes" in mutation.artifact, false);
  assert.equal("path" in mutation.artifact, false);
});

test("safety admission preserves the verified upload handle identity", async () => {
  const bytes = Uint8Array.from([7, 8, 9]);
  const captured = captureResumeArtifact(
    { resumeId: upstreamResumeId("resume-admitted"), sha256: digest(bytes) },
    bytes,
  );
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  const operation = generatedOperationId("operation_a1a1a1a1a1a1a1a1");
  const revision = guardRevision("guard-upload");
  const admitted = admitContractSnapshot(
    {
      policyRevision: revision,
      capability: "field_mutation",
      effect: {
        kind: "browser_mutation",
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        operationId: operation,
        mutation: { kind: "upload", target: browserTargetToken("target-upload"), artifact: captured.value },
      },
    },
    "safety",
    {
      journeyId: contractFixtures.journeyState.journeyId,
      attemptId: operation,
      guardRevision: revision,
    },
  );
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  const consumed = consumeBrowserMutationAdmission(bindAdmissionRequest(admitted.value));
  assert.equal(consumed.ok, true);
  if (!consumed.ok) return;
  assert.equal(consumed.value.effect.mutation.kind, "upload");
  if (consumed.value.effect.mutation.kind !== "upload") return;
  assert.equal(consumed.value.effect.mutation.artifact, captured.value);
  assert.deepEqual(
    await useResumeArtifactUpload(
      consumed.value.effect.mutation.artifact,
      () => ({ ok: true, value: "uploaded" } as const),
    ),
    { ok: true, value: "uploaded" },
  );
});

test("artifact disposal covers cancel/failure and upload copies are always zeroed", async () => {
  const capture = (id: string) => {
    const bytes = Uint8Array.from([1, 3, 5]);
    return captureResumeArtifact(
      { resumeId: upstreamResumeId(id), sha256: digest(bytes) },
      bytes,
    );
  };

  for (const id of ["resume-cancel", "resume-failure"]) {
    const captured = capture(id);
    assert.equal(captured.ok, true);
    if (!captured.ok) continue;
    assert.deepEqual(disposeResumeArtifact(captured.value), { ok: true, value: undefined });
    assert.deepEqual(await useResumeArtifactUpload(captured.value, () => {
      assert.fail("a disposed artifact must not reach the upload effect");
    }), {
      ok: false,
      error: { code: "artifact_already_consumed", retryable: false },
    });
  }

  const success = capture("resume-success");
  assert.equal(success.ok, true);
  if (!success.ok) return;
  let successCopy: Uint8Array | undefined;
  assert.deepEqual(
    await useResumeArtifactUpload(success.value, (copy) => {
      successCopy = copy;
      return { ok: true, value: "uploaded" } as const;
    }),
    { ok: true, value: "uploaded" },
  );
  assert.deepEqual(successCopy, new Uint8Array(3));

  const failed = capture("resume-error");
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  let errorCopy: Uint8Array | undefined;
  assert.deepEqual(
    await useResumeArtifactUpload(failed.value, (copy) => {
      errorCopy = copy;
      return { ok: false, error: { code: "browser_effect_uncertain", retryable: false } } as const;
    }),
    { ok: false, error: { code: "browser_effect_uncertain", retryable: false } },
  );
  assert.deepEqual(errorCopy, new Uint8Array(3));

  const thrown = capture("resume-throw");
  assert.equal(thrown.ok, true);
  if (!thrown.ok) return;
  let thrownCopy: Uint8Array | undefined;
  await assert.rejects(() => useResumeArtifactUpload(thrown.value, (copy) => {
    thrownCopy = copy;
    throw new Error("side effect threw");
  }), /side effect threw/u);
  assert.deepEqual(thrownCopy, new Uint8Array(3));
});
