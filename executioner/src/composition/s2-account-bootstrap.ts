import { join } from "node:path";

import type { JourneyId } from "../contracts/index.ts";
import type { SecretHandleId } from "../contracts/live/index.ts";
import { createPrivateRealRunAdmission } from "../live/preflight/private/runtime-binding.ts";
import {
  WindowsCurrentUserAclAdmission,
  type WindowsAclAdmissionPaths,
  type WindowsAclAdmissionResult,
} from "../live/preflight/private/windows-acl.ts";
import type { RealRunOwnerInputsV1 } from "../live/preflight/types.ts";
import {
  ExactSealedAccountCustodian,
} from "../secrets/windows-dpapi/private/exact-sealed-account-custodian.ts";
import { WindowsInteractiveAccountSealer } from "../secrets/windows-dpapi/private/interactive-account-sealer.ts";
import { deleteSecretRecord } from "../secrets/windows-dpapi/record.ts";
import { WindowsDpapiSecretStore } from "../secrets/windows-dpapi/store.ts";

export interface AccountCiphertextSealer {
  seal(
    entropy: Readonly<Uint8Array>,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface AccountBootstrapOptions {
  readonly now: string;
  readonly ownerConfigPath: string;
  readonly forbiddenRoots: readonly string[];
  readonly aclAdmission?: {
    admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult;
  };
  readonly sealer?: AccountCiphertextSealer;
}

export type AccountBootstrapErrorCode =
  | "owner_config_invalid"
  | "runtime_root_invalid"
  | "secret_root_invalid"
  | "evidence_root_invalid"
  | "account_handle_invalid"
  | "account_handle_exists"
  | "account_prompt_cancelled"
  | "account_seal_failed"
  | "account_record_failed"
  | "account_record_acl_invalid"
  | "account_metadata_invalid"
  | "account_cleanup_failed"
  | "operation_cancelled";

export type AccountBootstrapResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly schemaVersion: 1;
        readonly kind: "account_secret_provisioned";
        readonly handleId: string;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: AccountBootstrapErrorCode;
      };
    };

export async function bootstrapS2AccountSecret(
  value: unknown,
  options: AccountBootstrapOptions,
  signal: AbortSignal,
): Promise<AccountBootstrapResult> {
  if (signal.aborted) return failure("operation_cancelled");
  const acl = options.aclAdmission ?? new WindowsCurrentUserAclAdmission();
  const admitted = createPrivateRealRunAdmission(value, {
    now: options.now,
    forbiddenRoots: options.forbiddenRoots,
    ownerConfigPath: options.ownerConfigPath,
    aclAdmission: acl,
  });
  if (!admitted.ok) return failure(admitted.error.code);

  const input = value as RealRunOwnerInputsV1;
  if (!/^secret_handle_[0-9a-f]{32}$/u.test(input.accountSecret.handleId)) {
    return failure("account_handle_invalid");
  }
  const accountRecord = join(
    input.roots.secrets.path,
    `${input.accountSecret.handleId}.s2secret`,
  );
  const custodian = new ExactSealedAccountCustodian({
    root: input.roots.secrets.path,
    forbiddenRoots: options.forbiddenRoots,
    now: () => options.now,
  });
  let prepared;
  try {
    prepared = await custodian.prepare({
      handleId: input.accountSecret.handleId,
      journeyId: input.journeyId as JourneyId,
      expiresAt: input.accountSecret.expiresAt,
    });
  } catch (error) {
    return failure(exactError(error));
  }

  const entropy = prepared.entropy();
  let sealed: Uint8Array;
  try {
    sealed = await (options.sealer ?? new WindowsInteractiveAccountSealer())
      .seal(entropy, signal);
  } catch (error) {
    return failure(
      signal.aborted || cancelledError(error)
        ? "account_prompt_cancelled"
        : "account_seal_failed",
    );
  } finally {
    entropy.fill(0);
  }

  let metadata;
  try {
    metadata = await prepared.commit(sealed, signal);
  } catch (error) {
    return failure(signal.aborted ? "operation_cancelled" : exactError(error));
  }

  const postAcl = acl.admit({
    runtime: input.roots.runtime.path,
    secrets: input.roots.secrets.path,
    evidence: input.roots.evidence.path,
    ownerConfig: options.ownerConfigPath,
    accountRecord,
  });
  if (!postAcl.ok) {
    return await cleanupFailure(
      input.roots.secrets.path,
      input.accountSecret.handleId,
      "account_record_acl_invalid",
    );
  }

  const store = new WindowsDpapiSecretStore({
    root: input.roots.secrets.path,
    forbiddenRoots: options.forbiddenRoots,
    now: () => options.now,
  });
  const inspected = await store.inspect({
    schemaVersion: 1,
    journeyId: input.journeyId as JourneyId,
    handleId: input.accountSecret.handleId as SecretHandleId,
    expectedPurpose: "account_credentials",
    expectedConsumer: "credential_mutation_adapter",
  }, signal);
  if (
    !inspected.ok ||
    inspected.value.schemaVersion !== 1 ||
    inspected.value.handleId !== metadata.handleId ||
    inspected.value.journeyId !== input.journeyId ||
    inspected.value.provider !== "windows_dpapi_current_user_v1" ||
    inspected.value.purpose !== "account_credentials" ||
    inspected.value.consumer !== "credential_mutation_adapter" ||
    inspected.value.issuedAt !== options.now ||
    inspected.value.expiresAt !== input.accountSecret.expiresAt ||
    inspected.value.state !== "active"
  ) {
    return await cleanupFailure(
      input.roots.secrets.path,
      input.accountSecret.handleId,
      "account_metadata_invalid",
    );
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      kind: "account_secret_provisioned",
      handleId: input.accountSecret.handleId,
    }),
  });
}

async function cleanupFailure(
  root: string,
  handleId: string,
  code: "account_record_acl_invalid" | "account_metadata_invalid",
): Promise<AccountBootstrapResult> {
  try {
    await deleteSecretRecord(root, handleId);
    return failure(code);
  } catch {
    return failure("account_cleanup_failed");
  }
}

function exactError(error: unknown): AccountBootstrapErrorCode {
  if (!(error instanceof Error)) return "account_record_failed";
  if (error.message === "exact account handle already exists") {
    return "account_handle_exists";
  }
  if (error.message === "exact account request invalid") {
    return "account_handle_invalid";
  }
  return "account_record_failed";
}

function cancelledError(error: unknown): boolean {
  return error instanceof Error &&
    error.message === "account credential sealing cancelled";
}

function failure(
  code: AccountBootstrapErrorCode,
): AccountBootstrapResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}
