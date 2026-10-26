import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { admitRealRunPreflight } from "../admit.ts";
import type {
  PreflightContext,
  RealRunOwnerInputsV1,
  RealRunPreflightReportV1,
  RealRunPreflightResult,
} from "../types.ts";
import {
  WindowsCurrentUserAclAdmission,
  type WindowsAclAdmissionPaths,
  type WindowsAclAdmissionResult,
  type WindowsAclTarget,
} from "./windows-acl.ts";

export interface PersistentBrowserRuntimeValues {
  readonly targetUrl: string;
  readonly profilePath: string;
  readonly admittedAt: string;
  readonly leaseExpiresAt: string;
}

export class RealRunRuntimeBinding {
  readonly #targetUrl: string;
  readonly #profilePath: string;
  readonly #admittedAt: string;
  readonly #leaseExpiresAt: string;

  private constructor(values: PersistentBrowserRuntimeValues) {
    this.#targetUrl = values.targetUrl;
    this.#profilePath = values.profilePath;
    this.#admittedAt = values.admittedAt;
    this.#leaseExpiresAt = values.leaseExpiresAt;
    Object.freeze(this);
  }

  static create(
    input: RealRunOwnerInputsV1,
    context: PreflightContext,
  ): RealRunRuntimeBinding {
    return new RealRunRuntimeBinding({
      targetUrl: input.target.url,
      profilePath: browserProfilePath(input),
      admittedAt: context.now,
      leaseExpiresAt: new Date(
        Date.parse(context.now) + 24 * 60 * 60 * 1_000,
      ).toISOString(),
    });
  }

  forPersistentBrowser(): PersistentBrowserRuntimeValues {
    return {
      targetUrl: this.#targetUrl,
      profilePath: this.#profilePath,
      admittedAt: this.#admittedAt,
      leaseExpiresAt: this.#leaseExpiresAt,
    };
  }
}

export type PrivateRealRunAdmission =
  | {
      readonly ok: true;
      readonly report: RealRunPreflightReportV1;
      readonly binding: RealRunRuntimeBinding;
    }
  | Extract<RealRunPreflightResult, { readonly ok: false }>;

export interface PrivatePreflightContext extends PreflightContext {
  readonly ownerConfigPath: string;
  readonly aclAdmission?: {
    admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult;
  };
}

export function createPrivateRealRunAdmission(
  value: unknown,
  context: PrivatePreflightContext,
): PrivateRealRunAdmission {
  const result = admitRealRunPreflight(value, context);
  if (!result.ok) return result;

  const input = value as RealRunOwnerInputsV1;
  const profilePath = browserProfilePath(input);
  if (
    process.platform === "win32" &&
    join(profilePath, "Default", ".hunt-preferences.tmp").length >= 260
  ) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({
        code: "runtime_root_invalid",
        dimension: "profile_path_length",
      }),
    });
  }
  const accountRecord = secretRecordPath(input, input.accountSecret.handleId);
  const gmailRecord = secretRecordPath(input, input.gmailAuthorization.handleId);
  const acl = (context.aclAdmission ?? new WindowsCurrentUserAclAdmission()).admit({
    runtime: input.roots.runtime.path,
    secrets: input.roots.secrets.path,
    evidence: input.roots.evidence.path,
    ownerConfig: context.ownerConfigPath,
    ...(existsSync(accountRecord) ? { accountRecord } : {}),
    ...(existsSync(gmailRecord) ? { gmailRecord } : {}),
  });
  if (!acl.ok) return aclFailure(acl.failure.target);

  return {
    ok: true,
    report: result.report,
    binding: RealRunRuntimeBinding.create(
      input,
      context,
    ),
  };
}

function browserProfilePath(input: RealRunOwnerInputsV1): string {
  return join(
    realpathSync.native(input.roots.runtime.path),
    "browser-profiles",
    input.journeyId,
    input.target.handleId,
  );
}

function secretRecordPath(input: RealRunOwnerInputsV1, handleId: string): string {
  return join(input.roots.secrets.path, `${handleId}.s2secret`);
}

function aclFailure(target: WindowsAclTarget): PrivateRealRunAdmission {
  const code = target === "runtime_root"
    ? "runtime_root_invalid"
    : target === "evidence_root"
      ? "evidence_root_invalid"
      : target === "owner_config"
        ? "owner_config_invalid"
        : "secret_root_invalid";
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, dimension: "acl" }),
  });
}
