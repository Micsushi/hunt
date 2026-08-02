import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  normalize,
  relative,
  resolve,
} from "node:path";

import type {
  ExternalRootV1,
  PreflightContext,
  PreflightFailureCode,
  RealRunOwnerInputsV1,
  RealRunPreflightResult,
  ScopedSecretReferenceV1,
} from "./types.ts";

type UnknownRecord = Readonly<Record<string, unknown>>;
type RootName = "runtime" | "secrets" | "evidence";

const topKeys = [
  "schemaVersion",
  "contractRevision",
  "revisionId",
  "journeyId",
  "accountMode",
  "target",
  "profileRef",
  "resumeRef",
  "recipientBindingId",
  "roots",
  "policy",
  "approval",
  "adapters",
  "accountSecret",
  "gmailAuthorization",
] as const;

const targetKeys = ["handleId", "url", "host", "tenant", "posting"] as const;
const rootKeys = ["rootId", "path", "access"] as const;
const approvalKeys = [
  "schemaVersion",
  "approvalId",
  "journeyId",
  "revisionId",
  "approved",
  "liveAccess",
  "approvedAt",
  "expiresAt",
  "ownerId",
  "runtimeOperatorId",
  "secretCustodianId",
  "evidenceCustodianId",
] as const;
const secretKeys = [
  "schemaVersion",
  "handleId",
  "journeyId",
  "provider",
  "purpose",
  "consumer",
  "scope",
  "expiresAt",
] as const;

const opaquePatterns = {
  journey: /^journey_[A-Za-z0-9_-]{16,64}$/u,
  revision: /^revision_[A-Za-z0-9_-]{16,64}$/u,
  approval: /^approval_[A-Za-z0-9_-]{16,64}$/u,
  owner: /^owner_[A-Za-z0-9_-]{16,64}$/u,
  target: /^target_ref_[A-Za-z0-9_-]{16,64}$/u,
  profile: /^profile_ref_[A-Za-z0-9_-]{16,64}$/u,
  resume: /^resume_ref_[A-Za-z0-9_-]{16,64}$/u,
  recipient: /^recipient_[A-Za-z0-9_-]{16,64}$/u,
  secret: /^secret_handle_[A-Za-z0-9_-]{16,64}$/u,
  runtimeRoot: /^runtime_root_[A-Za-z0-9_-]{16,64}$/u,
  secretsRoot: /^secrets_root_[A-Za-z0-9_-]{16,64}$/u,
  evidenceRoot: /^evidence_root_[A-Za-z0-9_-]{16,64}$/u,
} as const;

export interface GmailGrantRevocationOwnerV1 {
  readonly schemaVersion: 1;
  readonly kind: "gmail_refresh_grant_revocation_owner";
  readonly revisionId: string;
  readonly journeyId: string;
  readonly recipientBindingId: string;
  readonly targetHandleId: string;
  readonly rootPaths: {
    readonly runtime: string;
    readonly secrets: string;
    readonly evidence: string;
  };
  readonly gmailHandleId: string;
}

export type GmailGrantRevocationOwnerResult =
  | { readonly ok: true; readonly value: GmailGrantRevocationOwnerV1 }
  | Extract<RealRunPreflightResult, { readonly ok: false }>;

export function admitRealRunPreflight(
  value: unknown,
  context: PreflightContext,
): RealRunPreflightResult {
  const input = record(value, topKeys);
  if (input === null || input.schemaVersion !== 1) {
    return failure("owner_config_invalid", "schema");
  }
  if (
    input.contractRevision !== "s2-owner-inputs-v1" ||
    !matches(input.revisionId, opaquePatterns.revision) ||
    !matches(input.journeyId, opaquePatterns.journey)
  ) {
    return failure("owner_config_invalid", "revision");
  }
  if (input.accountMode !== "fresh_create" && input.accountMode !== "sign_in") {
    return failure("owner_config_invalid", "account");
  }

  const target = record(input.target, targetKeys);
  if (target === null || !validTarget(target)) {
    return failure("owner_config_invalid", "target");
  }
  if (!matches(input.profileRef, opaquePatterns.profile)) {
    return failure("owner_config_invalid", "profile");
  }
  if (!matches(input.resumeRef, opaquePatterns.resume)) {
    return failure("owner_config_invalid", "resume");
  }
  if (!matches(input.recipientBindingId, opaquePatterns.recipient)) {
    return failure("owner_config_invalid", "recipient");
  }

  const rootsRecord = record(input.roots, ["runtime", "secrets", "evidence"]);
  if (rootsRecord === null) {
    return failure("owner_config_invalid", "roots");
  }
  const rootRecords = {
    runtime: parseRoot(rootsRecord.runtime, opaquePatterns.runtimeRoot),
    secrets: parseRoot(rootsRecord.secrets, opaquePatterns.secretsRoot),
    evidence: parseRoot(rootsRecord.evidence, opaquePatterns.evidenceRoot),
  };
  for (const name of ["runtime", "secrets", "evidence"] as const) {
    if (rootRecords[name] === null) {
      return failure(rootCode(name), "schema");
    }
  }
  const roots = rootRecords as Readonly<Record<RootName, ExternalRootV1>>;
  const rootResult = validateRoots(roots, context.forbiddenRoots);
  if (rootResult !== null) {
    return rootResult;
  }

  const policy = record(input.policy, ["cleanupLeaseHours", "retentionDays"]);
  if (
    policy === null ||
    policy.cleanupLeaseHours !== 24 ||
    policy.retentionDays !== 30
  ) {
    return failure("owner_config_invalid", "retention");
  }

  const adapters = record(input.adapters, ["secretStore", "mailboxProvider"]);
  if (adapters === null || adapters.secretStore !== "windows-dpapi-current-user-v1") {
    return failure("owner_config_invalid", "secret_backend");
  }
  if (adapters.mailboxProvider !== "gmail-api-v1") {
    return failure("owner_config_invalid", "mailbox_provider");
  }

  const approval = record(input.approval, approvalKeys);
  const now = parseTimestamp(context.now);
  if (
    approval === null ||
    now === null ||
    !validApproval(approval, input.journeyId, input.revisionId, now)
  ) {
    return failure("owner_config_invalid", "approval");
  }

  const accountSecret = record(input.accountSecret, secretKeys);
  if (
    accountSecret === null ||
    !validSecret(
      accountSecret,
      input.journeyId,
      now,
      approval.expiresAt as string,
      "account_credentials",
      "credential_mutation_adapter",
      "account_access",
    )
  ) {
    return failure("owner_config_invalid", "account_secret");
  }
  const gmailAuthorization = record(input.gmailAuthorization, secretKeys);
  if (
    gmailAuthorization === null ||
    !validSecret(
      gmailAuthorization,
      input.journeyId,
      now,
      approval.expiresAt as string,
      "gmail_oauth",
      "gmail_auth_executor",
      "mailbox_verification",
    ) ||
    gmailAuthorization.handleId === accountSecret.handleId
  ) {
    return failure("owner_config_invalid", "gmail_authorization");
  }

  const admitted = input as unknown as RealRunOwnerInputsV1;
  return {
    ok: true,
    report: {
      schemaVersion: 1,
      kind: "ready",
      contractRevision: "s2-owner-inputs-v1",
      revisionId: admitted.revisionId,
      journeyId: admitted.journeyId,
      accountMode: admitted.accountMode,
      approvalId: admitted.approval.approvalId,
      targetHandleId: admitted.target.handleId,
      profileRef: admitted.profileRef,
      resumeRef: admitted.resumeRef,
      recipientBindingId: admitted.recipientBindingId,
      rootIds: {
        runtime: admitted.roots.runtime.rootId,
        secrets: admitted.roots.secrets.rootId,
        evidence: admitted.roots.evidence.rootId,
      },
      secretHandleIds: {
        account: admitted.accountSecret.handleId,
        gmail: admitted.gmailAuthorization.handleId,
      },
      adapters: admitted.adapters,
      cleanupLeaseHours: 24,
      retentionDays: 30,
      approvedTargetDimensions: ["host", "tenant", "posting"],
    },
  };
}

export function admitGmailGrantRevocationOwner(
  value: unknown,
  context: PreflightContext,
): GmailGrantRevocationOwnerResult {
  const input = record(value, topKeys);
  if (input === null || input.schemaVersion !== 1) {
    return failure("owner_config_invalid", "schema");
  }
  const approval = record(input.approval, approvalKeys);
  const now = parseTimestamp(context.now);
  const approvedAtValue = approval?.approvedAt;
  const approvedAt = parseTimestamp(approvedAtValue);
  if (
    typeof approvedAtValue !== "string" ||
    now === null ||
    approvedAt === null ||
    approvedAt > now
  ) {
    return failure("owner_config_invalid", "approval");
  }
  const historical = admitRealRunPreflight(value, {
    ...context,
    now: approvedAtValue,
  });
  if (!historical.ok) return historical;
  const owner = value as RealRunOwnerInputsV1;

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      kind: "gmail_refresh_grant_revocation_owner",
      revisionId: owner.revisionId,
      journeyId: owner.journeyId,
      recipientBindingId: owner.recipientBindingId,
      targetHandleId: owner.target.handleId,
      rootPaths: Object.freeze({
        runtime: owner.roots.runtime.path,
        secrets: owner.roots.secrets.path,
        evidence: owner.roots.evidence.path,
      }),
      gmailHandleId: owner.gmailAuthorization.handleId,
    }),
  });
}

function validTarget(target: UnknownRecord): boolean {
  if (
    !matches(target.handleId, opaquePatterns.target) ||
    typeof target.url !== "string" ||
    typeof target.host !== "string" ||
    typeof target.tenant !== "string" ||
    typeof target.posting !== "string"
  ) {
    return false;
  }
  try {
    const parsed = new URL(target.url);
    const host = parsed.hostname.toLowerCase();
    const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.wd\d{1,2}\.myworkdayjobs\.(?:com|invalid)$/u.exec(host);
    const decodedPath = decodeURIComponent(parsed.pathname);
    const finalSegment = decodedPath.split("/").at(-1) ?? "";
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.origin + parsed.pathname === target.url &&
      host === target.host.toLowerCase() &&
      match?.[1] === target.tenant.toLowerCase() &&
      target.tenant === target.tenant.toLowerCase() &&
      /^[A-Za-z0-9-]{2,64}$/u.test(target.posting) &&
      decodedPath.includes("/job/") &&
      !decodedPath.includes("//") &&
      !decodedPath.split("/").includes("..") &&
      finalSegment.endsWith(`_${target.posting}`)
    );
  } catch {
    return false;
  }
}

function parseRoot(value: unknown, idPattern: RegExp): ExternalRootV1 | null {
  const root = record(value, rootKeys);
  return root !== null &&
    matches(root.rootId, idPattern) &&
    typeof root.path === "string" &&
    root.access === "current_user_only"
    ? (root as unknown as ExternalRootV1)
    : null;
}

function validateRoots(
  roots: Readonly<Record<RootName, ExternalRootV1>>,
  forbiddenRoots: readonly string[],
): Extract<RealRunPreflightResult, { readonly ok: false }> | null {
  if (forbiddenRoots.length === 0) {
    return failure("owner_config_invalid", "repository_scope");
  }
  const forbidden: string[] = [];
  for (const path of forbiddenRoots) {
    try {
      if (
        !isAbsolute(path) ||
        !statSync(path).isDirectory() ||
        lstatSync(path).isSymbolicLink()
      ) {
        return failure("owner_config_invalid", "repository_scope");
      }
      const real = canonicalDirectory(path);
      if (comparable(resolve(path)) !== comparable(real)) {
        return failure("owner_config_invalid", "repository_scope");
      }
      forbidden.push(real);
    } catch {
      return failure("owner_config_invalid", "repository_scope");
    }
  }

  const canonical = new Map<RootName, string>();
  for (const name of ["runtime", "secrets", "evidence"] as const) {
    const path = roots[name].path;
    if (!isAbsolute(path)) {
      return failure(rootCode(name), "absolute");
    }
    if (!existsSync(path)) {
      return failure(rootCode(name), "missing");
    }
    try {
      if (!statSync(path).isDirectory()) {
        return failure(rootCode(name), "directory");
      }
      if (lstatSync(path).isSymbolicLink()) {
        return failure(rootCode(name), "reparse");
      }
      const resolved = resolve(path);
      const real = canonicalDirectory(path);
      if (comparable(resolved) !== comparable(real) || normalize(path) !== path) {
        return failure(rootCode(name), "reparse");
      }
      if (forbidden.some((root) => overlaps(real, root))) {
        return failure(rootCode(name), "repository");
      }
      canonical.set(name, real);
    } catch {
      return failure(rootCode(name), "unreadable");
    }
  }

  const names = ["runtime", "secrets", "evidence"] as const;
  for (let rightIndex = 1; rightIndex < names.length; rightIndex += 1) {
    const right = names[rightIndex];
    if (right === undefined) continue;
    for (let leftIndex = 0; leftIndex < rightIndex; leftIndex += 1) {
      const left = names[leftIndex];
      if (left === undefined) continue;
      if (overlaps(canonical.get(left) ?? "", canonical.get(right) ?? "")) {
        return failure(rootCode(right), "overlap");
      }
    }
  }
  return null;
}

function validApproval(
  approval: UnknownRecord,
  journeyId: unknown,
  revisionId: unknown,
  now: number,
): boolean {
  const approvedAt = parseTimestamp(approval.approvedAt);
  const expiresAt = parseTimestamp(approval.expiresAt);
  return (
    approval.schemaVersion === 1 &&
    matches(approval.approvalId, opaquePatterns.approval) &&
    approval.journeyId === journeyId &&
    approval.revisionId === revisionId &&
    approval.approved === true &&
    approval.liveAccess === true &&
    approvedAt !== null &&
    expiresAt !== null &&
    approvedAt <= now &&
    expiresAt > now &&
    expiresAt - approvedAt <= 30 * 24 * 60 * 60 * 1_000 &&
    matches(approval.ownerId, opaquePatterns.owner) &&
    approval.runtimeOperatorId === approval.ownerId &&
    approval.secretCustodianId === approval.ownerId &&
    approval.evidenceCustodianId === approval.ownerId
  );
}

function validSecret(
  secret: UnknownRecord,
  journeyId: unknown,
  now: number,
  approvalExpiry: string,
  purpose: ScopedSecretReferenceV1["purpose"],
  consumer: ScopedSecretReferenceV1["consumer"],
  scope: ScopedSecretReferenceV1["scope"],
): boolean {
  const expiresAt = parseTimestamp(secret.expiresAt);
  return (
    secret.schemaVersion === 1 &&
    matches(secret.handleId, opaquePatterns.secret) &&
    secret.journeyId === journeyId &&
    secret.provider === "windows-dpapi-current-user-v1" &&
    secret.purpose === purpose &&
    secret.consumer === consumer &&
    secret.scope === scope &&
    expiresAt !== null &&
    expiresAt > now &&
    secret.expiresAt === approvalExpiry
  );
}

function parseTimestamp(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function record<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): UnknownRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
    ? (value as UnknownRecord)
    : null;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function canonicalDirectory(path: string): string {
  return realpathSync.native(path);
}

function comparable(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function rootCode(name: RootName): PreflightFailureCode {
  return name === "runtime"
    ? "runtime_root_invalid"
    : name === "secrets"
      ? "secret_root_invalid"
      : "evidence_root_invalid";
}

function failure(
  code: PreflightFailureCode,
  dimension: string,
): Extract<RealRunPreflightResult, { readonly ok: false }> {
  return { ok: false, error: { code, dimension } };
}
