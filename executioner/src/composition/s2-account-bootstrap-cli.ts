import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";

import {
  bootstrapS2AccountSecret,
  type AccountBootstrapResult,
} from "./s2-account-bootstrap.ts";

const MAX_CONFIG_BYTES = 64 * 1024;
const SECRET_ENVIRONMENT = /^HUNT_.*(?:EMAIL|PASSWORD|PASSWD|TOKEN|SECRET|CREDENTIAL|AUTHORIZATION)/iu;

export interface AccountBootstrapOperationContext {
  readonly now: string;
  readonly ownerConfigPath: string;
  readonly forbiddenRoots: readonly string[];
}

export type AccountBootstrapOperation = (
  value: unknown,
  context: AccountBootstrapOperationContext,
  signal: AbortSignal,
) => Promise<AccountBootstrapResult>;

export interface AccountBootstrapCliOptions {
  readonly forbiddenRoots: readonly string[];
  readonly operation?: AccountBootstrapOperation;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}

export async function runS2AccountBootstrapCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  options: AccountBootstrapCliOptions,
): Promise<AccountBootstrapResult | BootstrapInputFailure> {
  if (Object.keys(environment).some((key) => SECRET_ENVIRONMENT.test(key))) {
    return inputFailure();
  }
  const configPath = parseArguments(arguments_);
  if (configPath === null) return inputFailure();
  const value = await loadExternalConfig(configPath, options.forbiddenRoots);
  if (value === null) return inputFailure();
  const signal = options.signal ?? new AbortController().signal;
  return (options.operation ?? bootstrapS2AccountSecret)(value, {
    now: (options.now ?? (() => new Date().toISOString()))(),
    ownerConfigPath: configPath,
    forbiddenRoots: options.forbiddenRoots,
  }, signal);
}

type BootstrapInputFailure = {
  readonly ok: false;
  readonly error: { readonly code: "bootstrap_input_invalid" };
};

function parseArguments(arguments_: readonly string[]): string | null {
  return arguments_.length === 2 &&
      arguments_[0] === "--config" &&
      typeof arguments_[1] === "string" &&
      isAbsolute(arguments_[1]) &&
      normalize(arguments_[1]) === arguments_[1]
    ? arguments_[1]
    : null;
}

async function loadExternalConfig(
  path: string,
  forbiddenRoots: readonly string[],
): Promise<unknown | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAX_CONFIG_BYTES) {
      return null;
    }
    const real = await realpath(path);
    if (comparable(real) !== comparable(resolve(path))) return null;
    for (const forbidden of forbiddenRoots) {
      const boundary = await realpath(forbidden);
      if (within(boundary, real)) return null;
    }
    const bytes = await readFile(real);
    try {
      if (bytes.byteLength < 2 || bytes.byteLength > MAX_CONFIG_BYTES) return null;
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
      bytes.fill(0);
    }
  } catch {
    return null;
  }
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function comparable(path: string): string {
  const value = normalize(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function inputFailure(): BootstrapInputFailure {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: "bootstrap_input_invalid" }),
  });
}
