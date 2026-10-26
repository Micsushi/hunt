import { isAbsolute, normalize } from "node:path";

import {
  discardStage2RunStorage,
  finalizeStage2RunStorage,
  inventoryStage2RunStorage,
  prepareStage2RunStorage,
  readStage2StorageCatalog,
  rebuildStage2StorageCatalog,
  sweepExpiredStage2RetainedStorage,
} from "./private/s2-run-storage.ts";

export type Stage2StorageCliArgs =
  | { readonly command: "prepare"; readonly storageRoot: string }
  | {
      readonly command: "finalize" | "discard";
      readonly storageRoot: string;
      readonly ownerConfigPath: string;
      readonly evidenceRoot: string;
    }
  | {
      readonly command: "inventory" | "list" | "rebuild" | "sweep";
      readonly storageRoot: string;
    };

export function parseStage2StorageCliArgs(values: readonly string[]): Stage2StorageCliArgs {
  const command = values[0];
  if (!(["prepare", "finalize", "discard", "inventory", "list", "rebuild", "sweep"] as const).includes(command as never)) {
    return invalid();
  }
  const pairs = values.slice(1);
  if (pairs.length % 2 !== 0) return invalid();
  const parsed = new Map<string, string>();
  for (let index = 0; index < pairs.length; index += 2) {
    const key = pairs[index];
    const value = pairs[index + 1];
    if (
      key === undefined || value === undefined || parsed.has(key) ||
      !["--storage-root", "--config", "--evidence-root"].includes(key) ||
      !canonicalAbsolute(value)
    ) return invalid();
    parsed.set(key, value);
  }
  const storageRoot = parsed.get("--storage-root");
  if (storageRoot === undefined) return invalid();
  if (command === "finalize" || command === "discard") {
    if (parsed.size !== 3) return invalid();
    const ownerConfigPath = parsed.get("--config");
    const evidenceRoot = parsed.get("--evidence-root");
    if (ownerConfigPath === undefined || evidenceRoot === undefined) return invalid();
    return Object.freeze({ command, storageRoot, ownerConfigPath, evidenceRoot });
  }
  if (parsed.size !== 1) return invalid();
  return Object.freeze({
    command: command as "prepare" | "inventory" | "list" | "rebuild" | "sweep",
    storageRoot,
  });
}

export async function runStage2StorageCli(
  values: readonly string[],
  now = new Date().toISOString(),
): Promise<unknown> {
  const args = parseStage2StorageCliArgs(values);
  switch (args.command) {
    case "prepare":
      return prepareStage2RunStorage({ storageRoot: args.storageRoot });
    case "finalize":
      return finalizeStage2RunStorage({
        storageRoot: args.storageRoot,
        ownerConfigPath: args.ownerConfigPath,
        evidenceRoot: args.evidenceRoot,
      });
    case "discard":
      return discardStage2RunStorage({
        storageRoot: args.storageRoot,
        ownerConfigPath: args.ownerConfigPath,
        evidenceRoot: args.evidenceRoot,
      });
    case "list":
      return readStage2StorageCatalog(args.storageRoot);
    case "inventory":
      return inventoryStage2RunStorage(args.storageRoot);
    case "rebuild":
      return rebuildStage2StorageCatalog(args.storageRoot);
    case "sweep":
      return sweepExpiredStage2RetainedStorage({ storageRoot: args.storageRoot, now });
  }
}

function canonicalAbsolute(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value && !/[\0\r\n"]/u.test(value);
}

function invalid(): never {
  throw new TypeError("invalid Stage 2 storage arguments");
}
