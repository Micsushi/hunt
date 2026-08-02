import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import type {
  JourneyId,
  SecretHandleId,
  TargetHostId,
  TargetPostingId,
  TargetTenantId,
} from "../contracts/index.ts";
import type { SecretHandleMetadataV1, TargetIdentityV1 } from "../contracts/live/index.ts";
import { admitGmailGrantRevocationOwner } from "../live/preflight/admit.ts";
import { createPrivateRealRunAdmission } from "../live/preflight/private/runtime-binding.ts";
import {
  WindowsCurrentUserAclAdmission,
  type WindowsAclAdmissionPaths,
  type WindowsAclAdmissionResult,
} from "../live/preflight/private/windows-acl.ts";
import type { RealRunOwnerInputsV1 } from "../live/preflight/types.ts";
import {
  deleteSecretRecord,
  readSecretRecord,
  type StoredSecretMetadata,
} from "../secrets/windows-dpapi/record.ts";
import { ExactSealedGmailCustodian } from "../secrets/windows-dpapi/private/exact-sealed-gmail-custodian.ts";
import {
  WindowsGmailRefreshGrantRevoker,
  WindowsInteractiveGmailOAuthSealer,
  type GmailRefreshGrantRevokeRequest,
  type GmailOAuthSealRequest,
} from "../secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts";
import { WindowsDpapiSecretStore } from "../secrets/windows-dpapi/store.ts";
import {
  admitGmailBootstrapInput,
  deriveSenderPolicyId,
} from "./private/s2-gmail-bootstrap-binding.ts";

export interface GmailCiphertextSealer {
  seal(request: GmailOAuthSealRequest, signal: AbortSignal): Promise<Uint8Array>;
}

export interface GmailRefreshGrantRevoker {
  revoke(
    request: GmailRefreshGrantRevokeRequest,
    signal: AbortSignal,
  ): Promise<"revoked" | "absent">;
}

export interface GmailBootstrapOptions {
  readonly now: string;
  readonly ownerConfigPath: string;
  readonly bootstrapInputPath: string;
  readonly forbiddenRoots: readonly string[];
  readonly aclAdmission?: {
    admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult;
  };
  readonly sealer?: GmailCiphertextSealer;
}

export interface GmailGrantRevocationOptions {
  readonly now: string;
  readonly ownerConfigPath: string;
  readonly bootstrapInputPath: string;
  readonly forbiddenRoots: readonly string[];
  readonly aclAdmission?: {
    admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult;
  };
  readonly revoker?: GmailRefreshGrantRevoker;
}

export type GmailBootstrapErrorCode =
  | "owner_config_invalid"
  | "runtime_root_invalid"
  | "secret_root_invalid"
  | "evidence_root_invalid"
  | "gmail_bootstrap_input_invalid"
  | "account_handle_invalid"
  | "gmail_handle_invalid"
  | "gmail_handle_exists"
  | "gmail_oauth_client_invalid"
  | "gmail_sender_policy_invalid"
  | "gmail_refresh_grant_invalid"
  | "gmail_refresh_unavailable"
  | "gmail_oauth_cancelled"
  | "gmail_oauth_denied"
  | "gmail_identity_mismatch"
  | "gmail_scope_invalid"
  | "gmail_token_expiry_invalid"
  | "gmail_oauth_timeout"
  | "gmail_seal_failed"
  | "gmail_record_failed"
  | "gmail_record_acl_invalid"
  | "gmail_metadata_invalid"
  | "gmail_cleanup_failed"
  | "operation_cancelled";

export type GmailBootstrapResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly schemaVersion: 1;
        readonly kind: "gmail_authorization_provisioned";
        readonly handleId: string;
      };
    }
  | { readonly ok: false; readonly error: { readonly code: GmailBootstrapErrorCode } };

export type GmailGrantRevocationResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly schemaVersion: 1;
        readonly kind: "gmail_refresh_grant_revoked" | "gmail_refresh_grant_absent";
      };
    }
  | { readonly ok: false; readonly error: { readonly code: GmailBootstrapErrorCode } };

interface GmailOperationOptions {
  readonly now: string;
  readonly ownerConfigPath: string;
  readonly bootstrapInputPath: string;
  readonly forbiddenRoots: readonly string[];
  readonly aclAdmission?: {
    admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult;
  };
}

type AdmittedGmailOperation = {
  readonly acl: {
    admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult;
  };
  readonly owner: RealRunOwnerInputsV1;
  readonly bootstrap: NonNullable<ReturnType<typeof admitGmailBootstrapInput>>;
  readonly installedClientConfigPath: string;
  readonly senderPolicyConfigPath: string;
  readonly accountRecordPath: string;
  readonly gmailRecordPath: string;
  readonly account: NonNullable<Awaited<ReturnType<typeof readSecretRecord>>>;
};

type AdmittedGmailGrantRevocation = {
  readonly owner: NonNullable<Extract<
    ReturnType<typeof admitGmailGrantRevocationOwner>,
    { readonly ok: true }
  >["value"]>;
  readonly bootstrap: NonNullable<ReturnType<typeof admitGmailBootstrapInput>>;
  readonly installedClientConfigPath: string;
};

function admitGmailGrantRevocation(
  ownerValue: unknown,
  bootstrapValue: unknown,
  options: GmailOperationOptions,
):
  | { readonly ok: true; readonly value: AdmittedGmailGrantRevocation }
  | { readonly ok: false; readonly code: GmailBootstrapErrorCode } {
  const ownerAdmission = admitGmailGrantRevocationOwner(ownerValue, {
    now: options.now,
    forbiddenRoots: options.forbiddenRoots,
  });
  if (!ownerAdmission.ok) {
    return { ok: false, code: ownerAdmission.error.code };
  }
  const owner = ownerAdmission.value;
  const bootstrap = admitGmailBootstrapInput(bootstrapValue, {
    revisionId: owner.revisionId,
    journeyId: owner.journeyId,
    gmailHandleId: owner.gmailHandleId,
  });
  if (bootstrap === null) return { ok: false, code: "gmail_bootstrap_input_invalid" };
  const installedClientConfigPath = admitProtectedConfigPath(
    bootstrap.installedClientConfigPath,
    options.forbiddenRoots,
  );
  if (installedClientConfigPath === null) {
    return { ok: false, code: "gmail_oauth_client_invalid" };
  }

  const acl = options.aclAdmission ?? new WindowsCurrentUserAclAdmission();
  const ownerAcl = acl.admit({
    runtime: owner.rootPaths.runtime,
    secrets: owner.rootPaths.secrets,
    evidence: owner.rootPaths.evidence,
    ownerConfig: options.ownerConfigPath,
  });
  if (!ownerAcl.ok) {
    return {
      ok: false,
      code: ownerAcl.failure.target === "runtime_root"
        ? "runtime_root_invalid"
        : ownerAcl.failure.target === "evidence_root"
          ? "evidence_root_invalid"
          : ownerAcl.failure.target === "owner_config"
            ? "owner_config_invalid"
            : "secret_root_invalid",
    };
  }
  const bootstrapAcl = acl.admit({
    runtime: owner.rootPaths.runtime,
    secrets: owner.rootPaths.secrets,
    evidence: owner.rootPaths.evidence,
    ownerConfig: options.bootstrapInputPath,
    oauthClientConfig: installedClientConfigPath,
  });
  if (!bootstrapAcl.ok) {
    return {
      ok: false,
      code: bootstrapAcl.failure.target === "runtime_root"
        ? "runtime_root_invalid"
        : bootstrapAcl.failure.target === "evidence_root"
          ? "evidence_root_invalid"
          : bootstrapAcl.failure.target === "owner_config"
            ? "gmail_bootstrap_input_invalid"
            : bootstrapAcl.failure.target === "oauth_client_config"
              ? "gmail_oauth_client_invalid"
              : "secret_root_invalid",
    };
  }
  return {
    ok: true,
    value: { owner, bootstrap, installedClientConfigPath },
  };
}

async function admitGmailOperation(
  ownerValue: unknown,
  bootstrapValue: unknown,
  options: GmailOperationOptions,
): Promise<
  | { readonly ok: true; readonly value: AdmittedGmailOperation }
  | { readonly ok: false; readonly code: GmailBootstrapErrorCode }
> {
  const acl = options.aclAdmission ?? new WindowsCurrentUserAclAdmission();
  const admitted = createPrivateRealRunAdmission(ownerValue, {
    now: options.now,
    forbiddenRoots: options.forbiddenRoots,
    ownerConfigPath: options.ownerConfigPath,
    aclAdmission: acl,
  });
  if (!admitted.ok) return { ok: false, code: admitted.error.code };
  const owner = ownerValue as RealRunOwnerInputsV1;
  const bootstrap = admitGmailBootstrapInput(bootstrapValue, {
    revisionId: owner.revisionId,
    journeyId: owner.journeyId,
    gmailHandleId: owner.gmailAuthorization.handleId,
  });
  if (bootstrap === null) return { ok: false, code: "gmail_bootstrap_input_invalid" };
  const installedClientConfigPath = admitProtectedConfigPath(
    bootstrap.installedClientConfigPath,
    options.forbiddenRoots,
  );
  if (installedClientConfigPath === null) {
    return { ok: false, code: "gmail_oauth_client_invalid" };
  }
  const senderPolicyConfigPath = admitProtectedConfigPath(
    bootstrap.senderPolicyConfigPath,
    options.forbiddenRoots,
  );
  if (
    senderPolicyConfigPath === null ||
    comparable(senderPolicyConfigPath) === comparable(installedClientConfigPath)
  ) return { ok: false, code: "gmail_sender_policy_invalid" };
  const accountRecordPath = recordPath(owner, owner.accountSecret.handleId);
  const gmailRecordPath = recordPath(owner, owner.gmailAuthorization.handleId);
  if (!existsSync(accountRecordPath)) return { ok: false, code: "account_handle_invalid" };
  const policyAcl = acl.admit({
    runtime: owner.roots.runtime.path,
    secrets: owner.roots.secrets.path,
    evidence: owner.roots.evidence.path,
    ownerConfig: options.bootstrapInputPath,
    oauthClientConfig: installedClientConfigPath,
    senderPolicyConfig: senderPolicyConfigPath,
    accountRecord: accountRecordPath,
  });
  if (!policyAcl.ok) {
    if (policyAcl.failure.target === "owner_config") {
      return { ok: false, code: "gmail_bootstrap_input_invalid" };
    }
    if (policyAcl.failure.target === "oauth_client_config") {
      return { ok: false, code: "gmail_oauth_client_invalid" };
    }
    if (policyAcl.failure.target === "sender_policy_config") {
      return { ok: false, code: "gmail_sender_policy_invalid" };
    }
    return { ok: false, code: "secret_root_invalid" };
  }
  const account = await readSecretRecord(
    owner.roots.secrets.path,
    owner.accountSecret.handleId,
  );
  if (account === null || !exactAccountMetadata(account.metadata, owner)) {
    clearRecord(account);
    return { ok: false, code: "account_handle_invalid" };
  }
  return {
    ok: true,
    value: {
      acl,
      owner,
      bootstrap,
      installedClientConfigPath,
      senderPolicyConfigPath,
      accountRecordPath,
      gmailRecordPath,
      account,
    },
  };
}

export async function bootstrapS2GmailAuthorization(
  ownerValue: unknown,
  bootstrapValue: unknown,
  options: GmailBootstrapOptions,
  signal: AbortSignal,
): Promise<GmailBootstrapResult> {
  if (signal.aborted) return failure("operation_cancelled");
  const admission = await admitGmailOperation(ownerValue, bootstrapValue, options);
  if (!admission.ok) return failure(admission.code);
  const {
    acl,
    owner,
    bootstrap,
    installedClientConfigPath,
    senderPolicyConfigPath,
    accountRecordPath,
    gmailRecordPath,
    account,
  } = admission.value;

  let prepared;
  try {
    prepared = await new ExactSealedGmailCustodian({
      root: owner.roots.secrets.path,
      forbiddenRoots: options.forbiddenRoots,
      now: () => options.now,
    }).prepare({
      handleId: owner.gmailAuthorization.handleId,
      journeyId: owner.journeyId as JourneyId,
      expiresAt: owner.gmailAuthorization.expiresAt,
    });
  } catch (error) {
    clearRecord(account);
    return failure(exactError(error));
  }

  const gmailMetadata = prepared.entropy();
  let sealed: Uint8Array;
  try {
    sealed = await (options.sealer ?? new WindowsInteractiveGmailOAuthSealer()).seal({
      gmailMetadata,
      accountMetadata: account.metadataBytes,
      accountCiphertext: account.sealedBytes,
      clientId: bootstrap.desktopClientId,
      installedClientConfigPath,
      senderPolicyConfigPath,
      binding: {
        journeyId: owner.journeyId,
        recipientBindingId: owner.recipientBindingId,
        senderPolicyId: deriveSenderPolicyId({
          revisionId: owner.revisionId,
          journeyId: owner.journeyId,
          gmailHandleId: owner.gmailAuthorization.handleId,
          recipientBindingId: owner.recipientBindingId,
        }),
        target: targetIdentity(owner),
        verificationHost: bootstrap.verificationHost,
        verificationTenant: owner.target.tenant,
        verificationTtlSeconds: 86_400,
      },
    }, signal);
  } catch (error) {
    return failure(sealerError(error, signal));
  } finally {
    gmailMetadata.fill(0);
    clearRecord(account);
  }

  let committed;
  try {
    committed = await prepared.commit(sealed, signal);
  } catch {
    return failure(signal.aborted ? "operation_cancelled" : "gmail_record_failed");
  }

  const postAcl = acl.admit({
    runtime: owner.roots.runtime.path,
    secrets: owner.roots.secrets.path,
    evidence: owner.roots.evidence.path,
    ownerConfig: options.bootstrapInputPath,
    oauthClientConfig: installedClientConfigPath,
    senderPolicyConfig: senderPolicyConfigPath,
    accountRecord: accountRecordPath,
    gmailRecord: gmailRecordPath,
  });
  if (!postAcl.ok) {
    return cleanupFailure(owner.roots.secrets.path, owner.gmailAuthorization.handleId, "gmail_record_acl_invalid");
  }

  const inspected = await new WindowsDpapiSecretStore({
    root: owner.roots.secrets.path,
    forbiddenRoots: options.forbiddenRoots,
    now: () => options.now,
  }).inspect({
    schemaVersion: 1,
    journeyId: owner.journeyId as JourneyId,
    handleId: owner.gmailAuthorization.handleId as SecretHandleId,
    expectedPurpose: "gmail_oauth",
    expectedConsumer: "gmail_auth_executor",
  }, signal);
  if (!inspected.ok || !sameGmailMetadata(inspected.value, committed, owner, options.now)) {
    return cleanupFailure(owner.roots.secrets.path, owner.gmailAuthorization.handleId, "gmail_metadata_invalid");
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      kind: "gmail_authorization_provisioned",
      handleId: owner.gmailAuthorization.handleId,
    }),
  });
}

export async function revokeS2GmailRefreshGrant(
  ownerValue: unknown,
  bootstrapValue: unknown,
  options: GmailGrantRevocationOptions,
  signal: AbortSignal,
): Promise<GmailGrantRevocationResult> {
  if (signal.aborted) return failure("operation_cancelled");
  const admission = admitGmailGrantRevocation(ownerValue, bootstrapValue, options);
  if (!admission.ok) return failure(admission.code);
  const { owner, bootstrap, installedClientConfigPath } = admission.value;
  let outcome: "revoked" | "absent";
  try {
    outcome = await (options.revoker ?? new WindowsGmailRefreshGrantRevoker()).revoke({
      recipientBindingId: owner.recipientBindingId,
      clientId: bootstrap.desktopClientId,
      installedClientConfigPath,
    }, signal);
  } catch (error) {
    return failure(sealerError(error, signal));
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      kind: outcome === "revoked"
        ? "gmail_refresh_grant_revoked"
        : "gmail_refresh_grant_absent",
    }),
  });
}

function targetIdentity(owner: RealRunOwnerInputsV1): TargetIdentityV1 {
  const suffix = owner.target.handleId.startsWith("target_ref_")
    ? owner.target.handleId.slice("target_ref_".length)
    : "";
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(suffix)) throw new TypeError("invalid target binding");
  return Object.freeze({
    schemaVersion: 1,
    atsFamily: "workday",
    hostId: `host_${suffix}` as TargetHostId,
    tenantId: `tenant_${suffix}` as TargetTenantId,
    postingId: `posting_${suffix}` as TargetPostingId,
  });
}

function exactAccountMetadata(
  value: StoredSecretMetadata,
  owner: RealRunOwnerInputsV1,
): boolean {
  return value.schemaVersion === 1 &&
    value.handleId === owner.accountSecret.handleId &&
    value.journeyId === owner.journeyId &&
    value.provider === "windows_dpapi_current_user_v1" &&
    value.purpose === "account_credentials" &&
    value.consumer === "credential_mutation_adapter" &&
    value.scope === "account_access" &&
    value.expiresAt === owner.accountSecret.expiresAt &&
    value.state === "active";
}

function sameGmailMetadata(
  inspected: SecretHandleMetadataV1,
  committed: SecretHandleMetadataV1,
  owner: RealRunOwnerInputsV1,
  issuedAt: string,
): boolean {
  return inspected.schemaVersion === committed.schemaVersion &&
    inspected.handleId === committed.handleId &&
    inspected.journeyId === committed.journeyId &&
    inspected.provider === committed.provider &&
    inspected.purpose === committed.purpose &&
    inspected.consumer === committed.consumer &&
    inspected.issuedAt === committed.issuedAt &&
    inspected.expiresAt === committed.expiresAt &&
    inspected.state === committed.state &&
    inspected.schemaVersion === 1 &&
    inspected.handleId === owner.gmailAuthorization.handleId &&
    inspected.journeyId === owner.journeyId &&
    inspected.provider === "windows_dpapi_current_user_v1" &&
    inspected.purpose === "gmail_oauth" &&
    inspected.consumer === "gmail_auth_executor" &&
    inspected.issuedAt === issuedAt &&
    inspected.expiresAt === owner.gmailAuthorization.expiresAt &&
    inspected.state === "active";
}

function recordPath(owner: RealRunOwnerInputsV1, handleId: string): string {
  return join(owner.roots.secrets.path, `${handleId}.s2secret`);
}

function clearRecord(record: Awaited<ReturnType<typeof readSecretRecord>>): void {
  record?.metadataBytes.fill(0);
  record?.sealedBytes.fill(0);
}

async function cleanupFailure(
  root: string,
  handleId: string,
  code: "gmail_record_acl_invalid" | "gmail_metadata_invalid",
): Promise<GmailBootstrapResult> {
  try {
    await deleteSecretRecord(root, handleId);
    return failure(code);
  } catch {
    return failure("gmail_cleanup_failed");
  }
}

function exactError(error: unknown): GmailBootstrapErrorCode {
  if (!(error instanceof Error)) return "gmail_record_failed";
  if (error.message === "exact Gmail handle already exists") return "gmail_handle_exists";
  if (error.message === "exact Gmail request invalid") return "gmail_handle_invalid";
  return "gmail_record_failed";
}

function sealerError(error: unknown, signal: AbortSignal): GmailBootstrapErrorCode {
  const message = error instanceof Error ? error.message : "";
  if (signal.aborted || message === "Gmail OAuth cancelled") return "gmail_oauth_cancelled";
  if (message === "Gmail OAuth denied") return "gmail_oauth_denied";
  if (message === "Gmail OAuth client invalid") return "gmail_oauth_client_invalid";
  if (message === "Gmail sender policy invalid") return "gmail_sender_policy_invalid";
  if (message === "Gmail refresh grant invalid") return "gmail_refresh_grant_invalid";
  if (message === "Gmail refresh unavailable") return "gmail_refresh_unavailable";
  if (message === "Gmail mailbox identity mismatched") return "gmail_identity_mismatch";
  if (message === "Gmail OAuth scope invalid") return "gmail_scope_invalid";
  if (message === "Gmail OAuth token expiry invalid") return "gmail_token_expiry_invalid";
  if (message === "Gmail OAuth timeout") return "gmail_oauth_timeout";
  return "gmail_seal_failed";
}

function admitProtectedConfigPath(
  value: string,
  forbiddenRoots: readonly string[],
): string | null {
  try {
    if (!isAbsolute(value) || normalize(value) !== value) return null;
    const info = lstatSync(value);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 64 * 1024) {
      return null;
    }
    const canonical = realpathSync.native(value);
    if (comparable(canonical) !== comparable(resolve(value))) return null;
    for (const root of forbiddenRoots) {
      if (within(realpathSync.native(root), canonical)) return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function comparable(path: string): string {
  const value = normalize(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function failure(code: GmailBootstrapErrorCode): {
  readonly ok: false;
  readonly error: { readonly code: GmailBootstrapErrorCode };
} {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}
