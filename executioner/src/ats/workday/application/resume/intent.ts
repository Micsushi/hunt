import {
  isResolvedResumeArtifact,
  type PortResult,
  type ResolvedResumeArtifact,
  type ResumeId,
} from "../../../../contracts/index.ts";

export interface WorkdayResumeFileIntent {
  readonly kind: "workday_resume_file";
  readonly variant: "workday_resume_file_upload_v1";
  readonly artifactId: ResumeId;
  readonly artifact: ResolvedResumeArtifact;
  readonly sizeBytes: number;
  readonly fileType: "pdf";
}

export type WorkdayResumeIntentError = {
  readonly code:
    | "artifact_handle_invalid"
    | "resume_identity_mismatch"
    | "resume_file_type_unsupported";
  readonly retryable: false;
};

const intents = new WeakSet<object>();

export function createWorkdayResumeFileIntent(value: {
  readonly artifactId: ResumeId;
  readonly artifact: ResolvedResumeArtifact;
  readonly fileType: "pdf";
}): PortResult<WorkdayResumeFileIntent, WorkdayResumeIntentError> {
  if (!isResolvedResumeArtifact(value?.artifact)) {
    return failure("artifact_handle_invalid");
  }
  if (value.artifactId !== value.artifact.resumeId) {
    return failure("resume_identity_mismatch");
  }
  if (value.fileType !== "pdf") {
    return failure("resume_file_type_unsupported");
  }
  const intent = Object.freeze({
    kind: "workday_resume_file" as const,
    variant: "workday_resume_file_upload_v1" as const,
    artifactId: value.artifactId,
    artifact: value.artifact,
    sizeBytes: value.artifact.byteLength,
    fileType: value.fileType,
  });
  intents.add(intent);
  return {
    ok: true,
    value: intent,
  };
}

export function isWorkdayResumeFileIntent(
  value: unknown,
): value is WorkdayResumeFileIntent {
  return typeof value === "object" && value !== null && intents.has(value);
}

function failure(code: WorkdayResumeIntentError["code"]): {
  readonly ok: false;
  readonly error: WorkdayResumeIntentError;
} {
  return { ok: false, error: { code, retryable: false } };
}
