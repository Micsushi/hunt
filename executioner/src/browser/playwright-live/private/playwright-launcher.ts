import {
  chromium,
  type BrowserContext,
} from "playwright";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  PersistentContext,
  PersistentContextLauncher,
} from "./types.ts";
import {
  minimizedSecondaryWindowForLiveTest,
  type VisibleSecondaryWindow,
} from "./windows-visible-secondary.ts";
import { assertCurrentProcessIsOnIsolatedDesktop } from "./windows-isolated-desktop-attestation.ts";

type PersistentLaunch = (
  profilePath: string,
  options: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>,
) => Promise<BrowserContext>;

type VisiblePersistentLaunch = (
  profilePath: string,
  window: VisibleSecondaryWindow,
) => Promise<BrowserContext>;

export interface PlaywrightPersistentContextLauncherOptions {
  readonly launch?: PersistentLaunch;
  readonly visibleLaunch?: VisiblePersistentLaunch;
  readonly visibleWindow?: () => VisibleSecondaryWindow | undefined;
  readonly isolatedDesktop?: () => Promise<void>;
}

export class PlaywrightPersistentContextLauncher
  implements PersistentContextLauncher
{
  readonly #launch: PersistentLaunch;
  readonly #visibleLaunch: VisiblePersistentLaunch;
  readonly #visibleWindow: () => VisibleSecondaryWindow | undefined;
  readonly #isolatedDesktop: () => Promise<void>;

  constructor(options: PlaywrightPersistentContextLauncherOptions = {}) {
    this.#launch = options.launch ?? ((profilePath, launchOptions) =>
      chromium.launchPersistentContext(profilePath, launchOptions));
    this.#visibleLaunch = options.visibleLaunch ?? ((profilePath, window) =>
      this.#launch(profilePath, visiblePersistentLaunchOptions(window)));
    this.#visibleWindow = options.visibleWindow ?? minimizedSecondaryWindowForLiveTest;
    this.#isolatedDesktop = options.isolatedDesktop ?? assertCurrentProcessIsOnIsolatedDesktop;
  }

  async launchPersistentContext(
    profilePath: string,
    options: { readonly headless: boolean },
  ): Promise<PersistentContext> {
    const visibleWindow = options.headless ? undefined : this.#visibleWindow();
    if (visibleWindow !== undefined) await this.#isolatedDesktop();
    await disablePasswordStorage(profilePath);
    const context = visibleWindow === undefined
      ? await this.#launch(profilePath, { headless: options.headless })
      : await this.#visibleLaunch(profilePath, visibleWindow);
    if (visibleWindow === undefined) return context;
    try {
      await verifyMinimizedSecondaryWindow(context, visibleWindow);
      return context;
    } catch (error) {
      await closeUnsafeWindowContext(context);
      throw error;
    }
  }
}

function visiblePersistentLaunchOptions(
  window: VisibleSecondaryWindow,
): NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]> {
  return {
    headless: false,
    viewport: null,
    args: [
      "--start-minimized",
      `--window-position=${window.x},${window.y}`,
      `--window-size=${window.width},${window.height}`,
    ],
  };
}

const preferencesByteLimit = 1_048_576;

async function disablePasswordStorage(profilePath: string): Promise<void> {
  const resolvedProfile = resolve(profilePath);
  const defaultPath = resolve(resolvedProfile, "Default");
  if (dirname(defaultPath) !== resolvedProfile) {
    throw new TypeError("invalid browser profile path");
  }
  await mkdir(defaultPath, { recursive: true, mode: 0o700 });
  for (const path of [resolvedProfile, defaultPath]) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new TypeError("invalid browser profile path");
    }
    if (comparable(await realpath(path)) !== comparable(path)) {
      throw new TypeError("invalid browser profile path");
    }
  }

  const preferencesPath = resolve(defaultPath, "Preferences");
  const partialPath = resolve(defaultPath, ".hunt-preferences.tmp");
  let preferences: Record<string, unknown> = {};
  try {
    const metadata = await lstat(preferencesPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (await stat(preferencesPath)).size > preferencesByteLimit
    ) throw new TypeError("invalid browser preferences");
    const parsed = JSON.parse(await readFile(preferencesPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new TypeError("invalid browser preferences");
    preferences = parsed;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const profile = isRecord(preferences.profile) ? preferences.profile : {};
  const serialized = JSON.stringify({
    ...preferences,
    credentials_enable_service: false,
    profile: {
      ...profile,
      password_manager_enabled: false,
    },
  });
  if (Buffer.byteLength(serialized, "utf8") > preferencesByteLimit) {
    throw new RangeError("browser preferences exceed bounded size");
  }
  await rm(partialPath, { force: true });
  await writeFile(partialPath, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(partialPath, preferencesPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function closeUnsafeWindowContext(context: BrowserContext): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await context.close();
      return;
    } catch {
      // One bounded retry handles a transient close race without hiding failure.
    }
  }
  throw new Error("live browser window safety cleanup failed");
}

export async function verifyMinimizedSecondaryWindow(
  context: Pick<BrowserContext, "pages" | "newPage" | "newCDPSession">,
  window: VisibleSecondaryWindow,
): Promise<void> {
  const page = context.pages()[0] ?? await context.newPage();
  const session = await context.newCDPSession(page);
  try {
    const { windowId } = await session.send("Browser.getWindowForTarget") as {
      readonly windowId: number;
    };
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
    const { bounds } = await session.send("Browser.getWindowBounds", {
      windowId,
    }) as {
      readonly bounds: {
        readonly left?: number;
        readonly top?: number;
        readonly width?: number;
        readonly height?: number;
        readonly windowState?: string;
      };
    };
    if (bounds.windowState !== "minimized") {
      throw new Error("live browser did not remain minimized");
    }
    const validBounds =
      !Number.isSafeInteger(bounds.left) ||
      !Number.isSafeInteger(bounds.top) ||
      !Number.isSafeInteger(bounds.width) ||
      !Number.isSafeInteger(bounds.height)
      ? false
      : bounds.width! >= 640 && bounds.height! >= 480;
    if (
      !validBounds ||
      (!withinWindow(bounds as Required<typeof bounds>, window) &&
        !withinDpiScaledWindow(bounds as Required<typeof bounds>, window))
    ) {
      throw new Error("live browser did not remain on the secondary monitor");
    }
  } finally {
    await session.detach();
  }
}

function withinWindow(
  bounds: Readonly<{ left: number; top: number; width: number; height: number }>,
  window: VisibleSecondaryWindow,
): boolean {
  return bounds.left >= window.x &&
    bounds.top >= window.y &&
    bounds.left + bounds.width <= window.x + window.width &&
    bounds.top + bounds.height <= window.y + window.height;
}

function withinDpiScaledWindow(
  bounds: Readonly<{ left: number; top: number; width: number; height: number }>,
  window: VisibleSecondaryWindow,
): boolean {
  const scale = bounds.width / window.width;
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 2) return false;
  const tolerance = 2;
  const expectedLeft = window.x * scale;
  const expectedTop = window.y * scale;
  const expectedRight = (window.x + window.width) * scale;
  const expectedBottom = (window.y + window.height) * scale;
  return bounds.left >= expectedLeft - tolerance &&
    bounds.top >= expectedTop - tolerance &&
    bounds.left + bounds.width <= expectedRight + tolerance &&
    bounds.top + bounds.height <= expectedBottom + tolerance;
}
