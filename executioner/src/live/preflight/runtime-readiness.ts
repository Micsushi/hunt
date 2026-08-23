import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";

export type RuntimeReadinessCode =
  | "ready"
  | "runtime_mismatch"
  | "missing_dependency"
  | "missing_browser"
  | "launch_failure"
  | "evidence_failure";

export interface RuntimeHeadroom {
  readonly availablePhysicalBytes: number;
  readonly commitHeadroomBytes: number;
}

export interface RuntimeReadinessReport {
  readonly schemaVersion: 1;
  readonly kind: "s2_runtime_readiness";
  readonly status: "ready" | "failed";
  readonly code: RuntimeReadinessCode;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly playwrightVersion?: string;
  readonly browserVersion?: string;
  readonly headroom: {
    readonly availablePhysicalGiB: number;
    readonly commitHeadroomGiB: number;
    readonly effectiveGiB: number;
    readonly low: boolean;
  };
  readonly cleanup: {
    readonly profileRemoved: boolean;
    readonly browserProcessExited: boolean;
  };
}

interface CdpSession {
  send(method: string): Promise<unknown>;
  detach(): Promise<void>;
}

interface BrowserPage {
  goto(url: string): Promise<unknown>;
  title(): Promise<string>;
}

interface BrowserContext {
  pages(): readonly BrowserPage[];
  newPage(): Promise<BrowserPage>;
  browser(): { version(): string; newBrowserCDPSession(): Promise<CdpSession> } | null;
  close(): Promise<void>;
}

interface PlaywrightRuntime {
  readonly version: string;
  readonly chromium: {
    executablePath(): string;
    launchPersistentContext(
      profilePath: string,
      options: { readonly headless: true; readonly timeout: number; readonly args: readonly string[] },
    ): Promise<BrowserContext>;
  };
}

export interface RuntimeReadinessOptions {
  readonly nodeVersion?: string;
  readonly npmVersion?: string;
  readonly pairedNodePath?: string;
  readonly nodePath?: string;
  readonly headroom?: RuntimeHeadroom;
  readonly profilePath?: string;
  readonly loadPlaywright?: () => Promise<PlaywrightRuntime>;
  readonly pathExists?: (path: string) => boolean;
  readonly removeProfile?: (path: string) => Promise<void>;
}

const GIB = 1024 ** 3;
const LOW_HEADROOM_BYTES = 8 * GIB;
const EVIDENCE_TITLE = "hunt-c3-runtime-ready";
export const STAGE2_NODE_VERSION = "22.23.2";
export const STAGE2_NPM_VERSION = "10.9.8";

export async function verifyStage2RuntimeReadiness(
  options: RuntimeReadinessOptions = {},
): Promise<RuntimeReadinessReport> {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const npmVersion = options.npmVersion ?? process.env.HUNT_C3_NPM_VERSION ?? "unknown";
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const pairedNodePath = options.pairedNodePath ?? process.env.HUNT_C3_NPM_NODE_EXE;
  const headroom = normalizedHeadroom(options.headroom ?? headroomFromEnvironment());
  const base = (code: RuntimeReadinessCode) => reportBase(
    code,
    nodeVersion,
    npmVersion,
    headroom,
  );
  if (
    nodeVersion !== STAGE2_NODE_VERSION ||
    npmVersion !== STAGE2_NPM_VERSION ||
    pairedNodePath === undefined ||
    comparable(resolve(pairedNodePath)) !== comparable(nodePath)
  ) {
    return base("runtime_mismatch");
  }

  let runtime: PlaywrightRuntime;
  try {
    runtime = await (options.loadPlaywright ?? loadPlaywright)();
  } catch {
    return base("missing_dependency");
  }

  const pathExists = options.pathExists ?? existsSync;
  let executablePath: string;
  try {
    executablePath = runtime.chromium.executablePath();
  } catch {
    return { ...base("missing_browser"), playwrightVersion: runtime.version };
  }
  if (!pathExists(executablePath)) {
    return { ...base("missing_browser"), playwrightVersion: runtime.version };
  }

  let profilePath: string;
  try {
    profilePath = options.profilePath === undefined
      ? await mkdtemp(join(tmpdir(), "hunt-c3-readiness-"))
      : admittedProfilePath(options.profilePath);
  } catch {
    return { ...base("evidence_failure"), playwrightVersion: runtime.version };
  }
  const removeProfile = options.removeProfile ?? removeReadinessProfile;
  let context: BrowserContext | undefined;
  let browserVersion: string | undefined;
  let browserPid: number | undefined;
  let launchFailed = false;
  let evidencePassed = false;
  let cleanupPassed = false;
  try {
    try {
      context = await runtime.chromium.launchPersistentContext(profilePath, {
        headless: true,
        timeout: 30_000,
        args: ["--disable-background-networking"],
      });
    } catch {
      launchFailed = true;
    }
    if (!launchFailed && context !== undefined) {
      const browser = context.browser();
      browserVersion = browser?.version();
      if (browser !== null) {
        const session = await browser.newBrowserCDPSession();
        try {
          const result = await session.send("SystemInfo.getProcessInfo") as {
            readonly processInfo?: readonly { readonly type?: unknown; readonly id?: unknown }[];
          };
          const process = result.processInfo?.find((candidate) => candidate.type === "browser");
          if (Number.isSafeInteger(process?.id) && (process?.id as number) > 0) {
            browserPid = process!.id as number;
          }
        } finally {
          await session.detach();
        }
      }
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(`data:text/html,<title>${EVIDENCE_TITLE}</title>`);
      evidencePassed = await page.title() === EVIDENCE_TITLE &&
        typeof browserVersion === "string" && browserVersion.length > 0;
    }
  } catch {
    evidencePassed = false;
  } finally {
    try {
      await context?.close();
    } catch {
      evidencePassed = false;
    }
    try {
      await removeProfile(profilePath);
      cleanupPassed = !pathExists(profilePath);
    } catch {
      cleanupPassed = false;
    }
  }

  const browserProcessExited = browserPid === undefined
    ? false
    : await waitForProcessExit(browserPid);

  const code = launchFailed
    ? "launch_failure"
    : evidencePassed && cleanupPassed && browserProcessExited
    ? "ready"
    : "evidence_failure";
  return {
    ...base(code),
    playwrightVersion: runtime.version,
    ...(browserVersion === undefined ? {} : { browserVersion }),
    cleanup: { profileRemoved: cleanupPassed, browserProcessExited },
  };
}

async function loadPlaywright(): Promise<PlaywrightRuntime> {
  const [{ chromium }, manifest] = await Promise.all([
    import("playwright"),
    import("playwright/package.json", { with: { type: "json" } }),
  ]);
  const version = (manifest.default as { readonly version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new TypeError("Playwright package version unavailable");
  }
  return { version, chromium } as unknown as PlaywrightRuntime;
}

function admittedProfilePath(value: string): string {
  const resolved = resolve(value);
  const tempRoot = resolve(tmpdir());
  const relative = resolved.slice(tempRoot.length + 1);
  if (
    comparable(resolved).startsWith(`${comparable(tempRoot)}\\`) &&
    /^hunt-c3-readiness-[A-Za-z0-9-]{8,80}$/u.test(relative) &&
    normalize(value) === value
  ) return resolved;
  throw new TypeError("invalid readiness profile path");
}

async function removeReadinessProfile(path: string): Promise<void> {
  admittedProfilePath(path);
  await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
}

function headroomFromEnvironment(): RuntimeHeadroom {
  return {
    availablePhysicalBytes: Number(process.env.HUNT_C3_AVAILABLE_PHYSICAL_BYTES),
    commitHeadroomBytes: Number(process.env.HUNT_C3_COMMIT_HEADROOM_BYTES),
  };
}

function normalizedHeadroom(value: RuntimeHeadroom): RuntimeHeadroom {
  if (
    !Number.isFinite(value.availablePhysicalBytes) || value.availablePhysicalBytes < 0 ||
    !Number.isFinite(value.commitHeadroomBytes) || value.commitHeadroomBytes < 0
  ) {
    return { availablePhysicalBytes: 0, commitHeadroomBytes: 0 };
  }
  return value;
}

function reportBase(
  code: RuntimeReadinessCode,
  nodeVersion: string,
  npmVersion: string,
  headroom: RuntimeHeadroom,
): RuntimeReadinessReport {
  const effective = Math.min(headroom.availablePhysicalBytes, headroom.commitHeadroomBytes);
  const toGiB = (value: number) => Math.round(value / GIB * 100) / 100;
  return {
    schemaVersion: 1,
    kind: "s2_runtime_readiness",
    status: code === "ready" ? "ready" : "failed",
    code,
    nodeVersion,
    npmVersion,
    headroom: {
      availablePhysicalGiB: toGiB(headroom.availablePhysicalBytes),
      commitHeadroomGiB: toGiB(headroom.commitHeadroomBytes),
      effectiveGiB: toGiB(effective),
      low: effective < LOW_HEADROOM_BYTES,
    },
    cleanup: { profileRemoved: false, browserProcessExited: false },
  };
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

function comparable(value: string): string {
  return process.platform === "win32" ? normalize(value).toLowerCase() : normalize(value);
}
