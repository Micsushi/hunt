import { isAbsolute, normalize } from "node:path";

export type OperatorMonitorAckClassification =
  | "application_ready"
  | "posting_unavailable"
  | "maintenance"
  | "account_entry"
  | "verification_required"
  | "manual_action_required"
  | "unknown";

export interface OperatorMonitorAckArgs {
  readonly evidenceRoot: string;
  readonly classification: OperatorMonitorAckClassification;
}

const classifications: readonly string[] = [
  "application_ready",
  "posting_unavailable",
  "maintenance",
  "account_entry",
  "verification_required",
  "manual_action_required",
  "unknown",
];

export function parseOperatorMonitorAckArgs(
  values: readonly string[],
): OperatorMonitorAckArgs {
  if (values.length !== 4) invalid();
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !["--evidence-root", "--classification"].includes(name) ||
      parsed.has(name)
    ) invalid();
    parsed.set(name, value);
  }
  const evidenceRoot = parsed.get("--evidence-root");
  const classification = parsed.get("--classification");
  if (
    evidenceRoot === undefined ||
    classification === undefined ||
    !isAbsolute(evidenceRoot) ||
    normalize(evidenceRoot) !== evidenceRoot ||
    !classifications.includes(classification)
  ) invalid();
  return Object.freeze({
    evidenceRoot,
    classification: classification as OperatorMonitorAckClassification,
  });
}

function invalid(): never {
  throw new TypeError("monitor acknowledgement arguments invalid");
}
