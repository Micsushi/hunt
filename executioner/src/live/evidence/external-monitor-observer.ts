import { createHash } from "node:crypto";
import {
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  createStage2ExternalMonitorObserverAuthority,
} from "./external-monitor-authority.ts";
import { reviewedMonitorStructureId } from "./monitor-structures.ts";
import {
  canonicalMonitorIdentityTitle,
  writeStage2ExternalMonitorAcknowledgement,
} from "./external-monitor-runtime.ts";
import {
  observedActiveStageTitles,
  observedStructureIdentityTitles,
  observedStructurePage,
  observedSubmitPresent,
  type ObservedOwnedControlStructure,
  type ObservedStageCounts,
} from "./external-monitor-page-identity.ts";
import {
  externalMonitorObserverFailureCode,
  externalMonitorObserverFailureDiagnostic,
  observerFailure,
  observerStage,
  type ExternalMonitorObserverFailureDiagnostic,
} from "./external-monitor-observer-failure.ts";
import {
  reconcileObservedMonitorSurface,
  waitForReconciledMonitorSurface,
  type ObservedMonitorSurface,
} from "./external-monitor-surface-reconciliation.ts";
import {
  normalizeObservedAddressHost,
  observedChromeIdentityTitleSha256s,
  selectObservedChromeIdentityTitle,
} from "./external-monitor-browser-identity.ts";
import {
  observerDirectory,
  pendingExternalMonitorRequests,
  stableObserverFile,
  waitForExternalMonitorDesktopBinding,
  type ExternalMonitorDesktopBinding,
} from "./external-monitor-desktop-binding.ts";
import { ownedBrowserObservation } from "./external-monitor-owned-browser.ts";
export {
  normalizeObservedAddressHost,
  normalizeObservedChromeTitle,
  observedChromeIdentityTitleSha256s,
  observedStructurePageFromIdentityTitle,
  observedStructurePageWithIdentity,
  selectObservedChromeIdentityTitle,
} from "./external-monitor-browser-identity.ts";
export {
  externalMonitorObserverFailureCode,
  externalMonitorObserverFailureDiagnostic,
} from "./external-monitor-observer-failure.ts";
export {
  reconcileObservedMonitorSurface,
  waitForReconciledMonitorSurface,
} from "./external-monitor-surface-reconciliation.ts";
export {
  observedActiveStageTitles,
  observedStructureIdentityTitles,
  observedStructurePage,
  observedSubmitPresent,
} from "./external-monitor-page-identity.ts";

const OWNER_LIVE_FILE = "external-monitor-live.json";
const STOP_FILE = "external-monitor-observer-stop";

export async function runStage2ExternalMonitorObserver(
  values: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { runtimeRoot, evidenceRoot } = parseArgs(values);
  const token = environment.HUNT_C3_MONITOR_OBSERVER_TOKEN;
  environment.HUNT_C3_MONITOR_OBSERVER_TOKEN = undefined;
  if (token === undefined || !/^[A-Za-z0-9+/]{43}=$/u.test(token)) denied();
  const binding = await waitForExternalMonitorDesktopBinding(runtimeRoot, token);
  const authority = createStage2ExternalMonitorObserverAuthority({
    runtimeRoot,
    journeyId: binding.journeyId,
    targetHandleId: binding.targetHandleId,
    authorityToken: token,
  });
  const stopPath = join(runtimeRoot, STOP_FILE);
  let ownerSeen = false;
  try {
    while (!existsSync(stopPath)) {
      const ownerLive = existsSync(join(runtimeRoot, OWNER_LIVE_FILE));
      ownerSeen ||= ownerLive;
      if (ownerSeen && !ownerLive) return;
      for (const requestPath of pendingExternalMonitorRequests(evidenceRoot)) {
        await acknowledge(runtimeRoot, evidenceRoot, requestPath, binding, authority);
      }
      await delay(50);
    }
  } catch (error) {
    retainObserverFailure(evidenceRoot, error);
    throw error;
  } finally {
    authority.close();
    rmSync(stopPath, { force: true });
  }
}

function retainObserverFailure(evidenceRoot: string, error: unknown): void {
  const failureCode = externalMonitorObserverFailureCode(error);
  if (failureCode === undefined) return;
  const diagnostic = externalMonitorObserverFailureDiagnostic(error);
  try {
    writeFileSync(join(evidenceRoot, "external-monitor-observer-failure.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        evidenceRevision: "s2-external-monitor-observer-failure-v1",
        status: "failed",
        failureCode,
        ...(diagnostic ?? {}),
        submitActivated: false,
      })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    // Diagnostic retention must never replace the causal observer failure.
  }
}

async function acknowledge(
  runtimeRoot: string,
  evidenceRoot: string,
  requestPath: string,
  binding: ExternalMonitorDesktopBinding,
  observer: ReturnType<typeof createStage2ExternalMonitorObserverAuthority>,
): Promise<void> {
  const request = observerStage("request_admission", () =>
    JSON.parse(stableObserverFile(requestPath, 16 * 1024).toString("utf8"))) as {
    readonly page?: unknown;
    readonly moment?: unknown;
    readonly screenshotFile?: unknown;
    readonly capturedIdentityDigests?: unknown;
  };
  if (typeof request.page !== "string" || typeof request.moment !== "string" ||
      typeof request.screenshotFile !== "string") denied();
  const structure = reviewedMonitorStructureId(request.page);
  if (structure === undefined) denied();
  const screenshotPath = join(dirname(requestPath), request.screenshotFile);
  const screenshot = observerStage("screenshot_admission", () =>
    stableObserverFile(screenshotPath, 12 * 1024 * 1024));
  const expectedTitleSha256 = typeof request.capturedIdentityDigests === "object" &&
      request.capturedIdentityDigests !== null &&
      "titleSha256" in request.capturedIdentityDigests &&
      typeof request.capturedIdentityDigests.titleSha256 === "string"
    ? request.capturedIdentityDigests.titleSha256
    : undefined;
  const visual = await waitForReconciledMonitorSurface(request, () =>
    observerStage("owned_browser_observation", () =>
      ownedBrowserObservation(runtimeRoot, binding, expectedTitleSha256)));
  observerStage("acknowledgement_admission", () =>
    writeStage2ExternalMonitorAcknowledgement({
    runtimeRoot,
    evidenceRoot,
    requestPath,
    classification: request.page === "review" && request.moment === "review_readback"
      ? "review_verified"
      : request.page === "application_ready" && request.moment === "state_observed"
        ? "account_verified"
        : "safe_to_continue",
    observedScreenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
    observedIdentity: {
      host: binding.host,
      tenant: binding.tenant,
      posting: binding.posting,
      title: visual.title,
    },
    structuralDescriptionIds: [structure],
    observedStructurePage: visual.page,
    observedSubmitPresent: visual.submitPresent,
    privacyScan: "separate_evidence_required",
      observer,
    }));
}


function parseArgs(values: readonly string[]) {
  if (values.length !== 4 || values[0] !== "--runtime-root" || values[2] !== "--evidence-root") {
    denied();
  }
  return Object.freeze({
    runtimeRoot: observerDirectory(values[1]!),
    evidenceRoot: observerDirectory(values[3]!),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function denied(): never {
  throw new Error("external monitor observer denied");
}
