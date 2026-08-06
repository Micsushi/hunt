import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ActiveGmailSecretHandle,
  OperationId,
  RecipientBindingId,
  SecretHandleId,
  SecretHandleMetadataV1,
  TargetHostId,
  TargetPostingId,
  TargetTenantId,
  VerificationHandleId,
} from "../contracts/index.ts";
import { writeMailboxCandidateEvidence } from "../live/evidence/mailbox-candidate-evidence.ts";
import { createPrivateRealRunAdmission } from "../live/preflight/private/runtime-binding.ts";
import type { RealRunOwnerInputsV1 } from "../live/preflight/types.ts";
import {
  runStage2MailboxCandidate,
  type Stage2MailboxCandidateInput,
  type Stage2MailboxCandidateResult,
} from "../live/runner/mailbox-candidate.ts";
import { createBoundedMailboxPolicy, type SenderPolicyId } from "../mailbox/policy.ts";
import { matchesStage2OwnerStorageBinding } from "./private/s2-owner-storage-binding.ts";
import {
  GmailApiAuthExecutor,
  type GmailApprovedPolicyCapability,
} from "../mailbox/providers/gmail/auth-executor.ts";
import { GmailHttpClient } from "../mailbox/providers/gmail/http-client.ts";
import { GmailRawArtifactVault } from "../mailbox/providers/gmail/private/raw-artifact-vault.ts";
import { GmailMailboxProvider } from "../mailbox/providers/gmail/provider.ts";
import { GmailSafeArtifactRegistry } from "../mailbox/providers/gmail/safe-artifact-registry.ts";
import { WindowsDpapiSecretResolver } from "../secrets/windows-dpapi/private/resolver.ts";
import { WindowsDpapiSecretStore } from "../secrets/windows-dpapi/store.ts";
import { deriveSenderPolicyId } from "./private/s2-gmail-bootstrap-binding.ts";
import { inspectCleanSourceRevision } from "./private/s2-clean-source-revision.ts";

export interface Stage2MailboxCandidateProductionOptions {
  readonly configPath: string;
  readonly evidenceRoot: string;
}

interface GmailRuntimeBinding {
  readonly journeyId: Stage2MailboxCandidateInput["journeyId"];
  readonly recipientBindingId: RecipientBindingId;
  readonly senderPolicyId: SenderPolicyId;
  readonly target: Stage2MailboxCandidateInput["target"];
  readonly notBefore: string;
  readonly notAfter: string;
  readonly verificationOperationId: OperationId;
}

export function createMailboxCandidateBindings(
  owner: RealRunOwnerInputsV1,
  sourceRevision: string,
  now: string,
  verificationOperationId: OperationId,
): { readonly input: Stage2MailboxCandidateInput; readonly gmail: GmailRuntimeBinding } {
  const suffix = opaqueSuffix(owner.target.handleId, "target_ref_");
  const target = Object.freeze({
    schemaVersion: 1 as const,
    atsFamily: "workday" as const,
    hostId: `host_${suffix}` as TargetHostId,
    tenantId: `tenant_${suffix}` as TargetTenantId,
    postingId: `posting_${suffix}` as TargetPostingId,
  });
  const notBefore = new Date(Date.parse(now) - 60 * 60 * 1_000).toISOString();
  const notAfter = now;
  const input: Stage2MailboxCandidateInput = Object.freeze({
    sourceRevision,
    revisionId: owner.revisionId,
    approvalId: owner.approval.approvalId,
    journeyId: owner.journeyId as never,
    targetHandleId: owner.target.handleId,
    recipientBindingId: owner.recipientBindingId as RecipientBindingId,
    target,
    notBefore,
    notAfter,
    now,
  });
  const gmail = Object.freeze({
    journeyId: input.journeyId,
    recipientBindingId: input.recipientBindingId,
    senderPolicyId: deriveSenderPolicyId({
      revisionId: owner.revisionId,
      journeyId: owner.journeyId,
      gmailHandleId: owner.gmailAuthorization.handleId,
      recipientBindingId: owner.recipientBindingId,
    }) as SenderPolicyId,
    target,
    notBefore,
    notAfter,
    verificationOperationId,
  });
  return Object.freeze({ input, gmail });
}

export async function runStage2MailboxCandidateFromOwnerConfig(
  options: Stage2MailboxCandidateProductionOptions,
  signal: AbortSignal,
): Promise<Stage2MailboxCandidateResult> {
  try {
    const executionerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const source = inspectCleanSourceRevision(executionerRoot);
    const configPath = admittedFile(options.configPath);
    const value = readOwnerConfig(configPath);
    const now = new Date().toISOString();
    const admission = createPrivateRealRunAdmission(value, {
      now,
      forbiddenRoots: [source.repositoryRoot],
      ownerConfigPath: configPath,
    });
    if (!admission.ok) return failure(admission.error.code);
    const owner = value as RealRunOwnerInputsV1;
    if (!matchesStage2OwnerStorageBinding({
      ownerConfigPath: configPath,
      runtimeRoot: owner.roots.runtime.path,
      ownerEvidenceRoot: owner.roots.evidence.path,
      requestedEvidenceRoot: options.evidenceRoot,
    })) {
      return failure("owner_config_invalid");
    }
    const secretStore = new WindowsDpapiSecretStore({
      root: owner.roots.secrets.path,
      forbiddenRoots: [source.repositoryRoot],
      now: () => now,
    });
    const inspected = await secretStore.inspect({
      schemaVersion: 1,
      journeyId: owner.journeyId as never,
      handleId: owner.gmailAuthorization.handleId as SecretHandleId,
      expectedPurpose: "gmail_oauth",
      expectedConsumer: "gmail_auth_executor",
    }, signal);
    if (!inspected.ok) return failure(inspected.error.code);
    if (!exactGmailMetadata(inspected.value, owner)) {
      return failure("secret_handle_mismatched");
    }
    const authorization = inspected.value as ActiveGmailSecretHandle;
    const verificationOperationId = operationId();
    const bindings = createMailboxCandidateBindings(
      owner,
      source.sourceRevision,
      now,
      verificationOperationId,
    );
    const resolver = new WindowsDpapiSecretResolver({
      root: owner.roots.secrets.path,
      forbiddenRoots: [source.repositoryRoot],
      now: () => now,
    });
    const rawVault = new GmailRawArtifactVault();
    const artifacts = new GmailSafeArtifactRegistry();
    const valueFreeTrace = process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1"
      ? (event: string) => process.stderr.write(`${JSON.stringify({ trace: event })}\n`)
      : undefined;
    const authExecutor = new GmailApiAuthExecutor({
      binding: bindings.gmail,
      resolver,
      httpClient: new GmailHttpClient({ trace: valueFreeTrace }),
      rawVault,
      artifactRegistry: artifacts,
      approvedPolicy: approvedPolicy(owner),
      createHandle: () =>
        `verification_handle_${randomBytes(16).toString("hex")}` as VerificationHandleId,
      policyFactory: {
        create(candidateSource, admittedNow) {
          return createBoundedMailboxPolicy({
            binding: bindings.gmail,
            candidateSource,
            clock: () => admittedNow,
            timeoutMs: 60_000,
          });
        },
      },
    });
    const mailbox = new GmailMailboxProvider({
      authorization,
      binding: {
        schemaVersion: 1,
        journeyId: bindings.input.journeyId,
        queryId: `mailbox_query_${randomBytes(16).toString("hex")}` as never,
        recipientBindingId: bindings.input.recipientBindingId,
        target: bindings.input.target,
        notBefore: bindings.input.notBefore,
        notAfter: bindings.input.notAfter,
      },
      now: () => now,
      secretStore,
      authExecutor,
      artifacts: artifacts.port,
      timeoutMs: 60_000,
    });
    return await runStage2MailboxCandidate(bindings.input, {
      mailbox,
      releaseCandidate: (handleId) => artifacts.discard(handleId),
      evidence: {
        write: async (acceptance) => writeMailboxCandidateEvidence({
          root: owner.roots.evidence.path,
          acceptance,
          sensitiveValues: [
            owner.target.url,
            owner.target.host,
            owner.target.tenant,
            owner.target.posting,
            owner.roots.runtime.path,
            owner.roots.secrets.path,
            owner.roots.evidence.path,
            configPath,
          ],
        }),
      },
      nextQueryId: () =>
        `mailbox_query_${randomBytes(16).toString("hex")}` as never,
    }, signal);
  } catch {
    return failure(signal.aborted ? "operation_cancelled" : "owner_config_invalid");
  }
}

function approvedPolicy(owner: RealRunOwnerInputsV1): GmailApprovedPolicyCapability {
  return {
    async use(operation) {
      const host = new TextEncoder().encode(owner.target.host);
      const tenant = new TextEncoder().encode(owner.target.tenant);
      try {
        return await operation({ host, tenant });
      } finally {
        host.fill(0);
        tenant.fill(0);
      }
    },
  };
}

function exactGmailMetadata(
  value: SecretHandleMetadataV1,
  owner: RealRunOwnerInputsV1,
): boolean {
  return value.schemaVersion === 1 &&
    value.handleId === owner.gmailAuthorization.handleId &&
    value.journeyId === owner.journeyId &&
    value.provider === "windows_dpapi_current_user_v1" &&
    value.purpose === "gmail_oauth" &&
    value.consumer === "gmail_auth_executor" &&
    value.expiresAt === owner.gmailAuthorization.expiresAt &&
    value.state === "active";
}

function admittedFile(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value ||
      lstatSync(value).isSymbolicLink() || !statSync(value).isFile() ||
      statSync(value).size < 2 || statSync(value).size > 64 * 1024) {
    throw new TypeError("invalid owner config");
  }
  const canonical = realpathSync.native(value);
  if (comparable(canonical) !== comparable(resolve(value))) {
    throw new TypeError("invalid owner config");
  }
  return canonical;
}

function readOwnerConfig(path: string): unknown {
  const bytes = readFileSync(path);
  try {
    if (bytes.byteLength < 2 || bytes.byteLength > 64 * 1024 ||
        (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
      throw new TypeError("invalid owner config");
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    bytes.fill(0);
  }
}

function opaqueSuffix(value: string, prefix: string): string {
  const suffix = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(suffix)) {
    throw new TypeError("invalid opaque reference");
  }
  return suffix;
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function operationId(): OperationId {
  return `operation_${randomBytes(16).toString("hex")}` as OperationId;
}

function failure(code: string): Stage2MailboxCandidateResult {
  return Object.freeze({ ok: false, code });
}
