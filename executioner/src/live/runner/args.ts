import { isAbsolute, normalize } from "node:path";

export interface Stage2AccountAccessArgs {
  readonly configPath: string;
  readonly evidenceRoot: string;
}

export function parseStage2AccountAccessArgs(
  values: readonly string[],
): Stage2AccountAccessArgs {
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
  if (
    configPath === undefined ||
    evidenceRoot === undefined ||
    parsed.get("--stop-after") !== "account_access" ||
    !canonicalAbsolute(configPath) ||
    !canonicalAbsolute(evidenceRoot)
  ) invalid();
  return Object.freeze({ configPath, evidenceRoot });
}

function canonicalAbsolute(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value;
}

function invalid(): never {
  throw new TypeError("invalid Stage 2 arguments");
}
