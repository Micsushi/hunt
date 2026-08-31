import { createHash } from "node:crypto";

import { canonicalMonitorIdentityTitle } from "./external-monitor-runtime.ts";
import {
  externalMonitorObserverFailureCode,
  observerFailure,
} from "./external-monitor-observer-failure.ts";
import { compatibleObservedStructure } from "./external-monitor-page-identity.ts";

export interface ObservedMonitorSurface {
  readonly title: string;
  readonly titleCandidateSha256s?: readonly string[];
  readonly page: string;
  readonly submitPresent: boolean;
}

export async function waitForReconciledMonitorSurface(
  request: {
    readonly page?: unknown;
    readonly capturedIdentityDigests?: unknown;
    readonly expectedSubmitPresent?: unknown;
  },
  observe: () => ObservedMonitorSurface | Promise<ObservedMonitorSurface>,
  options: {
    readonly attempts?: number;
    readonly pause?: () => Promise<void>;
  } = {},
): Promise<ObservedMonitorSurface> {
  const attempts = options.attempts ?? 4;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) denied();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const observed = await observe();
      if (typeof request.page !== "string" ||
          !compatibleObservedStructure(request.page, observed.page)) {
        const expectedTitleSha256 = typeof request.capturedIdentityDigests === "object" &&
            request.capturedIdentityDigests !== null &&
            "titleSha256" in request.capturedIdentityDigests &&
            typeof request.capturedIdentityDigests.titleSha256 === "string"
          ? request.capturedIdentityDigests.titleSha256
          : undefined;
        observerFailure("structure_classification", {
          ...(/^[0-9a-f]{64}$/u.test(expectedTitleSha256 ?? "") ? { expectedTitleSha256 } : {}),
          observedTitleSha256: createHash("sha256")
            .update(canonicalMonitorIdentityTitle(observed.title), "utf8").digest("hex"),
          ...(observed.titleCandidateSha256s === undefined
            ? {}
            : { observedTitleCandidateSha256s: observed.titleCandidateSha256s }),
          observedStructurePage: observed.page,
        });
      }
      reconcileObservedMonitorSurface(request, observed);
      return observed;
    } catch (error) {
      const code = externalMonitorObserverFailureCode(error);
      if ((code !== "title_identity_reconciliation" && code !== "structure_classification") ||
          attempt === attempts) throw error;
      await (options.pause ?? (() => delay(100)))();
    }
  }
  return observerFailure("title_identity_reconciliation");
}

export function reconcileObservedMonitorSurface(
  request: {
    readonly page?: unknown;
    readonly capturedIdentityDigests?: unknown;
    readonly expectedSubmitPresent?: unknown;
  },
  observed: {
    readonly title: string;
    readonly titleCandidateSha256s?: readonly string[];
    readonly submitPresent: boolean;
  },
): void {
  const titleSha256 = typeof request.capturedIdentityDigests === "object" &&
      request.capturedIdentityDigests !== null &&
      "titleSha256" in request.capturedIdentityDigests
    ? request.capturedIdentityDigests.titleSha256
    : undefined;
  const observedTitleSha256 = createHash("sha256")
    .update(canonicalMonitorIdentityTitle(observed.title), "utf8")
    .digest("hex");
  if (typeof titleSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(titleSha256) ||
      observedTitleSha256 !== titleSha256) {
    observerFailure("title_identity_reconciliation",
      typeof titleSha256 === "string" && /^[0-9a-f]{64}$/u.test(titleSha256)
        ? {
            expectedTitleSha256: titleSha256,
            observedTitleSha256,
            ...(observed.titleCandidateSha256s === undefined
              ? {}
              : { observedTitleCandidateSha256s: observed.titleCandidateSha256s }),
          }
        : undefined);
  }
  if (typeof request.expectedSubmitPresent !== "boolean" ||
      observed.submitPresent !== request.expectedSubmitPresent) {
    observerFailure("submit_state_reconciliation");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function denied(): never {
  throw new Error("external monitor observer denied");
}
