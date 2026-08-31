import type { ObservedStageCounts } from "./external-monitor-page-identity.ts";

const observerFailureCodes = [
  "request_admission",
  "screenshot_admission",
  "owned_browser_observation",
  "browser_process_binding",
  "browser_window_missing",
  "browser_window_ambiguous",
  "browser_process_ambiguous",
  "process_inventory",
  "accessibility_tree",
  "browser_observation_command",
  "accessibility_payload",
  "address_identity",
  "structure_classification",
  "title_identity",
  "title_identity_reconciliation",
  "submit_state_reconciliation",
  "acknowledgement_admission",
] as const;

export type ObserverFailureCode = (typeof observerFailureCodes)[number];

export interface ExternalMonitorObserverFailureDiagnostic {
  readonly expectedTitleSha256?: string;
  readonly observedTitleSha256?: string;
  readonly observedTitleCandidateSha256s?: readonly string[];
  readonly observedStructureFlags?: readonly string[];
  readonly observedStageCounts?: ObservedStageCounts;
  readonly activeStageTitles?: readonly string[];
  readonly observedApplicationFieldCount?: number;
  readonly observedStructurePage?: string;
}

const diagnostics = new WeakMap<Error, ExternalMonitorObserverFailureDiagnostic>();

export function observerStage<T>(code: ObserverFailureCode, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (externalMonitorObserverFailureCode(error) !== undefined) throw error;
    throw new Error(`external monitor observer failed: ${code}`);
  }
}

export function observerFailure(
  code: ObserverFailureCode,
  diagnostic?: ExternalMonitorObserverFailureDiagnostic,
): never {
  const error = new Error(`external monitor observer failed: ${code}`);
  if (diagnostic !== undefined) diagnostics.set(error, diagnostic);
  throw error;
}

export function externalMonitorObserverFailureDiagnostic(
  error: unknown,
): ExternalMonitorObserverFailureDiagnostic | undefined {
  return error instanceof Error ? diagnostics.get(error) : undefined;
}

export function externalMonitorObserverFailureCode(
  error: unknown,
): ObserverFailureCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const prefix = "external monitor observer failed: ";
  if (!error.message.startsWith(prefix)) return undefined;
  const code = error.message.slice(prefix.length);
  return observerFailureCodes.find((candidate) => candidate === code);
}
