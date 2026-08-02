import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";

import {
  bootstrapS2GmailAuthorization,
  type GmailBootstrapOptions,
  type GmailBootstrapResult,
  type GmailGrantRevocationOptions,
  type GmailGrantRevocationResult,
  revokeS2GmailRefreshGrant,
} from "./s2-gmail-bootstrap.ts";

const MAX_INPUT_BYTES = 64 * 1024;
const SECRET_ENVIRONMENT = /^HUNT_.*(?:EMAIL|SENDER|PASSWORD|PASSWD|TOKEN|SECRET|CREDENTIAL|AUTHORIZATION)/iu;

export interface GmailBootstrapOperationContext extends GmailBootstrapOptions {}

export type GmailBootstrapOperation = (
  owner: unknown,
  bootstrap: unknown,
  context: GmailBootstrapOperationContext,
  signal: AbortSignal,
) => Promise<GmailBootstrapResult>;

export interface GmailBootstrapCliOptions {
  readonly forbiddenRoots: readonly string[];
  readonly operation?: GmailBootstrapOperation;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}

export type GmailGrantRevokeOperation = (
  owner: unknown,
  bootstrap: unknown,
  context: GmailGrantRevocationOptions,
  signal: AbortSignal,
) => Promise<GmailGrantRevocationResult>;

export interface GmailGrantRevokeCliOptions {
  readonly forbiddenRoots: readonly string[];
  readonly operation?: GmailGrantRevokeOperation;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}

export async function runS2GmailBootstrapCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  options: GmailBootstrapCliOptions,
): Promise<GmailBootstrapResult> {
  const loaded = await loadInvocation(arguments_, environment, options);
  if (loaded === null) return inputFailure();
  return (options.operation ?? bootstrapS2GmailAuthorization)(
    loaded.owner,
    loaded.bootstrap,
    loaded.context,
    options.signal ?? new AbortController().signal,
  );
}

export async function runS2GmailGrantRevokeCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  options: GmailGrantRevokeCliOptions,
): Promise<GmailGrantRevocationResult> {
  const loaded = await loadInvocation(arguments_, environment, options);
  if (loaded === null) return inputFailure();
  return (options.operation ?? revokeS2GmailRefreshGrant)(
    loaded.owner,
    loaded.bootstrap,
    loaded.context,
    options.signal ?? new AbortController().signal,
  );
}

async function loadInvocation(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  options: { readonly forbiddenRoots: readonly string[]; readonly now?: () => string },
): Promise<{
  readonly owner: unknown;
  readonly bootstrap: unknown;
  readonly context: GmailBootstrapOperationContext;
} | null> {
  if (Object.keys(environment).some((key) => SECRET_ENVIRONMENT.test(key))) {
    return null;
  }
  const paths = parseArguments(arguments_);
  if (paths === null || comparable(paths.owner) === comparable(paths.bootstrap)) {
    return null;
  }
  const [owner, bootstrap] = await Promise.all([
    loadExternalJson(paths.owner, options.forbiddenRoots),
    loadExternalJson(paths.bootstrap, options.forbiddenRoots),
  ]);
  if (owner === null || bootstrap === null) return null;
  const context: GmailBootstrapOperationContext = {
    now: (options.now ?? (() => new Date().toISOString()))(),
    ownerConfigPath: paths.owner,
    bootstrapInputPath: paths.bootstrap,
    forbiddenRoots: options.forbiddenRoots,
  };
  return { owner, bootstrap, context };
}

function parseArguments(arguments_: readonly string[]): {
  readonly owner: string;
  readonly bootstrap: string;
} | null {
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== "--config" ||
    arguments_[2] !== "--gmail-bootstrap" ||
    typeof arguments_[1] !== "string" ||
    typeof arguments_[3] !== "string" ||
    !exactAbsolute(arguments_[1]) ||
    !exactAbsolute(arguments_[3])
  ) return null;
  return { owner: arguments_[1], bootstrap: arguments_[3] };
}

async function loadExternalJson(
  path: string,
  forbiddenRoots: readonly string[],
): Promise<unknown | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAX_INPUT_BYTES) {
      return null;
    }
    const real = await realpath(path);
    if (comparable(real) !== comparable(resolve(path))) return null;
    for (const forbidden of forbiddenRoots) {
      if (within(await realpath(forbidden), real)) return null;
    }
    const bytes = await readFile(real);
    try {
      if (
        bytes.byteLength < 2 ||
        bytes.byteLength > MAX_INPUT_BYTES ||
        (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
      ) return null;
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
      bytes.fill(0);
    }
  } catch {
    return null;
  }
}

function exactAbsolute(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function comparable(path: string): string {
  const value = normalize(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function inputFailure(): {
  readonly ok: false;
  readonly error: { readonly code: "gmail_bootstrap_input_invalid" };
} {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: "gmail_bootstrap_input_invalid" }),
  });
}
