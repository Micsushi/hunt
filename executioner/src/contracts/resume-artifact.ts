import { createHash, timingSafeEqual } from "node:crypto";

import type { PortResult, ResumeId } from "./types.ts";

export const MAX_RESUME_ARTIFACT_BYTES = 5 * 1024 * 1024;

declare const resolvedResumeArtifactBrand: unique symbol;

export interface ResolvedResumeArtifact {
  readonly [resolvedResumeArtifactBrand]: true;
  readonly resumeId: ResumeId;
  readonly byteLength: number;
  readonly sha256: string;
}

export type ResumeArtifactError =
  | { readonly code: "artifact_size_invalid"; readonly retryable: false }
  | { readonly code: "artifact_digest_mismatch"; readonly retryable: false }
  | { readonly code: "artifact_changed"; readonly retryable: false }
  | { readonly code: "artifact_already_consumed"; readonly retryable: false }
  | { readonly code: "artifact_handle_invalid"; readonly retryable: false };

interface PrivateArtifact {
  readonly bytes: Uint8Array;
  readonly digest: Uint8Array;
  consumed: boolean;
}

const artifacts = new WeakMap<object, PrivateArtifact>();

export function isResolvedResumeArtifact(
  value: unknown,
): value is ResolvedResumeArtifact {
  return typeof value === "object" && value !== null && artifacts.has(value);
}

function digestBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function digestHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function captureResumeArtifact(
  selection: { readonly resumeId: ResumeId; readonly sha256: string },
  source: Uint8Array,
): PortResult<ResolvedResumeArtifact, ResumeArtifactError> {
  if (source.byteLength === 0 || source.byteLength > MAX_RESUME_ARTIFACT_BYTES) {
    return {
      ok: false,
      error: { code: "artifact_size_invalid", retryable: false },
    };
  }

  const captured = Uint8Array.from(source);
  const digest = digestBytes(captured);
  if (
    !/^[a-f0-9]{64}$/u.test(selection.sha256) ||
    !timingSafeEqual(digest, Buffer.from(selection.sha256, "hex"))
  ) {
    captured.fill(0);
    return {
      ok: false,
      error: { code: "artifact_digest_mismatch", retryable: false },
    };
  }

  const handle = Object.freeze({
    resumeId: selection.resumeId,
    byteLength: captured.byteLength,
    sha256: digestHex(digest),
  }) as ResolvedResumeArtifact;
  artifacts.set(handle, { bytes: captured, digest, consumed: false });
  return { ok: true, value: handle };
}

function consumeResumeArtifact(
  handle: ResolvedResumeArtifact,
): PortResult<Uint8Array, ResumeArtifactError> {
  const artifact = artifacts.get(handle);
  if (artifact === undefined) {
    return {
      ok: false,
      error: { code: "artifact_handle_invalid", retryable: false },
    };
  }
  if (artifact.consumed) {
    return {
      ok: false,
      error: { code: "artifact_already_consumed", retryable: false },
    };
  }

  artifact.consumed = true;
  const currentDigest = digestBytes(artifact.bytes);
  if (!timingSafeEqual(currentDigest, artifact.digest)) {
    artifact.bytes.fill(0);
    return {
      ok: false,
      error: { code: "artifact_changed", retryable: false },
    };
  }

  const upload = Uint8Array.from(artifact.bytes);
  artifact.bytes.fill(0);
  return { ok: true, value: upload };
}

export function disposeResumeArtifact(
  handle: ResolvedResumeArtifact,
): PortResult<void, Extract<ResumeArtifactError, { readonly code: "artifact_handle_invalid" }>> {
  const artifact = artifacts.get(handle);
  if (artifact === undefined) {
    return {
      ok: false,
      error: { code: "artifact_handle_invalid", retryable: false },
    };
  }
  artifact.bytes.fill(0);
  artifact.consumed = true;
  return { ok: true, value: undefined };
}

export async function useResumeArtifactUpload<T, E>(
  handle: ResolvedResumeArtifact,
  effect: (upload: Uint8Array) => Promise<PortResult<T, E>> | PortResult<T, E>,
): Promise<PortResult<T, E | ResumeArtifactError>> {
  const upload = consumeResumeArtifact(handle);
  if (!upload.ok) return upload;
  try {
    return await effect(upload.value);
  } finally {
    upload.value.fill(0);
  }
}
