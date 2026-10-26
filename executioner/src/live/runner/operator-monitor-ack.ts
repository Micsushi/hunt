import { isAbsolute, normalize } from "node:path";

export type OperatorMonitorAckClassification =
  | "application_ready"
  | "posting_unavailable"
  | "maintenance"
  | "runtime_error"
  | "account_entry"
  | "verification_required"
  | "manual_action_required"
  | "unknown";

export interface OperatorMonitorAckArgs {
  readonly evidenceRoot: string;
  readonly monitorRequestPath: string;
  readonly classification: OperatorMonitorAckClassification;
}

export interface ExternalMonitorAckArgs {
  readonly runtimeRoot: string;
  readonly evidenceRoot: string;
  readonly monitorRequestPath: string;
  readonly classification: "safe_to_continue" | "account_verified" | "review_verified";
  readonly observationPath: string;
}

const classifications: readonly string[] = [
  "application_ready",
  "posting_unavailable",
  "maintenance",
  "runtime_error",
  "account_entry",
  "verification_required",
  "manual_action_required",
  "unknown",
];

export function parseOperatorMonitorAckArgs(
  values: readonly string[],
): OperatorMonitorAckArgs {
  if (values.length !== 6) invalid();
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !["--evidence-root", "--monitor-request", "--classification"].includes(name) ||
      parsed.has(name)
    ) invalid();
    parsed.set(name, value);
  }
  const evidenceRoot = parsed.get("--evidence-root");
  const monitorRequestPath = parsed.get("--monitor-request");
  const classification = parsed.get("--classification");
  if (
    evidenceRoot === undefined ||
    monitorRequestPath === undefined ||
    classification === undefined ||
    !isAbsolute(evidenceRoot) ||
    normalize(evidenceRoot) !== evidenceRoot ||
    !isAbsolute(monitorRequestPath) ||
    normalize(monitorRequestPath) !== monitorRequestPath ||
    !classifications.includes(classification)
  ) invalid();
  return Object.freeze({
    evidenceRoot,
    monitorRequestPath,
    classification: classification as OperatorMonitorAckClassification,
  });
}

export function parseExternalMonitorAckArgs(
  values: readonly string[],
): ExternalMonitorAckArgs {
  if (values.length !== 10) invalid();
  const names = [
    "--runtime-root", "--evidence-root", "--monitor-request",
    "--classification", "--observation",
  ] as const;
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (name === undefined || value === undefined ||
        !names.includes(name as typeof names[number]) || parsed.has(name)) invalid();
    parsed.set(name, value);
  }
  const runtimeRoot = absolute(parsed.get("--runtime-root"));
  const evidenceRoot = absolute(parsed.get("--evidence-root"));
  const monitorRequestPath = absolute(parsed.get("--monitor-request"));
  const observationPath = absolute(parsed.get("--observation"));
  const classification = parsed.get("--classification");
  if (classification === undefined ||
      !["safe_to_continue", "account_verified", "review_verified"].includes(classification)) {
    invalid();
  }
  return Object.freeze({
    runtimeRoot,
    evidenceRoot,
    monitorRequestPath,
    classification: classification as ExternalMonitorAckArgs["classification"],
    observationPath,
  });
}

function absolute(value: string | undefined): string {
  if (value === undefined || !isAbsolute(value) || normalize(value) !== value) invalid();
  return value;
}

function invalid(): never {
  throw new TypeError("monitor acknowledgement arguments invalid");
}
