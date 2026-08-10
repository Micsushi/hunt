import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { RealRunAccountMode, RealRunOwnerInputsV1 } from "../live/preflight/types.ts";
import {
  protectStage2StoragePaths,
  prepareStage2RunStorage,
  type Stage2RunStorageLayout,
  type Stage2StorageProtector,
} from "./private/s2-run-storage.ts";

export interface PrepareStage2LiveRunRequest {
  readonly storageRoot: string;
  readonly targetUrl: string;
  readonly accountMode: RealRunAccountMode;
  readonly now?: string;
  readonly applicationSource?: Stage2ApplicationSourceInput;
}

export interface Stage2ApplicationSourceInput {
  readonly resume: {
    readonly resumeId: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly fileType: "pdf";
    readonly bytes: Uint8Array;
  };
  readonly profile: unknown;
  readonly profilePlan: unknown;
  readonly narrative: { readonly revision: string };
}

export async function prepareStage2LiveRun(
  request: PrepareStage2LiveRunRequest,
  protector?: Stage2StorageProtector,
): Promise<Stage2RunStorageLayout> {
  const target = admittedTarget(request.targetUrl);
  if (request.accountMode !== "fresh_create" && request.accountMode !== "sign_in") denied();
  if (request.applicationSource !== undefined && request.now !== undefined) denied();
  const applicationSource = request.applicationSource === undefined
    ? undefined
    : snapshotApplicationSource(request.applicationSource);
  try {
    const layout = await prepareStage2RunStorage(
      { storageRoot: request.storageRoot },
      protector,
    );
  const journeyId = opaque("journey");
  const revisionId = opaque("revision");
  const ownerId = opaque("owner");
  const accountSecretHandleId = opaque("secret_handle");
  const gmailHandleId = opaque("secret_handle");
  const targetHandleId = opaque("target_ref");
  const sourceBinding = {
    approvalId: opaque("approval"),
    profileRef: opaque("profile_ref"),
    resumeRef: opaque("resume_ref"),
  };
  let approvedAt: string;
  try {
    approvedAt = applicationSource === undefined
      ? canonicalTimestamp(request.now ?? new Date().toISOString())
      : await writeApplicationSources({
        layout,
        source: applicationSource,
        protector,
        binding: {
          revisionId,
          approvalId: sourceBinding.approvalId,
          journeyId,
          targetHandleId,
          profileRef: sourceBinding.profileRef,
          resumeRef: sourceBinding.resumeRef,
        },
        clock: () => new Date().toISOString(),
      });
  } catch {
    rmSync(layout.transientRoot, { recursive: true, force: true });
    rmSync(layout.retainedRunRoot, { recursive: true, force: true });
    return denied();
  }
  const expiresAt = new Date(Date.parse(approvedAt) + 30 * 60 * 1_000).toISOString();
  const owner: RealRunOwnerInputsV1 = {
    schemaVersion: 1,
    contractRevision: "s2-owner-inputs-v1",
    revisionId,
    journeyId,
    accountMode: request.accountMode,
    target: {
      handleId: targetHandleId,
      url: target.url,
      host: target.host,
      tenant: target.tenant,
      posting: target.posting,
    },
    profileRef: sourceBinding.profileRef,
    resumeRef: sourceBinding.resumeRef,
    recipientBindingId: layout.recipientBindingId,
    roots: {
      runtime: root("runtime_root", layout.runtimeRoot),
      secrets: root("secrets_root", layout.secretsRoot),
      evidence: root("evidence_root", layout.evidenceRoot),
    },
    policy: { cleanupLeaseHours: 24, retentionDays: 30 },
    approval: {
      schemaVersion: 1,
      approvalId: sourceBinding.approvalId,
      journeyId,
      revisionId,
      approved: true,
      liveAccess: true,
      approvedAt,
      expiresAt,
      ownerId,
      runtimeOperatorId: ownerId,
      secretCustodianId: ownerId,
      evidenceCustodianId: ownerId,
    },
    adapters: {
      secretStore: "windows-dpapi-current-user-v1",
      mailboxProvider: "gmail-api-v1",
    },
    accountSecret: {
      schemaVersion: 1,
      handleId: accountSecretHandleId,
      journeyId,
      provider: "windows-dpapi-current-user-v1",
      purpose: "account_credentials",
      consumer: "credential_mutation_adapter",
      scope: "account_access",
      expiresAt,
    },
    gmailAuthorization: {
      schemaVersion: 1,
      handleId: gmailHandleId,
      journeyId,
      provider: "windows-dpapi-current-user-v1",
      purpose: "gmail_oauth",
      consumer: "gmail_auth_executor",
      scope: "mailbox_verification",
      expiresAt,
    },
  };
  const payload = Buffer.from(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
  try {
    writeFileSync(layout.ownerConfigPath, payload, { flag: "r+" });
  } catch {
    rmSync(layout.transientRoot, { recursive: true, force: true });
    rmSync(layout.retainedRunRoot, { recursive: true, force: true });
    return denied();
  } finally {
    payload.fill(0);
  }
    return layout;
  } finally {
    applicationSource?.resume.bytes.fill(0);
  }
}

async function writeApplicationSources(request: {
  readonly layout: Stage2RunStorageLayout;
  readonly source: Stage2ApplicationSourceInput;
  readonly protector?: Stage2StorageProtector;
  readonly binding: {
    readonly revisionId: string;
    readonly approvalId: string;
    readonly journeyId: string;
    readonly targetHandleId: string;
    readonly profileRef: string;
    readonly resumeRef: string;
  };
  readonly clock: () => string;
}): Promise<string> {
  const profilePath = join(request.layout.runtimeRoot, "application-profile.json");
  const resumePath = join(request.layout.runtimeRoot, "application-resume.pdf");
  const bindingPath = join(request.layout.runtimeRoot, "application-source-binding.json");
  const profilePayload = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    sourceRevision: "s2-application-owner-profile-v1",
    profile: request.source.profile,
    profilePlan: request.source.profilePlan,
    narrative: request.source.narrative,
  })}\n`, "utf8");
  const resumePayload = Buffer.from(request.source.resume.bytes);
  try {
    writePrivateFileAtomic(profilePath, profilePayload);
    writePrivateFileAtomic(resumePath, resumePayload);
    await protectStage2StoragePaths([
      { path: profilePath, directory: false },
      { path: resumePath, directory: false },
    ], request.protector);
    const bindingPayload = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      bindingRevision: "s2-application-owner-source-binding-v1",
      scope: "application_completion",
      ...request.binding,
      profileSha256: createHash("sha256").update(profilePayload).digest("hex"),
      resume: {
        resumeId: request.source.resume.resumeId,
        sha256: request.source.resume.sha256,
        sizeBytes: request.source.resume.sizeBytes,
        fileType: "pdf",
      },
    })}\n`, "utf8");
    try {
      writePrivateFileAtomic(bindingPath, bindingPayload);
      await protectStage2StoragePaths([
        { path: bindingPath, directory: false },
      ], request.protector);
    } finally {
      bindingPayload.fill(0);
    }
    return await approvalAfterSourceFiles(
      [profilePath, resumePath, bindingPath],
      request.clock,
    );
  } finally {
    profilePayload.fill(0);
    resumePayload.fill(0);
  }
}

function writePrivateFileAtomic(path: string, payload: Uint8Array): void {
  const partial = `${path}.partial-${randomBytes(16).toString("hex")}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(partial, "wx", 0o600);
    writeFileSync(descriptor, payload);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(partial, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(partial);
    } catch {
      // The exact run root is removed by the caller on failure.
    }
    throw error;
  }
}

async function approvalAfterSourceFiles(
  paths: readonly string[],
  clock: () => string,
): Promise<string> {
  const latestSourceNs = paths.reduce((latest, path) => {
    const stat = statSync(path, { bigint: true });
    return stat.ctimeNs > latest ? stat.ctimeNs : latest;
  }, 0n);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const candidate = canonicalTimestamp(clock());
    if (BigInt(Date.parse(candidate)) * 1_000_000n >= latestSourceNs) return candidate;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  return denied();
}

function validateApplicationSource(value: Stage2ApplicationSourceInput): void {
  const resume = value?.resume;
  if (
    typeof value !== "object" || value === null ||
    typeof resume !== "object" || resume === null ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(resume.resumeId) ||
    !/^[a-f0-9]{64}$/u.test(resume.sha256) ||
    !Number.isSafeInteger(resume.sizeBytes) || resume.sizeBytes < 1 ||
    resume.sizeBytes > 5 * 1024 * 1024 || resume.fileType !== "pdf" ||
    !(resume.bytes instanceof Uint8Array) || resume.bytes.byteLength !== resume.sizeBytes ||
    Buffer.from(resume.bytes.subarray(0, 5)).toString("ascii") !== "%PDF-" ||
    createHash("sha256").update(resume.bytes).digest("hex") !== resume.sha256 ||
    typeof value.profile !== "object" || value.profile === null ||
    typeof value.profilePlan !== "object" || value.profilePlan === null ||
    typeof value.narrative !== "object" || value.narrative === null ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.narrative.revision)
  ) denied();
}

function snapshotApplicationSource(
  value: Stage2ApplicationSourceInput,
): Stage2ApplicationSourceInput {
  validateApplicationSource(value);
  const profile = structuredClone(value.profile);
  const profilePlan = structuredClone(value.profilePlan);
  const narrative = structuredClone(value.narrative);
  const bytes = Buffer.from(value.resume.bytes);
  const snapshot = Object.freeze({
    resume: Object.freeze({
      resumeId: value.resume.resumeId,
      sha256: value.resume.sha256,
      sizeBytes: value.resume.sizeBytes,
      fileType: value.resume.fileType,
      bytes,
    }),
    profile,
    profilePlan,
    narrative,
  });
  try {
    validateApplicationSource(snapshot);
    return snapshot;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

function admittedTarget(value: string): {
  readonly url: string;
  readonly host: string;
  readonly tenant: string;
  readonly posting: string;
} {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const hostMatch = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.wd\d{1,3}\.myworkdayjobs\.com$/u.exec(host);
    const decodedPath = decodeURIComponent(parsed.pathname);
    const finalSegment = decodedPath.split("/").at(-1) ?? "";
    const posting = /_([A-Za-z0-9-]{2,64})$/u.exec(finalSegment)?.[1];
    if (
      parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
      parsed.port !== "" || parsed.search !== "" || parsed.hash !== "" ||
      parsed.origin + parsed.pathname !== value || hostMatch === null ||
      !decodedPath.includes("/job/") || decodedPath.includes("//") ||
      decodedPath.split("/").includes("..") || posting === undefined
    ) denied();
    return Object.freeze({ url: value, host, tenant: hostMatch[1]!, posting });
  } catch {
    return denied();
  }
}

function root(prefix: "runtime_root" | "secrets_root" | "evidence_root", path: string) {
  return Object.freeze({
    rootId: opaque(prefix),
    path,
    access: "current_user_only" as const,
  });
}

function opaque(prefix: string): `${string}_${string}` {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function canonicalTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) denied();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) denied();
  return value;
}

function denied(): never {
  throw new Error("run preparation denied");
}
