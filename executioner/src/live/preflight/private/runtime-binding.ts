import { realpathSync } from "node:fs";
import { join } from "node:path";

import { admitRealRunPreflight } from "../admit.ts";
import type {
  PreflightContext,
  RealRunOwnerInputsV1,
  RealRunPreflightReportV1,
  RealRunPreflightResult,
} from "../types.ts";

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
    const runtimeRoot = realpathSync.native(input.roots.runtime.path);
    return new RealRunRuntimeBinding({
      targetUrl: input.target.url,
      profilePath: join(
        runtimeRoot,
        "browser-profiles",
        input.journeyId,
        input.target.handleId,
      ),
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

export function createPrivateRealRunAdmission(
  value: unknown,
  context: PreflightContext,
): PrivateRealRunAdmission {
  const result = admitRealRunPreflight(value, context);
  if (!result.ok) return result;

  return {
    ok: true,
    report: result.report,
    binding: RealRunRuntimeBinding.create(
      value as RealRunOwnerInputsV1,
      context,
    ),
  };
}
