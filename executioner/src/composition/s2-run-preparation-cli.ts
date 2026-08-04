import { isAbsolute, normalize } from "node:path";

import { prepareStage2LiveRun } from "./s2-run-preparation.ts";

export interface Stage2RunPreparationArgs {
  readonly storageRoot: string;
  readonly targetUrl: string;
  readonly accountMode: "fresh_create" | "sign_in";
}

export function parseStage2RunPreparationArgs(
  values: readonly string[],
): Stage2RunPreparationArgs {
  if (values.length !== 6) invalid();
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (
      key === undefined || value === undefined || parsed.has(key) ||
      !["--storage-root", "--target-url", "--account-mode"].includes(key) ||
      /[\0\r\n"]/u.test(value)
    ) invalid();
    parsed.set(key, value);
  }
  const storageRoot = parsed.get("--storage-root");
  const targetUrl = parsed.get("--target-url");
  const accountMode = parsed.get("--account-mode");
  if (
    storageRoot === undefined || !isAbsolute(storageRoot) || normalize(storageRoot) !== storageRoot ||
    targetUrl === undefined ||
    (accountMode !== "fresh_create" && accountMode !== "sign_in")
  ) invalid();
  return Object.freeze({ storageRoot, targetUrl, accountMode });
}

export async function runStage2RunPreparationCli(values: readonly string[]) {
  return prepareStage2LiveRun(parseStage2RunPreparationArgs(values));
}

function invalid(): never {
  throw new TypeError("invalid Stage 2 run preparation arguments");
}
