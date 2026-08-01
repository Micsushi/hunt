import { spawnSync } from "node:child_process";

export interface WindowsScreenWorkArea {
  readonly primary: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface VisibleSecondaryWindow {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
const MARGIN = 40;
const DESIRED_WIDTH = 1400;
const DESIRED_HEIGHT = 1000;

export function selectVisibleSecondaryWindow(
  screens: readonly WindowsScreenWorkArea[],
): VisibleSecondaryWindow {
  const secondary = screens
    .filter((screen) => !screen.primary)
    .sort((left, right) => right.x - left.x)[0];
  if (secondary === undefined) {
    throw new Error("visible inspection requires a secondary monitor");
  }
  if (
    ![secondary.x, secondary.y, secondary.width, secondary.height].every(Number.isSafeInteger) ||
    secondary.width < MIN_WIDTH + MARGIN * 2 ||
    secondary.height < MIN_HEIGHT + MARGIN * 2
  ) {
    throw new Error("invalid secondary monitor geometry");
  }
  return Object.freeze({
    x: secondary.x + MARGIN,
    y: secondary.y + MARGIN,
    width: Math.min(DESIRED_WIDTH, secondary.width - MARGIN * 2),
    height: Math.min(DESIRED_HEIGHT, secondary.height - MARGIN * 2),
  });
}

export function visibleSecondaryWindowFromEnvironment(): VisibleSecondaryWindow | undefined {
  if (!enabled(process.env.HUNT_C3_VISIBLE_SECONDARY_INSPECTION)) return undefined;
  if (process.platform !== "win32") {
    throw new Error("visible secondary inspection is Windows-only");
  }
  const script = windowsScreenDiscoveryScript();
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      shell: false,
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    result.stdout.length === 0 ||
    result.stdout.length > 16 * 1024
  ) {
    throw new Error("secondary monitor discovery failed");
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  const screens = Array.isArray(parsed) ? parsed : [parsed];
  if (!screens.every(isScreenWorkArea)) {
    throw new Error("secondary monitor discovery returned invalid geometry");
  }
  return selectVisibleSecondaryWindow(screens);
}

export function windowsScreenDiscoveryScript(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HuntDpiAwareness {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
}
'@
$previousDpiContext = [HuntDpiAwareness]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
if ($previousDpiContext -eq [IntPtr]::Zero) {
  throw 'could not enable per-monitor DPI awareness'
}
Add-Type -AssemblyName System.Windows.Forms
@([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{
    primary = $_.Primary
    x = $_.WorkingArea.X
    y = $_.WorkingArea.Y
    width = $_.WorkingArea.Width
    height = $_.WorkingArea.Height
  }
}) | ConvertTo-Json -Compress
`;
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "TRUE";
}

function isScreenWorkArea(value: unknown): value is WindowsScreenWorkArea {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.primary === "boolean" &&
    [candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isSafeInteger);
}
