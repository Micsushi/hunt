import { spawnSync } from "node:child_process";

export interface IsolatedDesktopAttestationOptions {
  readonly expectedDesktop?: string;
  readonly inspect?: (expectedDesktop: string) => Promise<boolean>;
}

export async function assertCurrentProcessIsOnIsolatedDesktop(
  options: IsolatedDesktopAttestationOptions = {},
): Promise<void> {
  const expected = options.expectedDesktop ?? process.env.HUNT_C3_WINDOWS_DESKTOP_NAME;
  if (
    typeof expected !== "string" ||
    !/^HuntC3_[0-9a-f]{32}$/u.test(expected) ||
    !await (options.inspect ?? inspectInheritedDesktop)(expected)
  ) {
    throw new Error("isolated desktop attestation failed");
  }
}

async function inspectInheritedDesktop(expectedDesktop: string): Promise<boolean> {
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      windowsIsolatedDesktopAttestationScript(),
    ],
    {
      shell: false,
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 256,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        HUNT_C3_WINDOWS_DESKTOP_NAME: expectedDesktop,
      },
    },
  );
  return result.error === undefined &&
    result.signal === null &&
    result.status === 0 &&
    result.stdout.trim() === "ok";
}

export function windowsIsolatedDesktopAttestationScript(): string {
  return String.raw`
& {
$ErrorActionPreference = 'Stop'
$expected = $env:HUNT_C3_WINDOWS_DESKTOP_NAME
$env:HUNT_C3_WINDOWS_DESKTOP_NAME = $null
if ($expected -notmatch '^HuntC3_[0-9a-f]{32}$') { exit 51 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HuntC3DesktopAttestation
{
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool GetUserObjectInformation(IntPtr handle, int index, IntPtr value, uint length, out uint needed);

    public static bool Exact(string expected)
    {
        IntPtr desktop = GetThreadDesktop(GetCurrentThreadId());
        if (desktop == IntPtr.Zero) return false;
        uint needed;
        GetUserObjectInformation(desktop, 2, IntPtr.Zero, 0, out needed);
        if (needed < 2 || needed > 512) return false;
        IntPtr buffer = Marshal.AllocHGlobal((int)needed);
        try {
            if (!GetUserObjectInformation(desktop, 2, buffer, needed, out needed)) return false;
            string actual = Marshal.PtrToStringUni(buffer);
            return string.Equals(actual, expected, StringComparison.Ordinal);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
}
'@
if (-not [HuntC3DesktopAttestation]::Exact($expected)) { exit 52 }
'ok'
}
`.trim();
}
