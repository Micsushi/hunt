import { types as utilTypes } from "node:util";

import {
  captureResumeArtifact,
  disposeResumeArtifact,
  parseDurableJourneyState,
  providerError,
  upstreamJobId,
  upstreamResumeId,
  type CancellationError,
  type DurableJourneyState,
  type JourneyBootstrapRequest,
  type JourneyBootstrapResult,
  type JourneyId,
  type JourneyInputError,
  type JourneyInputs,
  type JourneyIntake,
  type JourneyStateError,
  type PortResult,
} from "../contracts/index.ts";
import { immutableApplicantProfile } from "../profile/profile.ts";

export type JourneyStateInitializer = (
  journeyId: JourneyId,
  signal: AbortSignal,
) => Promise<PortResult<DurableJourneyState, JourneyStateError | CancellationError>>;

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) return undefined;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) return undefined;
    copy[key] = descriptor.value;
  }
  return copy;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validApplyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "";
  } catch {
    return false;
  }
}

function resolveInputs(
  value: unknown,
  bytes: Uint8Array,
): PortResult<JourneyInputs, JourneyInputError> {
  try {
    const source = exactDataRecord(value, ["job", "resume", "profile"]);
    const job = exactDataRecord(source?.job, [
      "jobId",
      "title",
      "company",
      "applyUrl",
    ]);
    const resume = exactDataRecord(source?.resume, ["resumeId", "sha256"]);
    if (
      source === undefined ||
      job === undefined ||
      resume === undefined ||
      !nonEmptyString(job.jobId) ||
      !nonEmptyString(job.title) ||
      !nonEmptyString(job.company) ||
      !nonEmptyString(job.applyUrl) ||
      !validApplyUrl(job.applyUrl) ||
      !nonEmptyString(resume.resumeId) ||
      typeof resume.sha256 !== "string"
    ) {
      return { ok: false, error: providerError("journey_input_invalid") };
    }
    const immutableResume = Object.freeze({
      resumeId: upstreamResumeId(resume.resumeId),
      sha256: resume.sha256,
    });
    const immutableJob = Object.freeze({
      jobId: upstreamJobId(job.jobId),
      title: job.title,
      company: job.company,
      applyUrl: job.applyUrl,
    });
    const immutableProfile = immutableApplicantProfile(source.profile);
    const artifact = captureResumeArtifact(immutableResume, bytes);
    if (!artifact.ok) {
      if (
        artifact.error.code === "artifact_size_invalid" ||
        artifact.error.code === "artifact_digest_mismatch"
      ) return { ok: false, error: artifact.error };
      return { ok: false, error: providerError("journey_input_invalid") };
    }
    return {
      ok: true,
      value: Object.freeze({
        job: immutableJob,
        resume: immutableResume,
        resumeArtifact: artifact.value,
        profile: immutableProfile,
      }),
    };
  } catch {
    return { ok: false, error: providerError("journey_input_invalid") };
  }
}

function validBootstrapRequest(value: unknown): boolean {
  const request = exactDataRecord(value, ["jobId", "resumeId", "profileId"]);
  return request !== undefined &&
    nonEmptyString(request.jobId) &&
    nonEmptyString(request.resumeId) &&
    nonEmptyString(request.profileId) &&
    [request.jobId, request.resumeId, request.profileId].every((identifier) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(identifier)
    );
}

function validInitializedState(
  value: unknown,
  expectedJourneyId: JourneyId,
): value is DurableJourneyState {
  try {
    const state = parseDurableJourneyState(value);
    return state.journeyId === expectedJourneyId;
  } catch {
    return false;
  }
}

export function createJourneyIntake(
  source: unknown,
  bytes: Uint8Array,
  generatedJourneyId: JourneyId,
  initialize: JourneyStateInitializer,
): JourneyIntake {
  const resolved = resolveInputs(source, bytes);
  let successfulBootstrap:
    | Extract<PortResult<JourneyBootstrapResult, JourneyInputError | CancellationError>, { readonly ok: true }>
    | undefined;
  let resumeIdentityInvalidated = false;

  const provider: JourneyIntake = {
    async bootstrap(
      request: JourneyBootstrapRequest,
      signal: AbortSignal,
    ): Promise<PortResult<JourneyBootstrapResult, JourneyInputError | CancellationError>> {
      if (signal.aborted) {
        return { ok: false, error: providerError("operation_cancelled") };
      }
      if (!validBootstrapRequest(request)) {
        return { ok: false, error: providerError("journey_input_invalid") };
      }
      if (!resolved.ok) return resolved;
      if (resumeIdentityInvalidated) {
        return { ok: false, error: providerError("resume_identity_mismatch") };
      }
      if (request.resumeId !== resolved.value.resume.resumeId) {
        disposeResumeArtifact(resolved.value.resumeArtifact);
        resumeIdentityInvalidated = true;
        return { ok: false, error: providerError("resume_identity_mismatch") };
      }
      if (
        request.jobId !== resolved.value.job.jobId ||
        request.profileId !== resolved.value.profile.profileId
      ) {
        return { ok: false, error: providerError("journey_input_invalid") };
      }
      if (successfulBootstrap !== undefined) return successfulBootstrap;

      const initialized = await initialize(generatedJourneyId, signal);
      if (!initialized.ok) {
        if (initialized.error.code === "operation_cancelled") {
          return { ok: false, error: initialized.error };
        }
        return {
          ok: false,
          error: providerError("journey_persistence_unavailable"),
        };
      }
      if (!validInitializedState(initialized.value, generatedJourneyId)) {
        return {
          ok: false,
          error: providerError("journey_persistence_unavailable"),
        };
      }
      successfulBootstrap = {
        ok: true,
        value: Object.freeze({
          journeyId: generatedJourneyId,
          inputs: resolved.value,
          state: initialized.value,
        }),
      };
      return successfulBootstrap;
    },
  };
  return Object.freeze(provider);
}
