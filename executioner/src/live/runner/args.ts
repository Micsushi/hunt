import { isAbsolute, normalize } from "node:path";

export type Stage2AcceptanceCheckpoint =
  | "account_access"
  | "mailbox_candidate"
  | "account_verified";

export interface Stage2AcceptanceArgs {
  readonly checkpoint: Stage2AcceptanceCheckpoint;
  readonly configPath: string;
  readonly evidenceRoot: string;
}

export function parseStage2AcceptanceArgs(
  values: readonly string[],
): Stage2AcceptanceArgs {
  if (values.length !== 6) invalid();
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !["--config", "--stop-after", "--evidence-root"].includes(name) ||
      parsed.has(name)
    ) invalid();
    parsed.set(name, value);
  }
  const configPath = parsed.get("--config");
  const evidenceRoot = parsed.get("--evidence-root");
  const checkpoint = parsed.get("--stop-after");
  if (
    configPath === undefined ||
    evidenceRoot === undefined ||
    (checkpoint !== "account_access" &&
      checkpoint !== "mailbox_candidate" &&
      checkpoint !== "account_verified") ||
    !canonicalAbsolute(configPath) ||
    !canonicalAbsolute(evidenceRoot)
  ) invalid();
  return Object.freeze({ checkpoint, configPath, evidenceRoot });
}

function canonicalAbsolute(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value;
}

function invalid(): never {
  throw new TypeError("invalid Stage 2 arguments");
}
