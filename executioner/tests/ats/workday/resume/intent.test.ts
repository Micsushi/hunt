import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  captureResumeArtifact,
  upstreamResumeId,
} from "../../../../src/contracts/index.ts";
import {
  createWorkdayResumeFileIntent,
} from "../../../../src/ats/workday/application/resume/index.ts";

test("binds one immutable PDF intent to the exact captured resume artifact", () => {
  const bytes = new TextEncoder().encode("synthetic resume");
  const resumeId = upstreamResumeId("resume_0123456789abcdef");
  const captured = captureResumeArtifact({
    resumeId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, bytes);
  assert.equal(captured.ok, true);
  if (!captured.ok) return;

  const intent = createWorkdayResumeFileIntent({
    artifactId: resumeId,
    artifact: captured.value,
    fileType: "pdf",
  });

  assert.equal(intent.ok, true);
  if (!intent.ok) return;
  assert.equal(intent.value.artifact, captured.value);
  assert.deepEqual(intent.value, {
    kind: "workday_resume_file",
    variant: "workday_resume_file_upload_v1",
    artifactId: resumeId,
    artifact: captured.value,
    sizeBytes: bytes.byteLength,
    fileType: "pdf",
  });
  assert.equal(Object.isFrozen(intent.value), true);
});

test("rejects a resume identity mismatch", () => {
  const bytes = new TextEncoder().encode("synthetic resume");
  const captured = captureResumeArtifact({
    resumeId: upstreamResumeId("resume_0123456789abcdef"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, bytes);
  assert.equal(captured.ok, true);
  if (!captured.ok) return;

  assert.deepEqual(createWorkdayResumeFileIntent({
    artifactId: upstreamResumeId("resume_fedcba9876543210"),
    artifact: captured.value,
    fileType: "pdf",
  }), {
    ok: false,
    error: { code: "resume_identity_mismatch", retryable: false },
  });
});
