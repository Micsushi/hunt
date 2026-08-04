import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

import type { RealRunAccountMode, RealRunOwnerInputsV1 } from "../live/preflight/types.ts";
import {
  prepareStage2RunStorage,
  type Stage2RunStorageLayout,
  type Stage2StorageProtector,
} from "./private/s2-run-storage.ts";

export interface PrepareStage2LiveRunRequest {
  readonly storageRoot: string;
  readonly targetUrl: string;
  readonly accountMode: RealRunAccountMode;
  readonly now?: string;
}

export async function prepareStage2LiveRun(
  request: PrepareStage2LiveRunRequest,
  protector?: Stage2StorageProtector,
): Promise<Stage2RunStorageLayout> {
  const target = admittedTarget(request.targetUrl);
  if (request.accountMode !== "fresh_create" && request.accountMode !== "sign_in") denied();
  const approvedAt = canonicalTimestamp(request.now ?? new Date().toISOString());
  const expiresAt = new Date(Date.parse(approvedAt) + 30 * 60 * 1_000).toISOString();
  const layout = await prepareStage2RunStorage(
    { storageRoot: request.storageRoot },
    protector,
  );
  const journeyId = opaque("journey");
  const revisionId = opaque("revision");
  const ownerId = opaque("owner");
  const accountSecretHandleId = opaque("secret_handle");
  const gmailHandleId = opaque("secret_handle");
  const owner: RealRunOwnerInputsV1 = {
    schemaVersion: 1,
    contractRevision: "s2-owner-inputs-v1",
    revisionId,
    journeyId,
    accountMode: request.accountMode,
    target: {
      handleId: opaque("target_ref"),
      url: target.url,
      host: target.host,
      tenant: target.tenant,
      posting: target.posting,
    },
    profileRef: opaque("profile_ref"),
    resumeRef: opaque("resume_ref"),
    recipientBindingId: layout.recipientBindingId,
    roots: {
      runtime: root("runtime_root", layout.runtimeRoot),
      secrets: root("secrets_root", layout.secretsRoot),
      evidence: root("evidence_root", layout.evidenceRoot),
    },
    policy: { cleanupLeaseHours: 24, retentionDays: 30 },
    approval: {
      schemaVersion: 1,
      approvalId: opaque("approval"),
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
    denied();
  } finally {
    payload.fill(0);
  }
  return layout;
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
